/**
 * Demo project: "Adventure Demo".
 *
 * A self-contained interactive music project whose audio assets are
 * synthesized in code (no audio files needed). Used by both the Web DAW
 * ("Load demo project") and examples/make-demo.mjs.
 *
 * Demonstrates:
 *  - RTPC-driven transitions   (is_battle, intensity)
 *  - RTPC-driven mixing        (weather enum -> track gains)
 *  - random branching          (module start picks a variation)
 *  - loop-by-default + "press a button to end" (to_ending manual cue)
 */

const SR = 48000;
const BPM = 120;
const SPB = (SR * 60) / BPM; // samples per beat

// ---------------------------------------------------------------------------
// Tiny synthesizer
// ---------------------------------------------------------------------------

function note(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function clamp16(v) {
  return Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
}

/** Renders `beats` beats of audio through `fn(buf)` into pcm16 mono. */
function renderBeats(beats, fn) {
  const frames = Math.round(beats * SPB);
  const buf = new Float32Array(frames);
  fn(buf);
  const out = new Int16Array(frames);
  for (let i = 0; i < frames; i++) out[i] = clamp16(buf[i]);
  return out;
}

function addSine(buf, freq, start, dur, gain, { attack = 0.005, decay = dur } = {}) {
  const s0 = Math.round(start * SR);
  const n = Math.round(dur * SR);
  for (let i = 0; i < n && s0 + i < buf.length; i++) {
    const t = i / SR;
    const env = Math.min(1, t / attack) * Math.exp(-t / decay);
    buf[s0 + i] += Math.sin(2 * Math.PI * freq * t) * gain * env;
  }
}

function addSaw(buf, freq, start, dur, gain, decay = dur) {
  const s0 = Math.round(start * SR);
  const n = Math.round(dur * SR);
  let phase = 0;
  for (let i = 0; i < n && s0 + i < buf.length; i++) {
    const t = i / SR;
    const env = Math.min(1, t / 0.004) * Math.exp(-t / decay);
    phase += freq / SR;
    const saw = 2 * (phase - Math.floor(phase + 0.5));
    buf[s0 + i] += saw * gain * env * 0.6;
  }
}

function addSquare(buf, freq, start, dur, gain, decay = 0.12) {
  const s0 = Math.round(start * SR);
  const n = Math.round(dur * SR);
  for (let i = 0; i < n && s0 + i < buf.length; i++) {
    const t = i / SR;
    const env = Math.exp(-t / decay);
    const sq = Math.sign(Math.sin(2 * Math.PI * freq * t));
    buf[s0 + i] += sq * gain * env * 0.4;
  }
}

function addKick(buf, start, gain = 0.9) {
  const s0 = Math.round(start * SR);
  const n = Math.round(0.18 * SR);
  for (let i = 0; i < n && s0 + i < buf.length; i++) {
    const t = i / SR;
    const f = 120 * Math.exp(-t * 22) + 42;
    const env = Math.exp(-t * 18);
    buf[s0 + i] += Math.sin(2 * Math.PI * f * t) * gain * env;
  }
}

let noiseSeed = 0x12345;
function noise() {
  noiseSeed ^= noiseSeed << 13;
  noiseSeed ^= noiseSeed >>> 17;
  noiseSeed ^= noiseSeed << 5;
  return ((noiseSeed >>> 0) / 0xffffffff) * 2 - 1;
}

function addHat(buf, start, gain = 0.18, decay = 0.03) {
  const s0 = Math.round(start * SR);
  const n = Math.round(0.07 * SR);
  let hp = 0;
  for (let i = 0; i < n && s0 + i < buf.length; i++) {
    const t = i / SR;
    const w = noise();
    const v = w - hp; // crude highpass
    hp = hp * 0.6 + w * 0.4;
    buf[s0 + i] += v * gain * Math.exp(-t / decay);
  }
}

function addSnare(buf, start, gain = 0.4) {
  const s0 = Math.round(start * SR);
  const n = Math.round(0.16 * SR);
  for (let i = 0; i < n && s0 + i < buf.length; i++) {
    const t = i / SR;
    buf[s0 + i] += (noise() * 0.7 + Math.sin(2 * Math.PI * 190 * t) * 0.4) * gain * Math.exp(-t * 22);
  }
}

const beatSec = 60 / BPM;

// -- asset renderers --------------------------------------------------------

function explorePad() {
  // 8 beats; Am -> F chords, slow swell.
  return renderBeats(8, (buf) => {
    const chords = [
      [57, 60, 64],
      [53, 57, 60],
    ];
    chords.forEach((chord, ci) => {
      const start = ci * 4 * beatSec;
      for (const m of chord) {
        addSine(buf, note(m), start, 4 * beatSec, 0.16, { attack: 0.8, decay: 8 });
        addSine(buf, note(m) * 1.005, start, 4 * beatSec, 0.1, { attack: 1.2, decay: 8 });
      }
    });
  });
}

function exploreArp() {
  // 8 beats of gentle 8th-note arpeggio.
  return renderBeats(8, (buf) => {
    const seq = [69, 72, 76, 81, 76, 72, 69, 72, 65, 69, 72, 77, 72, 69, 65, 69];
    seq.forEach((m, i) => {
      addSquare(buf, note(m), i * beatSec * 0.5, 0.3, 0.12, 0.09);
    });
  });
}

function battleDrumsLow() {
  // 16 beats, four-on-the-floor with hats.
  return renderBeats(16, (buf) => {
    for (let b = 0; b < 16; b++) {
      addKick(buf, b * beatSec, 0.85);
      addHat(buf, (b + 0.5) * beatSec, 0.15);
      if (b % 4 === 2) addSnare(buf, b * beatSec, 0.32);
    }
  });
}

function battleDrumsHigh() {
  // 16 beats, denser pattern.
  return renderBeats(16, (buf) => {
    for (let b = 0; b < 16; b++) {
      addKick(buf, b * beatSec, 0.9);
      addHat(buf, (b + 0.25) * beatSec, 0.13);
      addHat(buf, (b + 0.5) * beatSec, 0.2);
      addHat(buf, (b + 0.75) * beatSec, 0.13);
      if (b % 2 === 1) addSnare(buf, b * beatSec, 0.36);
    }
  });
}

function battleBass() {
  // 16 beats; driving eighth-note bass line in A minor.
  return renderBeats(16, (buf) => {
    const roots = [45, 45, 48, 43]; // A C G
    for (let bar = 0; bar < 4; bar++) {
      const m = roots[bar];
      for (let e = 0; e < 8; e++) {
        addSaw(buf, note(m - 12), (bar * 4 + e * 0.5) * beatSec, 0.22, 0.5, 0.14);
      }
    }
  });
}

function battleLead() {
  // 16 beats; sparse lead used by Battle_High.
  return renderBeats(16, (buf) => {
    const seq = [
      [0, 81], [1.5, 84], [3, 81], [4, 79], [6, 76], [8, 81], [9.5, 84],
      [11, 88], [12, 84], [14, 81],
    ];
    for (const [b, m] of seq) {
      addSaw(buf, note(m), b * beatSec, 0.5, 0.3, 0.25);
      addSaw(buf, note(m) * 1.01, b * beatSec, 0.5, 0.18, 0.25);
    }
  });
}

function stabHit() {
  // One-shot stinger (2 beats).
  return renderBeats(2, (buf) => {
    for (const m of [57, 60, 64, 69]) {
      addSaw(buf, note(m), 0, 1.0, 0.4, 0.4);
    }
    addKick(buf, 0, 1.0);
  });
}

function outroPad() {
  // 8 beats; resolving chord, natural decay.
  return renderBeats(8, (buf) => {
    for (const m of [57, 60, 64, 69]) {
      addSine(buf, note(m), 0, 8 * beatSec, 0.18, { attack: 0.05, decay: 2.2 });
    }
    addKick(buf, 0, 0.7);
  });
}

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

const A = {
  EXPLORE_PAD: 0,
  EXPLORE_ARP: 1,
  BATTLE_DRUMS_LOW: 2,
  BATTLE_DRUMS_HIGH: 3,
  BATTLE_BASS: 4,
  BATTLE_LEAD: 5,
  STAB: 6,
  OUTRO_PAD: 7,
};

const S = { EXPLORE: 0, BATTLE_LOW: 1, BATTLE_HIGH: 2, OUTRO: 3 };
const R = { INTENSITY: 0, IS_BATTLE: 1, WEATHER: 2 };
// WCLAP plugin bank ids and instance ids (synth/piano = instruments, limiter = master fx).
const P = { SYNTH: 0, LIMITER: 1, PIANO: 2 };
const I = { SYNTH: 0, LIMITER: 1, PIANO: 2 };
const C = {
  ON_BATTLE: 0,
  ON_INTENSITY: 1,
  ON_WEATHER: 2,
  TO_ENDING: 3,
  ON_START: 4,
  STAB_ON_HIGH: 5,
};

function item(id, assetId, startBeat, lengthBeats, opts = {}) {
  return {
    id,
    assetId,
    startBeat,
    lengthBeats,
    offsetBeats: opts.offsetBeats ?? 0,
    gain: opts.gain ?? 1,
    fadeInBeats: opts.fadeInBeats ?? 0,
    fadeOutBeats: opts.fadeOutBeats ?? 0,
  };
}

function track(id, name, items, opts = {}) {
  return {
    id,
    name,
    volume: opts.volume ?? 1,
    pan: opts.pan ?? 0,
    muted: false,
    items,
  };
}

/** An instrument (MIDI) track whose notes drive a WCLAP synth instance. */
function instrTrack(id, name, instrument, notes, opts = {}) {
  return {
    id,
    name,
    volume: opts.volume ?? 1,
    pan: opts.pan ?? 0,
    muted: false,
    items: [],
    kind: 'instrument',
    instrument,
    notes,
    effects: opts.effects ?? [],
  };
}

// A short A-minor synth lead phrase (8 beats) layered onto Explore. It only
// sounds when a WCLAP synth hosts it; pure-WASM runtimes skip instrument tracks.
const synthLeadNotes = [
  { startBeat: 0, lengthBeats: 1.5, key: 69, velocity: 0.85, channel: 0 },
  { startBeat: 1.5, lengthBeats: 0.5, key: 72, velocity: 0.7, channel: 0 },
  { startBeat: 2, lengthBeats: 1, key: 76, velocity: 0.9, channel: 0 },
  { startBeat: 3, lengthBeats: 1, key: 74, velocity: 0.75, channel: 0 },
  { startBeat: 4, lengthBeats: 1.5, key: 72, velocity: 0.8, channel: 0 },
  { startBeat: 5.5, lengthBeats: 0.5, key: 69, velocity: 0.7, channel: 0 },
  { startBeat: 6, lengthBeats: 2, key: 67, velocity: 0.8, channel: 0 },
];

// A sparse A-minor piano figure for the VCSL sampler (Explore, always on).
const pianoNotes = [
  { startBeat: 0, lengthBeats: 2, key: 57, velocity: 0.6, channel: 0 },
  { startBeat: 2, lengthBeats: 2, key: 64, velocity: 0.5, channel: 0 },
  { startBeat: 4, lengthBeats: 2, key: 60, velocity: 0.55, channel: 0 },
  { startBeat: 6, lengthBeats: 1, key: 67, velocity: 0.5, channel: 0 },
  { startBeat: 7, lengthBeats: 1, key: 64, velocity: 0.45, channel: 0 },
];

export function makeDemoAssets() {
  const make = (id, name, data) => ({
    id,
    name,
    channels: 1,
    sampleRate: SR,
    frames: data.length,
    format: 'pcm16',
    data,
  });
  return [
    make(A.EXPLORE_PAD, 'explore_pad', explorePad()),
    make(A.EXPLORE_ARP, 'explore_arp', exploreArp()),
    make(A.BATTLE_DRUMS_LOW, 'battle_drums_low', battleDrumsLow()),
    make(A.BATTLE_DRUMS_HIGH, 'battle_drums_high', battleDrumsHigh()),
    make(A.BATTLE_BASS, 'battle_bass', battleBass()),
    make(A.BATTLE_LEAD, 'battle_lead', battleLead()),
    make(A.STAB, 'stab_hit', stabHit()),
    make(A.OUTRO_PAD, 'outro_pad', outroPad()),
  ];
}

export function makeDemoProject() {
  return {
    formatVersion: 1,
    name: 'Adventure Demo',
    bankSampleRate: SR,
    bpm: BPM,
    timeSignature: [4, 4],
    startSectionId: S.EXPLORE,
    // WebCLAP: embedded synth + VCSL piano (instruments) + limiter (master fx).
    plugins: [
      { id: P.SYNTH, name: 'Z Audio Simple Synth', clapPluginId: 'dev.zaudio.simple-synth', embedded: true },
      { id: P.LIMITER, name: 'Z Audio Limiter', clapPluginId: 'dev.zaudio.limiter', embedded: true },
      { id: P.PIANO, name: 'Z Audio VCSL Piano', clapPluginId: 'dev.zaudio.vcsl-piano', embedded: true },
    ],
    pluginInstances: [
      { id: I.SYNTH, pluginBankId: P.SYNTH, params: [] },
      { id: I.LIMITER, pluginBankId: P.LIMITER, params: [] },
      { id: I.PIANO, pluginBankId: P.PIANO, params: [] },
    ],
    masterEffects: [I.LIMITER],
    // 縦の遷移 (vertical blend): `intensity` fades the Explore synth lead in
    // continuously — no cue scripting needed, the engine evaluates the curve.
    blends: [
      {
        id: 0,
        rtpc: R.INTENSITY,
        section: S.EXPLORE,
        track: 2,
        points: [
          { x: 0, y: 0 },
          { x: 0.45, y: 0 },
          { x: 0.75, y: 1 },
          { x: 1, y: 1.1 },
        ],
      },
    ],
    // Generative control: `intensity` also deepens the synth's vibrato
    // (Simple Synth CLAP param 33 = LFO depth in semitones).
    paramMods: [
      {
        instance: I.SYNTH,
        param: 33,
        rtpc: R.INTENSITY,
        points: [
          { x: 0, y: 0 },
          { x: 1, y: 5 },
        ],
      },
    ],
    noteSources: [],
    // パート単位の遷移 (track transition), authored as a script graph: manual
    // cues swap only the Drums slot of Battle_Low to Battle_High's drums (and
    // back) on the next bar while bass keeps playing.
    graphs: [
      {
        id: 0,
        name: 'drum swap',
        nodes: [
          { id: 'swap', kind: 'onManualCue', x: 40, y: 40, data: { name: 'swap_drums' } },
          {
            id: 'do_swap',
            kind: 'gotoTrack',
            x: 260,
            y: 40,
            data: {
              section: S.BATTLE_LOW,
              track: 0,
              sourceSection: S.BATTLE_HIGH,
              sourceTrack: 0,
              timing: 'nextBar',
              transition: 'crossfade',
              fadeMs: 120,
            },
          },
          { id: 'restore', kind: 'onManualCue', x: 40, y: 190, data: { name: 'restore_drums' } },
          {
            id: 'do_restore',
            kind: 'gotoTrack',
            x: 260,
            y: 190,
            data: {
              section: S.BATTLE_LOW,
              track: 0,
              sourceSection: null,
              sourceTrack: null,
              timing: 'nextBar',
              transition: 'crossfade',
              fadeMs: 120,
            },
          },
        ],
        edges: [
          { from: 'swap', fromPort: 'out', to: 'do_swap', toPort: 'in' },
          { from: 'restore', fromPort: 'out', to: 'do_restore', toPort: 'in' },
        ],
      },
    ],
    rtpcs: [
      {
        id: R.INTENSITY,
        name: 'intensity',
        type: 'f32',
        default: 0,
        min: 0,
        max: 1,
        smoothingMs: 50,
      },
      { id: R.IS_BATTLE, name: 'is_battle', type: 'bool', default: 0, min: 0, max: 1, smoothingMs: 0 },
      {
        id: R.WEATHER,
        name: 'weather',
        type: 'enum',
        variants: ['clear', 'rain', 'storm'],
        default: 0,
        min: 0,
        max: 2,
        smoothingMs: 0,
      },
    ],
    sections: [
      {
        id: S.EXPLORE,
        name: 'Explore',
        bpm: 0,
        timeSignature: [0, 0],
        loopEnabled: true,
        lengthBeats: 8,
        loopStartBeats: 0,
        tracks: [
          track(0, 'Pad', [item(0, A.EXPLORE_PAD, 0, 8)]),
          track(1, 'Arp', [item(0, A.EXPLORE_ARP, 0, 8, { gain: 0.9 })], { pan: 0.25 }),
          // WebCLAP instrument layer, faded in continuously by the `intensity`
          // blend curve (縦遷移/vertical layering, see `blends`).
          instrTrack(2, 'Synth Lead', I.SYNTH, synthLeadNotes, { pan: -0.2 }),
          // VCSL sampler piano (real multi-sampled instrument, embedded).
          instrTrack(3, 'Piano', I.PIANO, pianoNotes, { volume: 0.9, pan: 0.1 }),
        ],
        anchors: [
          { id: 0, name: 'Entry', beat: 0 },
          { id: 1, name: 'Half', beat: 4 },
        ],
      },
      {
        id: S.BATTLE_LOW,
        name: 'Battle_Low',
        bpm: 0,
        timeSignature: [0, 0],
        loopEnabled: true,
        lengthBeats: 16,
        loopStartBeats: 0,
        tracks: [
          track(0, 'Drums', [item(0, A.BATTLE_DRUMS_LOW, 0, 16)]),
          track(1, 'Bass', [item(0, A.BATTLE_BASS, 0, 16, { gain: 0.9 })]),
        ],
        anchors: [
          { id: 0, name: 'Entry', beat: 0 },
          { id: 1, name: 'Mid', beat: 8 },
        ],
      },
      {
        id: S.BATTLE_HIGH,
        name: 'Battle_High',
        bpm: 0,
        timeSignature: [0, 0],
        loopEnabled: true,
        lengthBeats: 16,
        loopStartBeats: 0,
        tracks: [
          track(0, 'Drums', [item(0, A.BATTLE_DRUMS_HIGH, 0, 16)]),
          track(1, 'Bass', [item(0, A.BATTLE_BASS, 0, 16)]),
          track(2, 'Lead', [item(0, A.BATTLE_LEAD, 0, 16, { gain: 0.8 })], { pan: -0.15 }),
        ],
        anchors: [{ id: 0, name: 'Entry', beat: 0 }],
      },
      {
        id: S.OUTRO,
        name: 'Outro',
        bpm: 0,
        timeSignature: [0, 0],
        loopEnabled: false,
        lengthBeats: 8,
        loopStartBeats: 0,
        tracks: [track(0, 'Pad', [item(0, A.OUTRO_PAD, 0, 8, { fadeOutBeats: 2 })])],
        anchors: [],
      },
    ],
    cues: [
      {
        id: C.ON_BATTLE,
        name: 'on_battle_changed',
        rules: [
          {
            condition: "is_battle && section == 'Explore'",
            stopIfMatched: true,
            actions: [
              { type: 'goto', section: S.BATTLE_LOW, anchor: null, timing: 'nextBar', transition: 'crossfade', fadeMs: 300 },
            ],
          },
          {
            condition: "!is_battle && section != 'Explore' && section != 'Outro'",
            stopIfMatched: true,
            actions: [
              { type: 'goto', section: S.EXPLORE, anchor: null, timing: 'nextBar', transition: 'crossfade', fadeMs: 600 },
            ],
          },
        ],
      },
      {
        id: C.ON_INTENSITY,
        name: 'on_intensity_changed',
        rules: [
          // (The Explore synth-lead layer is faded by the `blends` curve now —
          // v3 vertical transitions replaced the old setTrackGain rules here.)
          {
            condition: "section == 'Battle_Low' && intensity >= 0.6",
            stopIfMatched: true,
            actions: [
              { type: 'goto', section: S.BATTLE_HIGH, anchor: null, timing: 'nextBar', transition: 'crossfade', fadeMs: 200 },
            ],
          },
          {
            condition: "section == 'Battle_High' && intensity < 0.4",
            stopIfMatched: true,
            actions: [
              { type: 'goto', section: S.BATTLE_LOW, anchor: null, timing: 'nextBar', transition: 'crossfade', fadeMs: 300 },
            ],
          },
        ],
      },
      {
        id: C.ON_WEATHER,
        name: 'on_weather_changed',
        rules: [
          {
            condition: "weather == 'storm'",
            stopIfMatched: true,
            actions: [
              { type: 'setTrackGain', section: S.EXPLORE, track: 1, gain: 0.15, fadeMs: 800 },
              { type: 'emit', code: 100 },
            ],
          },
          {
            condition: "weather == 'rain'",
            stopIfMatched: true,
            actions: [
              { type: 'setTrackGain', section: S.EXPLORE, track: 1, gain: 0.5, fadeMs: 800 },
            ],
          },
          {
            condition: '',
            stopIfMatched: false,
            actions: [
              { type: 'setTrackGain', section: S.EXPLORE, track: 1, gain: 1, fadeMs: 800 },
            ],
          },
        ],
      },
      {
        id: C.TO_ENDING,
        name: 'to_ending',
        rules: [
          {
            condition: '',
            stopIfMatched: false,
            actions: [
              { type: 'goto', section: S.OUTRO, anchor: null, timing: 'sectionEnd', transition: 'crossfade', fadeMs: 150 },
            ],
          },
        ],
      },
      {
        id: C.ON_START,
        name: 'on_module_start',
        rules: [
          {
            // Every playthrough starts a little differently. (The synth-lead
            // layer starts silent via its intensity blend curve.)
            condition: 'rand < 0.35',
            stopIfMatched: false,
            actions: [
              { type: 'play', section: S.EXPLORE, anchor: 1 },
            ],
          },
        ],
      },
      {
        id: C.STAB_ON_HIGH,
        name: 'stab_on_battle_high',
        rules: [
          {
            condition: '',
            stopIfMatched: false,
            actions: [{ type: 'oneShot', asset: A.STAB, gain: 0.8, timing: 'immediate' }],
          },
        ],
      },
    ],
    bindings: [
      { trigger: { type: 'rtpcChanged', rtpc: R.IS_BATTLE }, cue: C.ON_BATTLE },
      { trigger: { type: 'rtpcChanged', rtpc: R.INTENSITY }, cue: C.ON_INTENSITY },
      { trigger: { type: 'rtpcChanged', rtpc: R.WEATHER }, cue: C.ON_WEATHER },
      { trigger: { type: 'moduleStart' }, cue: C.ON_START },
      { trigger: { type: 'sectionStart', section: S.BATTLE_HIGH }, cue: C.STAB_ON_HIGH },
    ],
    assets: [
      { id: A.EXPLORE_PAD, name: 'explore_pad', channels: 1, sampleRate: SR, frames: 0 },
      { id: A.EXPLORE_ARP, name: 'explore_arp', channels: 1, sampleRate: SR, frames: 0 },
      { id: A.BATTLE_DRUMS_LOW, name: 'battle_drums_low', channels: 1, sampleRate: SR, frames: 0 },
      { id: A.BATTLE_DRUMS_HIGH, name: 'battle_drums_high', channels: 1, sampleRate: SR, frames: 0 },
      { id: A.BATTLE_BASS, name: 'battle_bass', channels: 1, sampleRate: SR, frames: 0 },
      { id: A.BATTLE_LEAD, name: 'battle_lead', channels: 1, sampleRate: SR, frames: 0 },
      { id: A.STAB, name: 'stab_hit', channels: 1, sampleRate: SR, frames: 0 },
      { id: A.OUTRO_PAD, name: 'outro_pad', channels: 1, sampleRate: SR, frames: 0 },
    ],
  };
}

/** Returns { project, assets } with asset frame counts filled in. */
export function makeDemo() {
  const assets = makeDemoAssets();
  const project = makeDemoProject();
  for (const meta of project.assets) {
    const a = assets.find((x) => x.id === meta.id);
    meta.frames = a.frames;
  }
  return { project, assets };
}
