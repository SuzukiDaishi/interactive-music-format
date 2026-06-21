//! IAMP (Interactive Audio Module Pack) v1 binary parser.
//!
//! See docs/02_iam_pack_spec.md for the normative layout.
//! All multi-byte values are little-endian.

pub const MAGIC: [u8; 4] = *b"IAMP";
pub const VERSION: u32 = 2;
pub const NONE_ID: u32 = 0xFFFF_FFFF;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PackError {
    TooShort,
    BadMagic,
    BadVersion,
    Corrupt,
    MissingChunk,
    BadReference,
}

pub type Result<T> = core::result::Result<T, PackError>;

// ---------------------------------------------------------------------------
// Parsed model
// ---------------------------------------------------------------------------

pub struct Pack {
    pub name: String,
    pub bank_sample_rate: u32,
    pub bpm: f32,
    pub tsig_num: u8,
    pub tsig_den: u8,
    pub start_section: u32,
    pub rtpcs: Vec<Rtpc>,
    pub sections: Vec<Section>,
    pub cues: Vec<Cue>,
    pub bindings: Vec<Binding>,
    pub assets: Vec<Asset>,
}

// Some fields (names, ids) are part of the format and kept for
// tooling/debugging even though the engine does not read them.
#[allow(dead_code)]
pub struct Rtpc {
    pub id: u32,
    pub name: String,
    pub ty: u8, // 0=f32, 1=bool, 2=enum
    pub variants: Vec<String>,
    pub default: f32,
    pub min: f32,
    pub max: f32,
    pub smoothing_ms: f32,
}

// Some fields (names, ids) are part of the format and kept for
// tooling/debugging even though the engine does not read them.
#[allow(dead_code)]
pub struct Section {
    pub id: u32,
    pub name: String,
    pub bpm: f32, // 0 => inherit project bpm
    pub tsig_num: u8,
    pub tsig_den: u8,
    pub loop_enabled: bool,
    pub length_beats: f32,
    pub loop_start_beats: f32,
    pub tracks: Vec<Track>,
    pub anchors: Vec<Anchor>,
}

// Some fields (names, ids) are part of the format and kept for
// tooling/debugging even though the engine does not read them.
#[allow(dead_code)]
pub struct Track {
    pub id: u32,
    pub name: String,
    pub volume: f32,
    pub pan: f32, // -1..1
    pub muted: bool,
    /// 0 = audio (PCM items), 1 = instrument (MIDI notes -> plugin instance).
    pub kind: u8,
    /// Plugin instance id for instrument tracks (NONE_ID otherwise).
    pub instrument: u32,
    pub items: Vec<Item>,
    pub notes: Vec<Note>,
}

// Some fields are part of the format and kept for tooling even though the
// engine only uses a subset.
#[allow(dead_code)]
#[derive(Debug, Clone, Copy)]
pub struct Note {
    pub start_beat: f32,
    pub length_beats: f32,
    pub key: u8,
    pub channel: u8,
    pub velocity: f32,
}

// Some fields (names, ids) are part of the format and kept for
// tooling/debugging even though the engine does not read them.
#[allow(dead_code)]
pub struct Item {
    pub id: u32,
    pub asset_id: u32,
    pub start_beat: f32,
    pub length_beats: f32,
    pub offset_beats: f32,
    pub gain: f32,
    pub fade_in_beats: f32,
    pub fade_out_beats: f32,
}

// Some fields (names, ids) are part of the format and kept for
// tooling/debugging even though the engine does not read them.
#[allow(dead_code)]
pub struct Anchor {
    pub id: u32,
    pub name: String,
    pub beat: f32,
}

// Some fields (names, ids) are part of the format and kept for
// tooling/debugging even though the engine does not read them.
#[allow(dead_code)]
pub struct Cue {
    pub id: u32,
    pub name: String,
    pub rules: Vec<Rule>,
}

pub struct Rule {
    /// Expression bytecode; empty means "always true".
    pub condition: Vec<u8>,
    /// When true and the condition matched, remaining rules are skipped.
    pub stop_if_matched: bool,
    pub actions: Vec<Action>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Timing {
    Immediate,
    NextBeat,
    NextBar,
    SectionEnd,
}

impl Timing {
    fn from_u8(v: u8) -> Result<Timing> {
        Ok(match v {
            0 => Timing::Immediate,
            1 => Timing::NextBeat,
            2 => Timing::NextBar,
            3 => Timing::SectionEnd,
            _ => return Err(PackError::Corrupt),
        })
    }
}

#[derive(Debug, Clone)]
pub enum Action {
    Goto {
        section: u32,
        anchor: u32, // NONE_ID => section start
        timing: Timing,
        crossfade: bool,
        fade_ms: f32,
        bridge: u32, // NONE_ID => direct transition
    },
    Play {
        section: u32,
        anchor: u32,
    },
    Stop {
        timing: Timing,
        fade_ms: f32,
    },
    SetTrackGain {
        section: u32,
        track: u32,
        gain: f32,
        fade_ms: f32,
    },
    SetLoop {
        section: u32,
        enabled: bool,
    },
    Emit {
        code: u32,
    },
    SetRtpc {
        rtpc: u32,
        value: f32,
    },
    OneShot {
        asset: u32,
        gain: f32,
        timing: Timing,
    },
    GotoRandom {
        timing: Timing,
        crossfade: bool,
        fade_ms: f32,
        bridge: u32, // NONE_ID => direct transition
        targets: Vec<(u32, u32, f32)>, // (section, anchor, weight)
    },
}

#[derive(Debug, Clone, Copy)]
pub enum Trigger {
    RtpcChanged { rtpc: u32 },
    SectionStart { section: u32 }, // NONE_ID = any
    SectionEnd { section: u32 },
    AnchorReached { section: u32, anchor: u32 },
    Bar { section: u32 },
    Beat { section: u32 },
    ModuleStart,
}

pub struct Binding {
    pub trigger: Trigger,
    pub cue: u32,
}

// Some fields (names, ids) are part of the format and kept for
// tooling/debugging even though the engine does not read them.
#[allow(dead_code)]
pub struct Asset {
    pub id: u32,
    pub name: String,
    pub channels: u32,
    pub sample_rate: u32,
    pub frames: u32,
    /// Interleaved f32 samples (pcm16 sources are decoded at load time).
    pub data: Vec<f32>,
}

// ---------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Reader { buf, pos: 0 }
    }

    fn remaining(&self) -> usize {
        self.buf.len() - self.pos
    }

    fn bytes(&mut self, n: usize) -> Result<&'a [u8]> {
        if self.remaining() < n {
            return Err(PackError::TooShort);
        }
        let s = &self.buf[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }

    fn u8(&mut self) -> Result<u8> {
        Ok(self.bytes(1)?[0])
    }

    fn u16(&mut self) -> Result<u16> {
        let b = self.bytes(2)?;
        Ok(u16::from_le_bytes([b[0], b[1]]))
    }

    fn u32(&mut self) -> Result<u32> {
        let b = self.bytes(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }

    fn f32(&mut self) -> Result<f32> {
        Ok(f32::from_bits(self.u32()?))
    }

    fn str(&mut self) -> Result<String> {
        let len = self.u16()? as usize;
        let b = self.bytes(len)?;
        String::from_utf8(b.to_vec()).map_err(|_| PackError::Corrupt)
    }
}

const MAX_COUNT: u32 = 65_536;

fn checked_count(n: u32) -> Result<usize> {
    if n > MAX_COUNT {
        return Err(PackError::Corrupt);
    }
    Ok(n as usize)
}

pub fn parse(buf: &[u8]) -> Result<Pack> {
    let mut r = Reader::new(buf);
    if r.bytes(4)? != MAGIC {
        return Err(PackError::BadMagic);
    }
    if r.u32()? != VERSION {
        return Err(PackError::BadVersion);
    }
    let chunk_count = checked_count(r.u32()?)?;

    let mut pack = Pack {
        name: String::new(),
        bank_sample_rate: 48_000,
        bpm: 120.0,
        tsig_num: 4,
        tsig_den: 4,
        start_section: NONE_ID,
        rtpcs: Vec::new(),
        sections: Vec::new(),
        cues: Vec::new(),
        bindings: Vec::new(),
        assets: Vec::new(),
    };
    let mut have_proj = false;

    for _ in 0..chunk_count {
        let id: [u8; 4] = r.bytes(4)?.try_into().unwrap();
        let len = r.u32()? as usize;
        let payload = r.bytes(len)?;
        // Chunks are padded to 4-byte alignment; padding is not in `len`.
        let pad = (4 - (len % 4)) % 4;
        r.bytes(pad)?;

        let mut cr = Reader::new(payload);
        match &id {
            b"PROJ" => {
                parse_proj(&mut cr, &mut pack)?;
                have_proj = true;
            }
            b"RTPC" => parse_rtpc(&mut cr, &mut pack)?,
            b"SECT" => parse_sect(&mut cr, &mut pack)?,
            b"CUES" => parse_cues(&mut cr, &mut pack)?,
            b"ABNK" => parse_abnk(&mut cr, &mut pack)?,
            // Unknown chunks (e.g. "META") are skipped for forward compat.
            _ => {}
        }
    }

    if !have_proj {
        return Err(PackError::MissingChunk);
    }
    validate(&pack)?;
    Ok(pack)
}

fn parse_proj(r: &mut Reader, pack: &mut Pack) -> Result<()> {
    pack.name = r.str()?;
    pack.bank_sample_rate = r.u32()?;
    pack.bpm = r.f32()?;
    pack.tsig_num = r.u8()?;
    pack.tsig_den = r.u8()?;
    r.u16()?; // reserved
    pack.start_section = r.u32()?;
    if pack.bank_sample_rate == 0 || !(pack.bpm > 0.0) || pack.tsig_num == 0 || pack.tsig_den == 0
    {
        return Err(PackError::Corrupt);
    }
    Ok(())
}

fn parse_rtpc(r: &mut Reader, pack: &mut Pack) -> Result<()> {
    let count = checked_count(r.u32()?)?;
    for _ in 0..count {
        let id = r.u32()?;
        let name = r.str()?;
        let ty = r.u8()?;
        r.u8()?; // pad
        let variant_count = r.u16()? as usize;
        let mut variants = Vec::with_capacity(variant_count.min(256));
        for _ in 0..variant_count {
            variants.push(r.str()?);
        }
        let default = r.f32()?;
        let min = r.f32()?;
        let max = r.f32()?;
        let smoothing_ms = r.f32()?;
        pack.rtpcs.push(Rtpc {
            id,
            name,
            ty,
            variants,
            default,
            min,
            max,
            smoothing_ms,
        });
    }
    Ok(())
}

fn parse_sect(r: &mut Reader, pack: &mut Pack) -> Result<()> {
    let count = checked_count(r.u32()?)?;
    for _ in 0..count {
        let id = r.u32()?;
        let name = r.str()?;
        let bpm = r.f32()?;
        let tsig_num = r.u8()?;
        let tsig_den = r.u8()?;
        let loop_enabled = r.u8()? != 0;
        r.u8()?; // pad
        let length_beats = r.f32()?;
        let loop_start_beats = r.f32()?;
        if !(length_beats > 0.0) {
            return Err(PackError::Corrupt);
        }

        let track_count = checked_count(r.u32()?)?;
        let mut tracks = Vec::with_capacity(track_count);
        for _ in 0..track_count {
            let tid = r.u32()?;
            let tname = r.str()?;
            let volume = r.f32()?;
            let pan = r.f32()?;
            let muted = r.u8()? != 0;
            let kind = r.u8()?;
            r.u16()?; // pad
            let instrument = r.u32()?;
            let effect_count = r.u16()? as usize;
            for _ in 0..effect_count {
                r.u32()?; // effect instance ids (handled by the JS host)
            }
            let item_count = checked_count(r.u32()?)?;
            let mut items = Vec::with_capacity(item_count);
            for _ in 0..item_count {
                items.push(Item {
                    id: r.u32()?,
                    asset_id: r.u32()?,
                    start_beat: r.f32()?,
                    length_beats: r.f32()?,
                    offset_beats: r.f32()?,
                    gain: r.f32()?,
                    fade_in_beats: r.f32()?,
                    fade_out_beats: r.f32()?,
                });
            }
            let note_count = checked_count(r.u32()?)?;
            let mut notes = Vec::with_capacity(note_count);
            for _ in 0..note_count {
                let start_beat = r.f32()?;
                let length_beats = r.f32()?;
                let key = r.u8()?;
                let channel = r.u8()?;
                r.u16()?; // pad
                let velocity = r.f32()?;
                notes.push(Note {
                    start_beat,
                    length_beats,
                    key,
                    channel,
                    velocity,
                });
            }
            tracks.push(Track {
                id: tid,
                name: tname,
                volume,
                pan,
                muted,
                kind,
                instrument,
                items,
                notes,
            });
        }

        let anchor_count = checked_count(r.u32()?)?;
        let mut anchors = Vec::with_capacity(anchor_count);
        for _ in 0..anchor_count {
            anchors.push(Anchor {
                id: r.u32()?,
                name: r.str()?,
                beat: r.f32()?,
            });
        }

        pack.sections.push(Section {
            id,
            name,
            bpm,
            tsig_num,
            tsig_den,
            loop_enabled,
            length_beats,
            loop_start_beats,
            tracks,
            anchors,
        });
    }
    Ok(())
}

fn parse_action(r: &mut Reader) -> Result<Action> {
    let op = r.u8()?;
    Ok(match op {
        0x01 => {
            let section = r.u32()?;
            let anchor = r.u32()?;
            let timing = Timing::from_u8(r.u8()?)?;
            let crossfade = r.u8()? != 0;
            r.u16()?; // pad
            let fade_ms = r.f32()?;
            let bridge = r.u32()?;
            Action::Goto {
                section,
                anchor,
                timing,
                crossfade,
                fade_ms,
                bridge,
            }
        }
        0x02 => Action::Play {
            section: r.u32()?,
            anchor: r.u32()?,
        },
        0x03 => {
            let timing = Timing::from_u8(r.u8()?)?;
            r.bytes(3)?;
            Action::Stop {
                timing,
                fade_ms: r.f32()?,
            }
        }
        0x04 => Action::SetTrackGain {
            section: r.u32()?,
            track: r.u32()?,
            gain: r.f32()?,
            fade_ms: r.f32()?,
        },
        0x05 => {
            let section = r.u32()?;
            let enabled = r.u8()? != 0;
            r.bytes(3)?;
            Action::SetLoop { section, enabled }
        }
        0x06 => Action::Emit { code: r.u32()? },
        0x07 => Action::SetRtpc {
            rtpc: r.u32()?,
            value: r.f32()?,
        },
        0x08 => {
            let asset = r.u32()?;
            let gain = r.f32()?;
            let timing = Timing::from_u8(r.u8()?)?;
            r.bytes(3)?;
            Action::OneShot {
                asset,
                gain,
                timing,
            }
        }
        0x09 => {
            let count = r.u8()? as usize;
            let timing = Timing::from_u8(r.u8()?)?;
            let crossfade = r.u8()? != 0;
            r.u8()?; // pad
            let fade_ms = r.f32()?;
            let bridge = r.u32()?;
            let mut targets = Vec::with_capacity(count);
            for _ in 0..count {
                targets.push((r.u32()?, r.u32()?, r.f32()?));
            }
            Action::GotoRandom {
                timing,
                crossfade,
                fade_ms,
                bridge,
                targets,
            }
        }
        _ => return Err(PackError::Corrupt),
    })
}

fn parse_cues(r: &mut Reader, pack: &mut Pack) -> Result<()> {
    let cue_count = checked_count(r.u32()?)?;
    for _ in 0..cue_count {
        let id = r.u32()?;
        let name = r.str()?;
        let rule_count = checked_count(r.u32()?)?;
        let mut rules = Vec::with_capacity(rule_count);
        for _ in 0..rule_count {
            let cond_len = r.u16()? as usize;
            let condition = r.bytes(cond_len)?.to_vec();
            let action_count = r.u8()? as usize;
            let stop_if_matched = r.u8()? != 0;
            let mut actions = Vec::with_capacity(action_count);
            for _ in 0..action_count {
                actions.push(parse_action(r)?);
            }
            rules.push(Rule {
                condition,
                stop_if_matched,
                actions,
            });
        }
        pack.cues.push(Cue { id, name, rules });
    }

    let binding_count = checked_count(r.u32()?)?;
    for _ in 0..binding_count {
        let ty = r.u8()?;
        r.bytes(3)?; // pad
        let trigger = match ty {
            1 => Trigger::RtpcChanged { rtpc: r.u32()? },
            2 => Trigger::SectionStart { section: r.u32()? },
            3 => Trigger::SectionEnd { section: r.u32()? },
            4 => Trigger::AnchorReached {
                section: r.u32()?,
                anchor: r.u32()?,
            },
            5 => Trigger::Bar { section: r.u32()? },
            6 => Trigger::Beat { section: r.u32()? },
            7 => Trigger::ModuleStart,
            _ => return Err(PackError::Corrupt),
        };
        let cue = r.u32()?;
        pack.bindings.push(Binding { trigger, cue });
    }
    Ok(())
}

fn parse_abnk(r: &mut Reader, pack: &mut Pack) -> Result<()> {
    let count = checked_count(r.u32()?)?;
    for _ in 0..count {
        let id = r.u32()?;
        let name = r.str()?;
        let format = r.u8()?;
        let channels = r.u8()? as u32;
        r.u16()?; // pad
        let sample_rate = r.u32()?;
        let frames = r.u32()?;
        if channels == 0 || channels > 2 || sample_rate == 0 {
            return Err(PackError::Corrupt);
        }
        let n_samples = frames as usize * channels as usize;
        let data = match format {
            0 => {
                let raw = r.bytes(n_samples * 2)?;
                let mut v = Vec::with_capacity(n_samples);
                for c in raw.chunks_exact(2) {
                    let s = i16::from_le_bytes([c[0], c[1]]);
                    v.push(s as f32 / 32768.0);
                }
                v
            }
            1 => {
                let raw = r.bytes(n_samples * 4)?;
                let mut v = Vec::with_capacity(n_samples);
                for c in raw.chunks_exact(4) {
                    v.push(f32::from_le_bytes([c[0], c[1], c[2], c[3]]));
                }
                v
            }
            _ => return Err(PackError::Corrupt),
        };
        // Sample data is padded to 4-byte alignment.
        let byte_len = n_samples * if format == 0 { 2 } else { 4 };
        let pad = (4 - (byte_len % 4)) % 4;
        r.bytes(pad)?;
        pack.assets.push(Asset {
            id,
            name,
            channels,
            sample_rate,
            frames,
            data,
        });
    }
    Ok(())
}

fn validate(pack: &Pack) -> Result<()> {
    let section_ok = |id: u32| id == NONE_ID || pack.sections.iter().any(|s| s.id == id);
    let asset_ok = |id: u32| pack.assets.iter().any(|a| a.id == id);

    if !section_ok(pack.start_section) {
        return Err(PackError::BadReference);
    }
    for s in &pack.sections {
        for t in &s.tracks {
            for i in &t.items {
                if !asset_ok(i.asset_id) {
                    return Err(PackError::BadReference);
                }
            }
        }
    }
    for b in &pack.bindings {
        if !pack.cues.iter().any(|c| c.id == b.cue) {
            return Err(PackError::BadReference);
        }
        match b.trigger {
            Trigger::SectionStart { section }
            | Trigger::SectionEnd { section }
            | Trigger::Bar { section }
            | Trigger::Beat { section } => {
                if !section_ok(section) {
                    return Err(PackError::BadReference);
                }
            }
            Trigger::AnchorReached { section, anchor } => {
                let Some(sec) = pack.sections.iter().find(|s| s.id == section) else {
                    return Err(PackError::BadReference);
                };
                if !sec.anchors.iter().any(|a| a.id == anchor) {
                    return Err(PackError::BadReference);
                }
            }
            Trigger::RtpcChanged { rtpc } => {
                if !pack.rtpcs.iter().any(|r| r.id == rtpc) {
                    return Err(PackError::BadReference);
                }
            }
            Trigger::ModuleStart => {}
        }
    }
    Ok(())
}
