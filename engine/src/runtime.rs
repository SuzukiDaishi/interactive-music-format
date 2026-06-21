//! IAM runtime: transport, section players, mixer, transition scheduler,
//! RTPC store and cue dispatch.
//!
//! Rendering is boundary-driven: each `process()` call is split into chunks
//! that end exactly on the next musical boundary (beat/bar line, anchor,
//! scheduled transition, section end), so transitions are sample-accurate
//! even at non-1.0 or negative playback rates.

use crate::pack::{Action, Pack, Timing, Trigger, NONE_ID};
use crate::vm;
use std::collections::VecDeque;

const EPS: f64 = 1e-6;
const MAX_CHUNK: usize = 256;
const MAX_EVENTS: usize = 256;
const MAX_MIDI: usize = 512;
const MAX_CUE_DEPTH: u32 = 8;
const MAX_PLAYERS: usize = 8;
const MAX_ONESHOTS: usize = 16;

// MIDI event status bytes (see docs/06_wclap_midi_bridges.md)
pub const MIDI_NOTE_OFF: u8 = 0;
pub const MIDI_NOTE_ON: u8 = 1;
pub const MIDI_ALL_NOTES_OFF: u8 = 2;

/// A sample-accurate MIDI event routed to a plugin instance. `frame_offset` is
/// the sample offset within the current process() block. For AllNotesOff,
/// `instance` is NONE_ID (broadcast to every instrument).
#[derive(Clone, Copy)]
pub struct MidiEvt {
    pub instance: u32,
    pub frame_offset: u32,
    pub status: u8,
    pub key: u8,
    pub channel: u8,
    pub velocity: f32,
}

// Event types (see docs/04_host_api_spec.md)
pub const EV_SECTION_CHANGED: u32 = 1;
pub const EV_CUE_FIRED: u32 = 2;
pub const EV_GOTO_SCHEDULED: u32 = 3;
pub const EV_EMIT: u32 = 4;
pub const EV_ENDED: u32 = 5;
pub const EV_LOOPED: u32 = 6;
pub const EV_ONESHOT: u32 = 7;
pub const EV_RTPC_CHANGED: u32 = 8;

#[derive(Clone, Copy)]
pub struct Event {
    pub ty: u32,
    pub a: u32,
    pub b: u32,
    pub c: f32,
}

/// Per-section data derived at load time (bank-sample domain).
struct SecDerived {
    samples_per_beat: f64,
    length_samples: f64,
    loop_start_samples: f64,
    beats_per_bar: f64,
    /// (anchor_id, position_samples), sorted by position.
    anchors: Vec<(u32, f64)>,
    /// Per track: per item (start, length, offset, fade_in, fade_out) in samples.
    items: Vec<Vec<ItemDerived>>,
    /// Note on/off events (bank samples) for instrument tracks, sorted by pos.
    notes: Vec<NoteEvt>,
}

#[derive(Clone, Copy)]
struct NoteEvt {
    pos: f64,
    instance: u32,
    status: u8,
    key: u8,
    channel: u8,
    velocity: f32,
}

#[derive(Clone, Copy)]
struct ItemDerived {
    asset_idx: usize,
    start: f64,
    length: f64,
    offset: f64,
    fade_in: f64,
    fade_out: f64,
    gain: f32,
}

#[derive(Clone, Copy)]
struct Smoothed {
    value: f32,
    target: f32,
    /// Absolute change per output frame (0 = snap on next advance).
    step: f32,
}

impl Smoothed {
    fn new(v: f32) -> Self {
        Smoothed {
            value: v,
            target: v,
            step: 0.0,
        }
    }

    fn set(&mut self, target: f32, fade_ms: f32, out_sr: f64) {
        self.target = target;
        if fade_ms <= 0.0 {
            self.value = target;
            self.step = 0.0;
        } else {
            let frames = (fade_ms as f64 / 1000.0 * out_sr).max(1.0);
            self.step = ((target - self.value).abs() as f64 / frames) as f32;
        }
    }

    fn advance(&mut self, frames: usize) {
        if self.value == self.target {
            return;
        }
        let delta = self.step * frames as f32;
        if self.step <= 0.0 || (self.target - self.value).abs() <= delta {
            self.value = self.target;
        } else if self.target > self.value {
            self.value += delta;
        } else {
            self.value -= delta;
        }
    }

    /// Value `f` frames into the current chunk (for per-frame ramping).
    #[inline]
    fn at(&self, f: usize) -> f32 {
        if self.value == self.target || self.step <= 0.0 {
            return self.value;
        }
        let d = self.step * f as f32;
        if self.target > self.value {
            (self.value + d).min(self.target)
        } else {
            (self.value - d).max(self.target)
        }
    }
}

struct Player {
    section: usize,
    /// Position on the section timeline, in bank samples.
    pos: f64,
    fade: Smoothed,
    /// Fading out; removed when gain reaches 0.
    dying: bool,
    /// First chunk after spawn: boundaries exactly at `pos` fire too.
    fresh: bool,
}

struct OneShot {
    asset_idx: usize,
    /// Position in asset frames.
    pos: f64,
    gain: f32,
}

/// The real destination of a bridged transition, played once the bridge
/// section reaches its end.
struct GotoThen {
    section: usize,
    start_pos: f64,
    crossfade: bool,
    fade_ms: f32,
}

enum PendingKind {
    Goto {
        section: usize,
        start_pos: f64,
        crossfade: bool,
        fade_ms: f32,
        /// When set, `section` is a one-shot bridge and `then` is the real
        /// destination scheduled at the bridge's section end.
        then: Option<GotoThen>,
    },
    Stop {
        fade_ms: f32,
    },
}

struct Pending {
    kind: PendingKind,
    /// Main-player position (bank samples) at which this fires.
    at: f64,
}

struct PendingOneShot {
    asset_idx: usize,
    gain: f32,
    at: f64,
}

struct RtpcState {
    smooth: Smoothed,
    smoothing_ms: f32,
    min: f32,
    max: f32,
}

pub struct Runtime {
    pack: Pack,
    sec: Vec<SecDerived>,
    out_sr: f64,
    out_ch: usize,
    rate: f32,
    playing: bool,
    paused: bool,
    players: Vec<Player>,
    main: Option<usize>,
    oneshots: Vec<OneShot>,
    pending: Option<Pending>,
    pending_oneshots: Vec<PendingOneShot>,
    rtpc: Vec<RtpcState>,
    track_gains: Vec<Vec<Smoothed>>,
    loop_flags: Vec<bool>,
    events: VecDeque<Event>,
    midi: VecDeque<MidiEvt>,
    /// Output frame index reached within the current process() block.
    block_frame: usize,
    rng: u64,
    cue_depth: u32,
}

fn sec_index(pack: &Pack, id: u32) -> Option<usize> {
    pack.sections.iter().position(|s| s.id == id)
}

impl Runtime {
    pub fn new(pack: Pack, out_sr: u32, out_ch: u32) -> Runtime {
        let out_ch = if out_ch == 1 { 1 } else { 2 };
        let bank_sr = pack.bank_sample_rate as f64;
        let mut sec = Vec::with_capacity(pack.sections.len());
        for s in &pack.sections {
            let bpm = if s.bpm > 0.0 { s.bpm } else { pack.bpm } as f64;
            let spb = bank_sr * 60.0 / bpm;
            let tsig_num = if s.tsig_num > 0 { s.tsig_num } else { pack.tsig_num };
            let mut anchors: Vec<(u32, f64)> = s
                .anchors
                .iter()
                .map(|a| (a.id, a.beat as f64 * spb))
                .collect();
            anchors.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap());
            let items = s
                .tracks
                .iter()
                .map(|t| {
                    t.items
                        .iter()
                        .filter_map(|i| {
                            let asset_idx =
                                pack.assets.iter().position(|a| a.id == i.asset_id)?;
                            Some(ItemDerived {
                                asset_idx,
                                start: i.start_beat as f64 * spb,
                                length: i.length_beats as f64 * spb,
                                offset: i.offset_beats as f64 * spb,
                                fade_in: i.fade_in_beats as f64 * spb,
                                fade_out: i.fade_out_beats as f64 * spb,
                                gain: i.gain,
                            })
                        })
                        .collect()
                })
                .collect();
            let mut notes: Vec<NoteEvt> = Vec::new();
            for t in &s.tracks {
                if t.kind != 1 || t.instrument == NONE_ID {
                    continue;
                }
                for n in &t.notes {
                    let on = n.start_beat as f64 * spb;
                    let off = (n.start_beat + n.length_beats) as f64 * spb;
                    notes.push(NoteEvt {
                        pos: on,
                        instance: t.instrument,
                        status: MIDI_NOTE_ON,
                        key: n.key,
                        channel: n.channel,
                        velocity: n.velocity,
                    });
                    notes.push(NoteEvt {
                        pos: off,
                        instance: t.instrument,
                        status: MIDI_NOTE_OFF,
                        key: n.key,
                        channel: n.channel,
                        velocity: 0.0,
                    });
                }
            }
            notes.sort_by(|a, b| a.pos.partial_cmp(&b.pos).unwrap());
            sec.push(SecDerived {
                samples_per_beat: spb,
                length_samples: s.length_beats as f64 * spb,
                loop_start_samples: s.loop_start_beats as f64 * spb,
                beats_per_bar: tsig_num.max(1) as f64,
                anchors,
                items,
                notes,
            });
        }

        let rtpc = pack
            .rtpcs
            .iter()
            .map(|r| RtpcState {
                smooth: Smoothed::new(r.default),
                smoothing_ms: r.smoothing_ms,
                min: r.min,
                max: r.max,
            })
            .collect();
        let track_gains = pack
            .sections
            .iter()
            .map(|s| s.tracks.iter().map(|_| Smoothed::new(1.0)).collect())
            .collect();
        let loop_flags = pack.sections.iter().map(|s| s.loop_enabled).collect();

        Runtime {
            pack,
            sec,
            out_sr: out_sr.max(1) as f64,
            out_ch: out_ch as usize,
            rate: 1.0,
            playing: false,
            paused: false,
            players: Vec::new(),
            main: None,
            oneshots: Vec::new(),
            pending: None,
            pending_oneshots: Vec::new(),
            rtpc,
            track_gains,
            loop_flags,
            events: VecDeque::new(),
            midi: VecDeque::new(),
            block_frame: 0,
            rng: 0x853c_49e6_748f_ea9b,
            cue_depth: 0,
        }
    }

    // -- events ------------------------------------------------------------

    fn push_event(&mut self, ty: u32, a: u32, b: u32, c: f32) {
        if self.events.len() < MAX_EVENTS {
            self.events.push_back(Event { ty, a, b, c });
        }
    }

    pub fn poll_event(&mut self) -> Option<Event> {
        self.events.pop_front()
    }

    fn push_midi(&mut self, e: MidiEvt) {
        if self.midi.len() < MAX_MIDI {
            self.midi.push_back(e);
        }
    }

    /// Broadcast an all-notes-off to every instrument at the current frame, used
    /// when the music cuts away so synth voices do not hang.
    fn push_all_notes_off(&mut self) {
        let fo = self.block_frame as u32;
        self.push_midi(MidiEvt {
            instance: NONE_ID,
            frame_offset: fo,
            status: MIDI_ALL_NOTES_OFF,
            key: 0,
            channel: 0,
            velocity: 0.0,
        });
    }

    pub fn poll_midi(&mut self) -> Option<MidiEvt> {
        self.midi.pop_front()
    }

    fn rand01(&mut self) -> f32 {
        // xorshift64*
        let mut x = self.rng;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.rng = x;
        let v = (x.wrapping_mul(0x2545_F491_4F6C_DD1D) >> 40) as u32;
        v as f32 / 16_777_216.0
    }

    pub fn set_seed(&mut self, seed: u32) {
        self.rng = (seed as u64) | 0x9E37_79B9_0000_0001;
    }

    // -- transport control (host API) ---------------------------------------

    pub fn play(&mut self) {
        if self.playing && self.main.is_some() {
            return;
        }
        self.playing = true;
        self.paused = false;
        if self.main.is_none() {
            if let Some(idx) = sec_index(&self.pack, self.pack.start_section) {
                self.spawn_main(idx, 0.0, false, 0.0, NONE_ID);
            }
        }
        self.fire_trigger(TriggerMatch::ModuleStart);
    }

    pub fn play_section(&mut self, section_id: u32, anchor_id: u32) {
        let Some(idx) = sec_index(&self.pack, section_id) else {
            return;
        };
        let pos = self.anchor_pos(idx, anchor_id);
        self.playing = true;
        self.paused = false;
        self.pending = None;
        for p in &mut self.players {
            p.dying = true;
            p.fade.set(0.0, 0.0, self.out_sr);
        }
        self.reap_players();
        self.push_all_notes_off();
        self.spawn_main(idx, pos, false, 0.0, NONE_ID);
    }

    pub fn stop(&mut self, fade_ms: f32) {
        self.pending = None;
        self.pending_oneshots.clear();
        self.push_all_notes_off();
        for p in &mut self.players {
            p.dying = true;
            p.fade.set(0.0, fade_ms, self.out_sr);
        }
        self.main = None;
        if fade_ms <= 0.0 {
            self.players.clear();
            self.oneshots.clear();
            if self.playing {
                self.playing = false;
                self.push_event(EV_ENDED, 0, 0, 0.0);
            }
        }
        // When fading, EV_ENDED fires once all players are gone (see reap).
    }

    pub fn pause(&mut self) {
        self.paused = true;
    }

    pub fn resume(&mut self) {
        self.paused = false;
    }

    pub fn is_playing(&self) -> bool {
        self.playing && !self.paused
    }

    pub fn is_stereo(&self) -> bool {
        self.out_ch == 2
    }

    pub fn set_rate(&mut self, rate: f32) {
        self.rate = rate.clamp(-4.0, 4.0);
    }

    pub fn rate(&self) -> f32 {
        self.rate
    }

    pub fn seek_beats(&mut self, beats: f32) {
        if let Some(mi) = self.main {
            let s = self.players[mi].section;
            let pos = (beats as f64 * self.sec[s].samples_per_beat)
                .clamp(0.0, self.sec[s].length_samples);
            self.players[mi].pos = pos;
            self.players[mi].fresh = true;
            self.pending = None;
        }
    }

    pub fn current_section(&self) -> u32 {
        self.main
            .map(|i| self.pack.sections[self.players[i].section].id)
            .unwrap_or(NONE_ID)
    }

    pub fn position_beats(&self) -> f32 {
        self.main
            .map(|i| {
                let p = &self.players[i];
                (p.pos / self.sec[p.section].samples_per_beat) as f32
            })
            .unwrap_or(0.0)
    }

    pub fn position_samples(&self) -> f64 {
        self.main.map(|i| self.players[i].pos).unwrap_or(0.0)
    }

    // -- RTPC ----------------------------------------------------------------

    pub fn set_rtpc(&mut self, id: u32, value: f32) {
        let Some(idx) = self.pack.rtpcs.iter().position(|r| r.id == id) else {
            return;
        };
        let st = &mut self.rtpc[idx];
        let v = if st.min < st.max {
            value.clamp(st.min, st.max)
        } else {
            value
        };
        if (st.smooth.target - v).abs() <= f32::EPSILON {
            return;
        }
        let ms = st.smoothing_ms;
        st.smooth.set(v, ms, self.out_sr);
        self.push_event(EV_RTPC_CHANGED, id, 0, v);
        self.fire_trigger(TriggerMatch::RtpcChanged(id));
    }

    /// Returns the latest set (target) value. Smoothing only affects the
    /// audio-rate value used for modulation, never control logic — cue
    /// conditions must see the value the host just set.
    pub fn get_rtpc(&self, id: u32) -> f32 {
        self.pack
            .rtpcs
            .iter()
            .position(|r| r.id == id)
            .map(|i| self.rtpc[i].smooth.target)
            .unwrap_or(0.0)
    }

    pub fn trigger_cue(&mut self, cue_id: u32) {
        self.run_cue_by_id(cue_id);
    }

    // -- player helpers ------------------------------------------------------

    fn anchor_pos(&self, sec_idx: usize, anchor_id: u32) -> f64 {
        if anchor_id == NONE_ID {
            return 0.0;
        }
        self.sec[sec_idx]
            .anchors
            .iter()
            .find(|(id, _)| *id == anchor_id)
            .map(|(_, p)| *p)
            .unwrap_or(0.0)
    }

    fn spawn_main(
        &mut self,
        sec_idx: usize,
        pos: f64,
        fade_in: bool,
        fade_ms: f32,
        from_section_id: u32,
    ) {
        if self.players.len() >= MAX_PLAYERS {
            self.reap_players();
            if self.players.len() >= MAX_PLAYERS {
                self.players.remove(0);
            }
        }
        let mut fade = Smoothed::new(if fade_in { 0.0 } else { 1.0 });
        if fade_in {
            fade.set(1.0, fade_ms, self.out_sr);
        }
        self.players.push(Player {
            section: sec_idx,
            pos,
            fade,
            dying: false,
            fresh: true,
        });
        self.main = Some(self.players.len() - 1);
        let to_id = self.pack.sections[sec_idx].id;
        self.push_event(EV_SECTION_CHANGED, from_section_id, to_id, 0.0);
        self.fire_trigger(TriggerMatch::SectionStart(to_id));
    }

    fn reap_players(&mut self) {
        let main_before = self.main.map(|i| i as isize).unwrap_or(-1);
        let mut kept_main: isize = -1;
        let mut w = 0;
        for r in 0..self.players.len() {
            let p = &self.players[r];
            let dead = p.dying && p.fade.value <= 0.0 && p.fade.target <= 0.0;
            if !dead {
                if r as isize == main_before {
                    kept_main = w as isize;
                }
                self.players.swap(w, r);
                w += 1;
            }
        }
        self.players.truncate(w);
        self.main = if kept_main >= 0 {
            Some(kept_main as usize)
        } else {
            None
        };
        if self.playing && self.players.is_empty() && self.main.is_none() && self.pending.is_none()
        {
            self.playing = false;
            self.oneshots.clear();
            self.push_event(EV_ENDED, 0, 0, 0.0);
        }
    }

    /// Resolve a Timing into an absolute main-player position (bank samples).
    fn timing_pos(&mut self, timing: Timing) -> f64 {
        let Some(mi) = self.main else {
            return 0.0;
        };
        let p = &self.players[mi];
        let d = &self.sec[p.section];
        let fwd = self.rate >= 0.0;
        let grid = |unit: f64, pos: f64| -> f64 {
            if unit <= 0.0 {
                return pos;
            }
            if fwd {
                ((pos / unit + EPS).floor() + 1.0) * unit
            } else {
                (((pos / unit - EPS).ceil()) - 1.0).max(0.0) * unit
            }
        };
        match timing {
            Timing::Immediate => p.pos,
            Timing::NextBeat => grid(d.samples_per_beat, p.pos).min(d.length_samples),
            Timing::NextBar => {
                grid(d.samples_per_beat * d.beats_per_bar, p.pos).min(d.length_samples)
            }
            Timing::SectionEnd => {
                if fwd {
                    d.length_samples
                } else {
                    0.0
                }
            }
        }
    }

    // -- cue dispatch ----------------------------------------------------------

    fn fire_trigger(&mut self, m: TriggerMatch) {
        // Collect matching cue ids first to avoid borrowing issues.
        let mut cues: Vec<u32> = Vec::new();
        for b in &self.pack.bindings {
            let hit = match (b.trigger, m) {
                (Trigger::RtpcChanged { rtpc }, TriggerMatch::RtpcChanged(id)) => rtpc == id,
                (Trigger::SectionStart { section }, TriggerMatch::SectionStart(id)) => {
                    section == NONE_ID || section == id
                }
                (Trigger::SectionEnd { section }, TriggerMatch::SectionEnd(id)) => {
                    section == NONE_ID || section == id
                }
                (
                    Trigger::AnchorReached { section, anchor },
                    TriggerMatch::Anchor(sec_id, anc_id),
                ) => section == sec_id && anchor == anc_id,
                (Trigger::Bar { section }, TriggerMatch::Bar(id)) => {
                    section == NONE_ID || section == id
                }
                (Trigger::Beat { section }, TriggerMatch::Beat(id)) => {
                    section == NONE_ID || section == id
                }
                (Trigger::ModuleStart, TriggerMatch::ModuleStart) => true,
                _ => false,
            };
            if hit {
                cues.push(b.cue);
            }
        }
        for c in cues {
            self.run_cue_by_id(c);
        }
    }

    fn run_cue_by_id(&mut self, cue_id: u32) {
        if self.cue_depth >= MAX_CUE_DEPTH {
            return;
        }
        let Some(ci) = self.pack.cues.iter().position(|c| c.id == cue_id) else {
            return;
        };
        self.cue_depth += 1;
        self.push_event(EV_CUE_FIRED, cue_id, 0, 0.0);
        let rule_count = self.pack.cues[ci].rules.len();
        for ri in 0..rule_count {
            let (cond, stop, actions) = {
                let r = &self.pack.cues[ci].rules[ri];
                (r.condition.clone(), r.stop_if_matched, r.actions.clone())
            };
            let matched = {
                let mut env = EnvView { rt: self };
                vm::eval(&cond, &mut env)
            };
            if matched {
                for a in &actions {
                    self.apply_action(a);
                }
                if stop {
                    break;
                }
            }
        }
        self.cue_depth -= 1;
    }

    fn apply_action(&mut self, a: &Action) {
        match *a {
            Action::Goto {
                section,
                anchor,
                timing,
                crossfade,
                fade_ms,
                bridge,
            } => self.schedule_goto(section, anchor, timing, crossfade, fade_ms, bridge),
            Action::GotoRandom {
                timing,
                crossfade,
                fade_ms,
                bridge,
                ref targets,
            } => {
                if targets.is_empty() {
                    return;
                }
                let total: f32 = targets.iter().map(|t| t.2.max(0.0)).sum();
                let mut pick = self.rand01() * total.max(f32::EPSILON);
                let mut chosen = targets[targets.len() - 1];
                for t in targets {
                    let w = t.2.max(0.0);
                    if pick < w {
                        chosen = *t;
                        break;
                    }
                    pick -= w;
                }
                self.schedule_goto(chosen.0, chosen.1, timing, crossfade, fade_ms, bridge);
            }
            Action::Play { section, anchor } => self.play_section(section, anchor),
            Action::Stop { timing, fade_ms } => {
                if self.main.is_none() || timing == Timing::Immediate {
                    self.stop(fade_ms);
                } else {
                    let at = self.timing_pos(timing);
                    self.pending = Some(Pending {
                        kind: PendingKind::Stop { fade_ms },
                        at,
                    });
                }
            }
            Action::SetTrackGain {
                section,
                track,
                gain,
                fade_ms,
            } => {
                let Some(si) = sec_index(&self.pack, section) else {
                    return;
                };
                let Some(ti) = self.pack.sections[si].tracks.iter().position(|t| t.id == track)
                else {
                    return;
                };
                let out_sr = self.out_sr;
                self.track_gains[si][ti].set(gain.max(0.0), fade_ms, out_sr);
            }
            Action::SetLoop { section, enabled } => {
                if let Some(si) = sec_index(&self.pack, section) {
                    self.loop_flags[si] = enabled;
                }
            }
            Action::Emit { code } => self.push_event(EV_EMIT, code, 0, 0.0),
            Action::SetRtpc { rtpc, value } => self.set_rtpc(rtpc, value),
            Action::OneShot {
                asset,
                gain,
                timing,
            } => {
                let Some(ai) = self.pack.assets.iter().position(|a| a.id == asset) else {
                    return;
                };
                if timing == Timing::Immediate || self.main.is_none() {
                    self.start_oneshot(ai, gain);
                } else {
                    let at = self.timing_pos(timing);
                    if self.pending_oneshots.len() < MAX_ONESHOTS {
                        self.pending_oneshots.push(PendingOneShot {
                            asset_idx: ai,
                            gain,
                            at,
                        });
                    }
                }
            }
        }
    }

    fn schedule_goto(
        &mut self,
        section: u32,
        anchor: u32,
        timing: Timing,
        crossfade: bool,
        fade_ms: f32,
        bridge: u32,
    ) {
        let Some(si) = sec_index(&self.pack, section) else {
            return;
        };
        let start_pos = self.anchor_pos(si, anchor);
        // Resolve an optional bridge section; an invalid id degrades to a direct
        // transition.
        let bridge_si = if bridge != NONE_ID {
            sec_index(&self.pack, bridge)
        } else {
            None
        };

        if self.main.is_none() {
            // Nothing is playing: start the (bridge or) target immediately.
            self.playing = true;
            if let Some(bsi) = bridge_si {
                self.spawn_main(bsi, 0.0, false, 0.0, NONE_ID);
                self.pending = Some(Pending {
                    kind: PendingKind::Goto {
                        section: si,
                        start_pos,
                        crossfade,
                        fade_ms,
                        then: None,
                    },
                    at: self.sec[bsi].length_samples,
                });
            } else {
                self.spawn_main(si, start_pos, false, 0.0, NONE_ID);
            }
            return;
        }

        let at = self.timing_pos(timing);
        let kind = if let Some(bsi) = bridge_si {
            // Play the bridge once, then route to the real destination.
            PendingKind::Goto {
                section: bsi,
                start_pos: 0.0,
                crossfade,
                fade_ms,
                then: Some(GotoThen {
                    section: si,
                    start_pos,
                    crossfade,
                    fade_ms,
                }),
            }
        } else {
            PendingKind::Goto {
                section: si,
                start_pos,
                crossfade,
                fade_ms,
                then: None,
            }
        };
        self.pending = Some(Pending { kind, at });
        self.push_event(EV_GOTO_SCHEDULED, section, anchor, at as f32);
    }

    fn start_oneshot(&mut self, asset_idx: usize, gain: f32) {
        if self.oneshots.len() >= MAX_ONESHOTS {
            self.oneshots.remove(0);
        }
        let id = self.pack.assets[asset_idx].id;
        self.oneshots.push(OneShot {
            asset_idx,
            pos: 0.0,
            gain,
        });
        self.push_event(EV_ONESHOT, id, 0, 0.0);
    }

    fn execute_pending(&mut self) {
        let Some(pending) = self.pending.take() else {
            return;
        };
        match pending.kind {
            PendingKind::Goto {
                section,
                start_pos,
                crossfade,
                fade_ms,
                then,
            } => {
                let from_id = self.current_section();
                if let Some(mi) = self.main.take() {
                    let out_sr = self.out_sr;
                    let p = &mut self.players[mi];
                    p.dying = true;
                    p.fade
                        .set(0.0, if crossfade { fade_ms } else { 0.0 }, out_sr);
                }
                self.reap_players();
                // Stop any sounding synth voices before the cut.
                self.push_all_notes_off();
                self.spawn_main(section, start_pos, crossfade, fade_ms, from_id);
                if let Some(th) = then {
                    // Schedule the real destination at the bridge's section end.
                    self.pending = Some(Pending {
                        kind: PendingKind::Goto {
                            section: th.section,
                            start_pos: th.start_pos,
                            crossfade: th.crossfade,
                            fade_ms: th.fade_ms,
                            then: None,
                        },
                        at: self.sec[section].length_samples,
                    });
                }
            }
            PendingKind::Stop { fade_ms } => self.stop(fade_ms),
        }
    }

    // -- processing --------------------------------------------------------

    /// Bank samples advanced per output frame.
    #[inline]
    fn step_bank(&self) -> f64 {
        self.pack.bank_sample_rate as f64 / self.out_sr * self.rate as f64
    }

    pub fn process(&mut self, out: &mut [f32], frames: usize) {
        let want = frames * self.out_ch;
        for s in out.iter_mut().take(want) {
            *s = 0.0;
        }
        if self.paused {
            return;
        }

        let mut done = 0usize;
        let mut guard = 0u32;
        while done < frames {
            guard += 1;
            if guard > 4096 {
                break; // safety net against scheduling bugs
            }
            // Track the output frame reached so MIDI events carry an offset
            // within this process() block.
            self.block_frame = done;
            // 1) Fire anything already due at the current position.
            self.fire_due();
            if self.players.is_empty() && self.oneshots.is_empty() {
                break;
            }
            // 2) Size the next chunk so it ends exactly on the next boundary.
            let remaining = frames - done;
            let n = self
                .frames_to_boundary(remaining.min(MAX_CHUNK))
                .max(1)
                .min(remaining);
            // 3) Render.
            let chunk_start = done;
            let old_pos = self.main.map(|mi| self.players[mi].pos);
            self.render_chunk(&mut out[done * self.out_ch..], n);
            self.advance_smoothers(n);
            done += n;
            // 4) Fire boundaries crossed inside (old_pos, new_pos].
            if let (Some(op), Some(mi)) = (old_pos, self.main) {
                let np = self.players[mi].pos;
                self.fire_crossed(op, np, chunk_start, frames);
            }
            self.reap_players();
        }
    }

    /// Fire pending transitions / section-end handling that are due *now*.
    fn fire_due(&mut self) {
        for _ in 0..MAX_CUE_DEPTH {
            let Some(mi) = self.main else {
                // Pending stop without a main player: nothing musical to wait for.
                if matches!(
                    self.pending,
                    Some(Pending {
                        kind: PendingKind::Stop { .. },
                        ..
                    })
                ) {
                    self.execute_pending();
                }
                return;
            };
            let pos = self.players[mi].pos;
            let sec_idx = self.players[mi].section;
            let len = self.sec[sec_idx].length_samples;
            let fwd = self.rate >= 0.0;

            if let Some(p) = &self.pending {
                let due = if fwd {
                    pos + EPS >= p.at
                } else {
                    pos - EPS <= p.at
                };
                if due {
                    self.execute_pending();
                    continue;
                }
            }
            // Pending oneshots due now.
            let mut i = 0;
            while i < self.pending_oneshots.len() {
                let due = if fwd {
                    pos + EPS >= self.pending_oneshots[i].at
                } else {
                    pos - EPS <= self.pending_oneshots[i].at
                };
                if due {
                    let po = self.pending_oneshots.remove(i);
                    self.start_oneshot(po.asset_idx, po.gain);
                } else {
                    i += 1;
                }
            }

            // Section boundary (end going forward, start going backward).
            let at_edge = if fwd { pos + EPS >= len } else { pos - EPS <= 0.0 };
            if !at_edge {
                return;
            }
            let sec_id = self.pack.sections[sec_idx].id;
            self.fire_trigger(TriggerMatch::SectionEnd(sec_id));
            if self.main != Some(mi) || self.players.get(mi).map(|p| p.section) != Some(sec_idx)
            {
                continue; // a cue replaced the main player
            }
            // A cue may have scheduled a transition exactly here.
            if let Some(p) = &self.pending {
                let due = if fwd {
                    self.players[mi].pos + EPS >= p.at
                } else {
                    self.players[mi].pos - EPS <= p.at
                };
                if due {
                    self.execute_pending();
                    continue;
                }
            }
            if self.loop_flags[sec_idx] {
                let d = &self.sec[sec_idx];
                let new_pos = if fwd {
                    d.loop_start_samples
                } else {
                    d.length_samples
                };
                self.players[mi].pos = new_pos;
                self.players[mi].fresh = true;
                self.push_event(EV_LOOPED, sec_id, 0, 0.0);
                continue;
            }
            // No loop, no transition: the music ends.
            self.players[mi].dying = true;
            self.players[mi].fade.set(0.0, 0.0, self.out_sr);
            self.main = None;
            self.reap_players();
            return;
        }
    }

    /// Number of frames until the main player hits the nearest boundary.
    fn frames_to_boundary(&self, max: usize) -> usize {
        let Some(mi) = self.main else {
            return max;
        };
        let step = self.step_bank();
        if step.abs() < 1e-12 {
            return max;
        }
        let p = &self.players[mi];
        let d = &self.sec[p.section];
        let fwd = step > 0.0;
        let mut nearest = f64::INFINITY;
        let mut consider = |b: f64| {
            let dist = if fwd { b - p.pos } else { p.pos - b };
            if dist > EPS && dist < nearest {
                nearest = dist;
            }
        };
        // Section edge
        consider(if fwd { d.length_samples } else { 0.0 });
        // Pending transition
        if let Some(pd) = &self.pending {
            consider(pd.at);
        }
        for po in &self.pending_oneshots {
            consider(po.at);
        }
        // Anchors
        for (_, apos) in &d.anchors {
            consider(*apos);
        }
        // Beat / bar grids (only when bound)
        let sec_id = self.pack.sections[p.section].id;
        let needs_beat = self.pack.bindings.iter().any(|b| {
            matches!(b.trigger, Trigger::Beat { section } if section == NONE_ID || section == sec_id)
        });
        let needs_bar = self.pack.bindings.iter().any(|b| {
            matches!(b.trigger, Trigger::Bar { section } if section == NONE_ID || section == sec_id)
        });
        let grid_next = |unit: f64| -> f64 {
            if fwd {
                ((p.pos / unit + EPS).floor() + 1.0) * unit
            } else {
                ((p.pos / unit - EPS).ceil() - 1.0) * unit
            }
        };
        if needs_beat {
            consider(grid_next(d.samples_per_beat));
        }
        if needs_bar {
            consider(grid_next(d.samples_per_beat * d.beats_per_bar));
        }

        if !nearest.is_finite() {
            return max;
        }
        let f = (nearest / step.abs()).ceil() as usize;
        f.clamp(1, max)
    }

    /// Fire beat/bar/anchor triggers crossed in (old, new] (direction aware) and
    /// emit MIDI note events for the main section's instrument tracks.
    /// `chunk_start` is the output frame at `old`; `block_frames` is the size of
    /// the whole process() block (used to clamp MIDI frame offsets).
    fn fire_crossed(&mut self, old: f64, new: f64, chunk_start: usize, block_frames: usize) {
        let Some(mi) = self.main else {
            return;
        };
        let sec_idx = self.players[mi].section;
        let fresh = core::mem::replace(&mut self.players[mi].fresh, false);
        let sec_id = self.pack.sections[sec_idx].id;
        let fwd = new >= old;
        let lo = old.min(new);
        let hi = old.max(new);
        let in_range = |b: f64| -> bool {
            if fresh && (b - old).abs() <= EPS {
                return true;
            }
            if fwd {
                b > lo + EPS && b <= hi + EPS
            } else {
                b >= lo - EPS && b < hi - EPS
            }
        };

        // MIDI: emit instrument note events crossed in this chunk. Only forward
        // playback drives synths (reverse note-on/off is musically undefined).
        if fwd {
            let step = self.step_bank();
            let notes: Vec<MidiEvt> = self.sec[sec_idx]
                .notes
                .iter()
                .filter(|n| in_range(n.pos))
                .map(|n| {
                    let rel = if step.abs() > 1e-12 {
                        ((n.pos - old) / step).round() as i64
                    } else {
                        0
                    };
                    let fo = (chunk_start as i64 + rel)
                        .clamp(0, block_frames.saturating_sub(1) as i64)
                        as u32;
                    MidiEvt {
                        instance: n.instance,
                        frame_offset: fo,
                        status: n.status,
                        key: n.key,
                        channel: n.channel,
                        velocity: n.velocity,
                    }
                })
                .collect();
            for e in notes {
                self.push_midi(e);
            }
        }

        let anchors: Vec<(u32, f64)> = self.sec[sec_idx]
            .anchors
            .iter()
            .filter(|(_, p)| in_range(*p))
            .cloned()
            .collect();
        for (aid, _) in anchors {
            self.fire_trigger(TriggerMatch::Anchor(sec_id, aid));
            if self.main != Some(mi) {
                return;
            }
        }

        let d = &self.sec[sec_idx];
        let spb = d.samples_per_beat;
        let bar = spb * d.beats_per_bar;
        let crossed_grid = |unit: f64| -> bool {
            if unit <= 0.0 {
                return false;
            }
            let k_lo = (lo / unit + EPS).floor();
            let k_hi = (hi / unit + EPS).floor();
            if fresh && (old / unit - (old / unit).round()).abs() < 1e-7 {
                return true;
            }
            k_hi > k_lo
        };
        let beat_hit = crossed_grid(spb);
        let bar_hit = crossed_grid(bar);
        if beat_hit {
            self.fire_trigger(TriggerMatch::Beat(sec_id));
        }
        if bar_hit && self.main == Some(mi) {
            self.fire_trigger(TriggerMatch::Bar(sec_id));
        }
    }

    fn advance_smoothers(&mut self, n: usize) {
        for r in &mut self.rtpc {
            r.smooth.advance(n);
        }
        for sg in &mut self.track_gains {
            for g in sg {
                g.advance(n);
            }
        }
    }

    fn render_chunk(&mut self, out: &mut [f32], n: usize) {
        let step = self.step_bank();
        let out_ch = self.out_ch;

        for pi in 0..self.players.len() {
            let (sec_idx, base_pos) = {
                let p = &self.players[pi];
                (p.section, p.pos)
            };
            let section = &self.pack.sections[sec_idx];
            let derived = &self.sec[sec_idx];

            for (ti, track) in section.tracks.iter().enumerate() {
                if track.muted {
                    continue;
                }
                let tg = self.track_gains[sec_idx][ti];
                let vol = track.volume;
                let pan = track.pan.clamp(-1.0, 1.0);
                // Constant-power pan for mono sources; balance for stereo.
                let pan_l = ((1.0 - pan) * 0.5).sqrt();
                let pan_r = ((1.0 + pan) * 0.5).sqrt();
                let bal_l = if pan > 0.0 { 1.0 - pan } else { 1.0 };
                let bal_r = if pan < 0.0 { 1.0 + pan } else { 1.0 };

                for item in &derived.items[ti] {
                    let asset = &self.pack.assets[item.asset_idx];
                    let asset_ratio =
                        asset.sample_rate as f64 / self.pack.bank_sample_rate as f64;
                    let a_frames = asset.frames as usize;
                    if a_frames == 0 {
                        continue;
                    }
                    let a_ch = asset.channels as usize;
                    let data = &asset.data;

                    for f in 0..n {
                        let pos_f = base_pos + step * f as f64;
                        let rel = pos_f - item.start;
                        if rel < 0.0 || rel >= item.length {
                            continue;
                        }
                        // Item fades (in beats originally, here samples).
                        let mut g = item.gain;
                        if item.fade_in > 0.0 && rel < item.fade_in {
                            g *= (rel / item.fade_in) as f32;
                        }
                        if item.fade_out > 0.0 && (item.length - rel) < item.fade_out {
                            g *= ((item.length - rel) / item.fade_out) as f32;
                        }
                        let src = (item.offset + rel) * asset_ratio;
                        if src < 0.0 {
                            continue;
                        }
                        let i0 = src as usize;
                        if i0 + 1 >= a_frames {
                            continue;
                        }
                        let frac = (src - i0 as f64) as f32;
                        let (mut l, mut r);
                        if a_ch == 1 {
                            let s = data[i0] + (data[i0 + 1] - data[i0]) * frac;
                            l = s * pan_l;
                            r = s * pan_r;
                        } else {
                            let l0 = data[i0 * 2];
                            let l1 = data[i0 * 2 + 2];
                            let r0 = data[i0 * 2 + 1];
                            let r1 = data[i0 * 2 + 3];
                            l = (l0 + (l1 - l0) * frac) * bal_l;
                            r = (r0 + (r1 - r0) * frac) * bal_r;
                        }
                        let pg = self.players[pi].fade.at(f);
                        let total = g * vol * tg.at(f) * pg;
                        l *= total;
                        r *= total;
                        if out_ch == 1 {
                            out[f] += (l + r) * 0.5;
                        } else {
                            out[f * 2] += l;
                            out[f * 2 + 1] += r;
                        }
                    }
                }
            }
            // Advance player position & fade.
            let p = &mut self.players[pi];
            p.pos += step * n as f64;
            p.fade.advance(n);
            if p.dying {
                continue;
            }
            // Non-main, non-dying players (shouldn't exist) are left as-is.
        }

        // Handle fading players that run past their section bounds: loop
        // silently (no triggers) when the section loops, otherwise clamp.
        for pi in 0..self.players.len() {
            if Some(pi) == self.main {
                continue;
            }
            let sec_idx = self.players[pi].section;
            let len = self.sec[sec_idx].length_samples;
            let loop_start = self.sec[sec_idx].loop_start_samples;
            let p = &mut self.players[pi];
            if p.pos >= len {
                if self.loop_flags[sec_idx] {
                    p.pos = loop_start + (p.pos - len);
                } else {
                    p.fade.value = 0.0;
                    p.fade.target = 0.0;
                    p.dying = true;
                }
            } else if p.pos < 0.0 {
                if self.loop_flags[sec_idx] {
                    p.pos += len - loop_start;
                } else {
                    p.fade.value = 0.0;
                    p.fade.target = 0.0;
                    p.dying = true;
                }
            }
        }

        // One-shots: always forward, speed follows |rate|.
        let os_rate = (self.rate as f64).abs();
        let mut oi = 0;
        while oi < self.oneshots.len() {
            let os = &self.oneshots[oi];
            let asset = &self.pack.assets[os.asset_idx];
            let a_frames = asset.frames as usize;
            let a_ch = asset.channels as usize;
            let step_os = asset.sample_rate as f64 / self.out_sr * os_rate;
            let data = &asset.data;
            let gain = os.gain;
            let mut pos = os.pos;
            let mut finished = false;
            for f in 0..n {
                let i0 = pos as usize;
                if i0 + 1 >= a_frames {
                    finished = true;
                    break;
                }
                let frac = (pos - i0 as f64) as f32;
                let (l, r) = if a_ch == 1 {
                    let s = (data[i0] + (data[i0 + 1] - data[i0]) * frac) * gain;
                    (s * 0.7071, s * 0.7071)
                } else {
                    (
                        (data[i0 * 2] + (data[i0 * 2 + 2] - data[i0 * 2]) * frac) * gain,
                        (data[i0 * 2 + 1] + (data[i0 * 2 + 3] - data[i0 * 2 + 1]) * frac)
                            * gain,
                    )
                };
                if out_ch == 1 {
                    out[f] += (l + r) * 0.5;
                } else {
                    out[f * 2] += l;
                    out[f * 2 + 1] += r;
                }
                pos += step_os;
            }
            if finished || pos as usize + 1 >= a_frames {
                self.oneshots.remove(oi);
            } else {
                self.oneshots[oi].pos = pos;
                oi += 1;
            }
        }
    }
}

#[derive(Clone, Copy)]
enum TriggerMatch {
    RtpcChanged(u32),
    SectionStart(u32),
    SectionEnd(u32),
    Anchor(u32, u32),
    Bar(u32),
    Beat(u32),
    ModuleStart,
}

struct EnvView<'a> {
    rt: &'a mut Runtime,
}

impl<'a> vm::VmEnv for EnvView<'a> {
    fn rtpc(&mut self, id: u32) -> f32 {
        self.rt.get_rtpc(id)
    }

    fn special(&mut self, id: u8) -> f32 {
        match id {
            vm::SPECIAL_SECTION => self.rt.current_section() as f32,
            vm::SPECIAL_POSITION_BEATS => self.rt.position_beats(),
            vm::SPECIAL_BAR => {
                let Some(mi) = self.rt.main else { return 0.0 };
                let p = &self.rt.players[mi];
                let d = &self.rt.sec[p.section];
                (p.pos / (d.samples_per_beat * d.beats_per_bar)).floor() as f32
            }
            vm::SPECIAL_PLAYING => {
                if self.rt.is_playing() {
                    1.0
                } else {
                    0.0
                }
            }
            vm::SPECIAL_RAND => self.rt.rand01(),
            vm::SPECIAL_RATE => self.rt.rate(),
            vm::SPECIAL_TIME => {
                (self.rt.position_samples() / self.rt.pack.bank_sample_rate as f64) as f32
            }
            _ => 0.0,
        }
    }
}
