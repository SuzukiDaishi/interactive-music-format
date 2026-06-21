/**
 * Authoring/runtime data model for the Interactive Audio Module format.
 *
 * This model maps 1:1 onto the IAMP binary pack (docs/02_iam_pack_spec.md).
 * All cross references use numeric ids; `null` means "none" and is encoded
 * as 0xFFFFFFFF.
 */

export const PACK_MAGIC = 'IAMP';
/**
 * Binary pack version. Bumped 1 -> 2 to add WCLAP plugins, instrument (MIDI)
 * tracks and bridge transitions. v1 modules must be re-exported from their META
 * chunk to load on a v2 engine.
 */
export const PACK_VERSION = 2;
export const NONE_ID = 0xffffffff;

/** Name of the WASM custom section that carries the IAMP pack. */
export const WASM_PACK_SECTION = 'iam.pack';

export type RtpcType = 'f32' | 'bool' | 'enum';

export interface Rtpc {
  id: number;
  name: string;
  type: RtpcType;
  /** Only for type === 'enum'. */
  variants?: string[];
  default: number;
  min: number;
  max: number;
  /** Linear smoothing time applied to value changes (0 = immediate). */
  smoothingMs: number;
}

export interface Item {
  id: number;
  assetId: number;
  startBeat: number;
  lengthBeats: number;
  /** Offset into the asset, in beats. */
  offsetBeats: number;
  gain: number;
  fadeInBeats: number;
  fadeOutBeats: number;
}

/** A MIDI note placed on an instrument track's beat timeline. */
export interface MidiNote {
  /** Note-on position within the section, in beats. */
  startBeat: number;
  /** Note duration in beats (note-off fires at startBeat + lengthBeats). */
  lengthBeats: number;
  /** MIDI key 0..127. */
  key: number;
  /** Normalized velocity 0..1. */
  velocity: number;
  /** MIDI channel 0..15. */
  channel: number;
}

export type TrackKind = 'audio' | 'instrument';

export interface Track {
  id: number;
  name: string;
  volume: number;
  /** -1 (left) .. 1 (right) */
  pan: number;
  muted: boolean;
  items: Item[];
  /**
   * 'audio' (default) mixes PCM `items`; 'instrument' sequences `notes` into the
   * plugin instance referenced by `instrument`. Omitted = 'audio'.
   */
  kind?: TrackKind;
  /** Plugin instance id driven by this track's notes (instrument tracks). */
  instrument?: number | null;
  /** MIDI notes for instrument tracks. */
  notes?: MidiNote[];
  /** Insert effect chain: ordered plugin instance ids applied to this track. */
  effects?: number[];
}

/** A CLAP parameter value carried with a plugin instance. */
export interface PluginParam {
  /** CLAP parameter id. */
  id: number;
  value: number;
}

/**
 * A WCLAP (WebCLAP) plugin bank entry. The binary `.wclap` artifact may be
 * embedded in the WCLP chunk (keyed by `id`) and/or fetched from `url`.
 */
export interface WclapPlugin {
  id: number;
  name: string;
  /**
   * Default CLAP plugin id within the bundle (a `.wclap` may expose several).
   * Matches an entry of the bundle manifest's `plugins[]`.
   */
  clapPluginId?: string;
  /** Fallback download URL (e.g. a Plinken shelf.json artifact). */
  url?: string;
  /** Whether the binary artifact is embedded in the WCLP chunk. */
  embedded: boolean;
}

/** An instantiable plugin: a bank plugin plus initial parameter values. */
export interface PluginInstance {
  id: number;
  /** WclapPlugin.id this instance comes from. */
  pluginBankId: number;
  /** CLAP plugin id within the bundle; defaults to the bank plugin's. */
  clapPluginId?: string;
  params: PluginParam[];
}

export interface Anchor {
  id: number;
  name: string;
  beat: number;
}

export interface Section {
  id: number;
  name: string;
  /** 0 = inherit project BPM. */
  bpm: number;
  /** [0, 0] = inherit project time signature. */
  timeSignature: [number, number];
  loopEnabled: boolean;
  lengthBeats: number;
  loopStartBeats: number;
  tracks: Track[];
  anchors: Anchor[];
}

export type TimingName = 'immediate' | 'nextBeat' | 'nextBar' | 'sectionEnd';
export type TransitionName = 'cut' | 'crossfade';

export type CueAction =
  | {
      type: 'goto';
      section: number;
      anchor: number | null;
      timing: TimingName;
      transition: TransitionName;
      fadeMs: number;
      /**
       * Optional one-shot bridge/transition section played between source and
       * destination. When set, the transition routes A -> bridge -> section.
       * `null`/omitted = direct transition.
       */
      bridge?: number | null;
    }
  | {
      type: 'gotoRandom';
      timing: TimingName;
      transition: TransitionName;
      fadeMs: number;
      targets: { section: number; anchor: number | null; weight: number }[];
      /** Optional bridge section played before the chosen destination. */
      bridge?: number | null;
    }
  | { type: 'play'; section: number; anchor: number | null }
  | { type: 'stop'; timing: TimingName; fadeMs: number }
  | { type: 'setTrackGain'; section: number; track: number; gain: number; fadeMs: number }
  | { type: 'setLoop'; section: number; enabled: boolean }
  | { type: 'emit'; code: number }
  | { type: 'setRtpc'; rtpc: number; value: number }
  | { type: 'oneShot'; asset: number; gain: number; timing: TimingName };

export interface CueRule {
  /**
   * Condition expression source (see docs/03_cue_vm_spec.md), e.g.
   * `intensity >= 0.7 && section != 'Battle_High'`. Empty = always true.
   */
  condition: string;
  /** When this rule matches, skip the remaining rules of the cue. */
  stopIfMatched: boolean;
  actions: CueAction[];
}

export interface Cue {
  id: number;
  name: string;
  rules: CueRule[];
}

export type BindingTrigger =
  | { type: 'rtpcChanged'; rtpc: number }
  | { type: 'sectionStart'; section: number | null }
  | { type: 'sectionEnd'; section: number | null }
  | { type: 'anchorReached'; section: number; anchor: number }
  | { type: 'bar'; section: number | null }
  | { type: 'beat'; section: number | null }
  | { type: 'moduleStart' };

export interface Binding {
  trigger: BindingTrigger;
  cue: number;
}

/** Asset metadata as stored in the project (sample data lives elsewhere). */
export interface AssetMeta {
  id: number;
  name: string;
  channels: 1 | 2;
  sampleRate: number;
  frames: number;
}

export interface IamProject {
  formatVersion: 1;
  name: string;
  /** Sample rate of the beat<->sample timeline and of bank assets. */
  bankSampleRate: number;
  bpm: number;
  timeSignature: [number, number];
  startSectionId: number | null;
  rtpcs: Rtpc[];
  sections: Section[];
  cues: Cue[];
  bindings: Binding[];
  assets: AssetMeta[];
  /** WCLAP plugin bank. */
  plugins: WclapPlugin[];
  /** Instantiated plugins (bank plugin + parameter values). */
  pluginInstances: PluginInstance[];
  /** Master bus effect chain: ordered plugin instance ids. */
  masterEffects: number[];
}

export type AssetFormat = 'pcm16' | 'f32';

/** Asset with its sample data, used when encoding a pack. */
export interface EncodeAsset {
  id: number;
  name: string;
  channels: 1 | 2;
  sampleRate: number;
  frames: number;
  format: AssetFormat;
  /** Interleaved samples; Int16Array for pcm16, Float32Array for f32. */
  data: Int16Array | Float32Array;
}

export function emptyProject(name = 'Untitled'): IamProject {
  return {
    formatVersion: 1,
    name,
    bankSampleRate: 48000,
    bpm: 120,
    timeSignature: [4, 4],
    startSectionId: null,
    rtpcs: [],
    sections: [],
    cues: [],
    bindings: [],
    assets: [],
    plugins: [],
    pluginInstances: [],
    masterEffects: [],
  };
}

/** A WCLAP plugin with its binary artifact, used when encoding a pack. */
export interface EncodePlugin {
  id: number;
  name: string;
  clapPluginId?: string;
  url?: string;
  /** Raw `.wclap` bundle bytes to embed; omit to reference `url` only. */
  data?: Uint8Array;
}

export const TIMING_CODE: Record<TimingName, number> = {
  immediate: 0,
  nextBeat: 1,
  nextBar: 2,
  sectionEnd: 3,
};

export const RTPC_TYPE_CODE: Record<RtpcType, number> = {
  f32: 0,
  bool: 1,
  enum: 2,
};

/** Engine event types delivered through iam_poll_event. */
export const EventType = {
  SectionChanged: 1,
  CueFired: 2,
  GotoScheduled: 3,
  Emit: 4,
  Ended: 5,
  Looped: 6,
  OneShot: 7,
  RtpcChanged: 8,
} as const;

export interface IamEvent {
  type: number;
  a: number;
  b: number;
  c: number;
}

/** Status byte values for MIDI events delivered through iam_poll_midi. */
export const MidiStatus = {
  NoteOff: 0,
  NoteOn: 1,
} as const;

/** A sample-accurate MIDI event emitted by the engine for an instrument track. */
export interface IamMidiEvent {
  /** Plugin instance id this event is routed to (track.instrument). */
  instanceId: number;
  /** Sample offset from the start of the current process() block. */
  frameOffset: number;
  /** One of MidiStatus. */
  status: number;
  /** MIDI key 0..127. */
  key: number;
  /** Normalized velocity 0..1. */
  velocity: number;
}
