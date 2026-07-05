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
 * tracks and bridge transitions; 2 -> 3 to add vertical blend curves (BLND),
 * plugin parameter modulation (PMOD), note-generator routing (NSRC), and the
 * timed/track-level transition actions. Decoders accept 2 and 3; encoders
 * always write 3.
 */
export const PACK_VERSION = 3;
/** Oldest pack version the v3 decoders still accept. */
export const MIN_PACK_VERSION = 2;
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

/** A point on a piecewise-linear curve; `x` values must be ascending. */
export interface CurvePoint {
  x: number;
  y: number;
}

/**
 * A vertical blend: a continuous RTPC -> track-gain mapping evaluated by the
 * engine every block (piecewise-linear in the smoothed RTPC value, clamped
 * outside the point range). Multiplies with track volume, cue gain overrides
 * and the player fade.
 */
export interface BlendCurve {
  id: number;
  /** Rtpc.id driving the curve. */
  rtpc: number;
  /** Section owning the target track. */
  section: number;
  /** Track whose gain is modulated. */
  track: number;
  /** At least one point; x ascending. */
  points: CurvePoint[];
}

/**
 * RTPC -> CLAP plugin parameter modulation, applied host-side (the engine
 * skips the PMOD chunk like WCLP/PINS). Drives generative plugins from game
 * state.
 */
export interface ParamMod {
  /** PluginInstance.id receiving the parameter changes. */
  instance: number;
  /** CLAP parameter id. */
  param: number;
  /** Rtpc.id driving the curve. */
  rtpc: number;
  /** At least one point; x ascending. y is the raw CLAP parameter value. */
  points: CurvePoint[];
}

/**
 * Routes the CLAP note output of a generator plugin instance into an
 * instrument plugin instance (host-side; NSRC chunk).
 */
export interface NoteSource {
  /** PluginInstance.id whose note output events are captured. */
  generator: number;
  /** PluginInstance.id that receives the generated notes. */
  target: number;
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
  | {
      type: 'setTrackGain';
      section: number;
      track: number;
      gain: number;
      fadeMs: number;
      /**
       * When to apply the gain change (v3). Omitted/'immediate' keeps the v2
       * behavior (smoothing starts right away); other values quantize the
       * change to the next beat/bar or the section end.
       */
      timing?: TimingName;
      /**
       * Optional value expression (v3, see docs/03_cue_vm_spec.md). When set,
       * the gain is computed by evaluating this expression at fire time and
       * `gain` is ignored.
       */
      gainExpr?: string;
    }
  | {
      /**
       * Track-level transition (v3): retarget one track of the playing
       * section to the content of another section's track, beat-synced to the
       * current timeline, while the other tracks keep playing.
       */
      type: 'gotoTrack';
      /** Destination section (must be the playing section to take effect). */
      section: number;
      /** Track of `section` whose content is replaced. */
      track: number;
      /** Source section supplying the content; null clears the override. */
      sourceSection: number | null;
      /** Track within `sourceSection` (ignored when clearing). */
      sourceTrack: number | null;
      timing: TimingName;
      transition: TransitionName;
      fadeMs: number;
    }
  | { type: 'setLoop'; section: number; enabled: boolean }
  | { type: 'emit'; code: number }
  | {
      type: 'setRtpc';
      rtpc: number;
      value: number;
      /** Optional value expression (v3); when set, `value` is ignored. */
      valueExpr?: string;
    }
  | {
      /**
       * Set a CLAP plugin parameter (v3). The engine only forwards this as a
       * PluginParam event; the JS host applies it to the plugin rack.
       */
      type: 'setPluginParam';
      /** PluginInstance.id. */
      instance: number;
      /** CLAP parameter id. */
      param: number;
      value: number;
      /** Optional value expression (v3); when set, `value` is ignored. */
      valueExpr?: string;
    }
  | { type: 'oneShot'; asset: number; gain: number; timing: TimingName };

// ---------------------------------------------------------------------------
// Script graphs (v3 authoring model)
// ---------------------------------------------------------------------------

/**
 * Node kinds of the visual script graph. Trigger nodes start an execution
 * chain (compiled to a Binding + generated Cue), action nodes emit CueActions
 * in chain order, value/logic nodes are synthesized into condition/value
 * expressions (docs/03_cue_vm_spec.md) so the distribution format stays plain
 * Cue VM bytecode.
 */
export type GraphNodeKind =
  // Triggers (exec output port 'out')
  | 'onModuleStart'
  | 'onRtpcChanged'
  | 'onBar'
  | 'onBeat'
  | 'onSectionStart'
  | 'onSectionEnd'
  | 'onAnchor'
  | 'onManualCue'
  // Values (value output port 'value')
  | 'rtpcValue'
  | 'constant'
  | 'sectionRef'
  | 'currentSection'
  | 'positionBeats'
  | 'random'
  | 'math'
  /** Raw expression text (docs/03 language) — escape hatch & cue migration. */
  | 'expr'
  // Logic
  | 'compare'
  | 'and'
  | 'or'
  | 'not'
  // Flow (exec in 'in', value in 'cond', exec outs 'then'/'else')
  | 'branch'
  // Actions (exec in 'in', exec out 'out'; some take value inputs)
  | 'goto'
  | 'gotoRandom'
  | 'gotoTrack'
  | 'setTrackGain'
  | 'setLoop'
  | 'setRtpc'
  | 'setPluginParam'
  | 'emit'
  | 'stop'
  | 'oneShot';

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  /** Editor canvas position. */
  x: number;
  y: number;
  /** Kind-specific configuration (ids reference project entities). */
  data: Record<string, unknown>;
}

export interface GraphEdge {
  from: string;
  /** Source port: 'out' | 'then' | 'else' for exec, 'value' for values. */
  fromPort: string;
  to: string;
  /** Target port: 'in' for exec; value port name otherwise (e.g. 'a', 'b',
   *  'cond', 'value', 'gain'). */
  toPort: string;
}

/** A visual script graph, stored in META and compiled at export time. */
export interface ScriptGraph {
  id: number;
  name: string;
  /** Disabled graphs are kept in META but not compiled. */
  enabled?: boolean;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

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
  /** Vertical blend curves (v3, BLND chunk). */
  blends?: BlendCurve[];
  /** RTPC -> plugin parameter modulations (v3, PMOD chunk). */
  paramMods?: ParamMod[];
  /** Note-generator routings (v3, NSRC chunk). */
  noteSources?: NoteSource[];
  /**
   * Visual script graphs (v3). Authoring-only: stored in META and compiled
   * into generated cues/bindings at export (see graph.ts / compileGraphs).
   */
  graphs?: ScriptGraph[];
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

/**
 * Fills in fields that may be absent when loading an older project (e.g. a v1
 * META re-import), so consumers can rely on the v2 arrays existing. Mutates and
 * returns the same object.
 */
export function normalizeProject(project: IamProject): IamProject {
  project.plugins ??= [];
  project.pluginInstances ??= [];
  project.masterEffects ??= [];
  project.blends ??= [];
  project.paramMods ??= [];
  project.noteSources ??= [];
  project.graphs ??= [];
  for (const s of project.sections) {
    for (const t of s.tracks) {
      t.kind ??= 'audio';
      t.items ??= [];
      if (t.kind === 'instrument') t.notes ??= [];
    }
  }
  return project;
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
  /** a=instance id, b=CLAP param id, c=value (v3, applied by the JS host). */
  PluginParam: 9,
  /** a=dest track id, b=source section id (NONE_ID=cleared), c=source track id (v3). */
  TrackGoto: 10,
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
