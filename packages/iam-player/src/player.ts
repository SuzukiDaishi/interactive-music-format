/**
 * High-level browser player for .iam.wasm files (AudioWorklet based).
 *
 *   const ctx = new AudioContext();
 *   const music = await IamPlayer.load('battle.iam.wasm', ctx);
 *   music.node.connect(ctx.destination);
 *   music.play();
 *   music.setRtpc('intensity', 0.8);
 */

import { DecodedPack, decodePack, extractPack, IamEvent, NONE_ID, EventType } from '@iam/pack';
import { IAM_PROCESSOR_NAME, IAM_WORKLET_SOURCE } from './worklet.js';
import { loadWclapBundle } from './wclap/bundle.js';
import { planRack } from './wclap/resolve.js';

interface WorkletPluginSpec {
  instanceId: number;
  module: WebAssembly.Module;
  clapPluginId?: string;
  params: { id: number; value: number }[];
  audioInputs: 0 | 1;
}

export interface NamedEvent extends IamEvent {
  /** Human-readable event name. */
  kind:
    | 'sectionChanged'
    | 'cueFired'
    | 'gotoScheduled'
    | 'emit'
    | 'ended'
    | 'looped'
    | 'oneShot'
    | 'rtpcChanged'
    | 'unknown';
  /** Resolved names where applicable (section/cue/rtpc names). */
  fromName?: string | null;
  toName?: string | null;
  name?: string | null;
}

export interface IamPlayerStatus {
  sectionId: number;
  sectionName: string | null;
  positionBeats: number;
  playing: boolean;
  rate: number;
}

const registeredContexts = new WeakSet<BaseAudioContext>();

export class IamPlayer {
  readonly node: AudioWorkletNode;
  readonly meta: DecodedPack;
  status: IamPlayerStatus = {
    sectionId: NONE_ID,
    sectionName: null,
    positionBeats: 0,
    playing: false,
    rate: 1,
  };

  private listeners = new Set<(e: NamedEvent) => void>();
  private statusListeners = new Set<(s: IamPlayerStatus) => void>();

  private constructor(node: AudioWorkletNode, meta: DecodedPack) {
    this.node = node;
    this.meta = meta;
    node.port.onmessage = (e) => this.onMessage(e.data);
  }

  /**
   * Loads a .iam.wasm from a URL or raw bytes and creates a worklet node
   * on the given context. Connect `player.node` to your graph.
   */
  static async load(
    source: string | URL | ArrayBuffer | Uint8Array,
    ctx: BaseAudioContext,
  ): Promise<IamPlayer> {
    let bytes: Uint8Array;
    if (typeof source === 'string' || source instanceof URL) {
      const res = await fetch(source);
      if (!res.ok) throw new Error(`Failed to fetch module: ${res.status}`);
      bytes = new Uint8Array(await res.arrayBuffer());
    } else if (source instanceof ArrayBuffer) {
      bytes = new Uint8Array(source);
    } else {
      bytes = source;
    }

    const pack = extractPack(bytes);
    if (!pack) throw new Error('No iam.pack section: not a .iam.wasm file');
    const meta = decodePack(pack);
    const module = await WebAssembly.compile(
      bytes.buffer instanceof ArrayBuffer && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? bytes.buffer
        : bytes.slice().buffer as ArrayBuffer,
    );

    if (!registeredContexts.has(ctx)) {
      const url = URL.createObjectURL(
        new Blob([IAM_WORKLET_SOURCE], { type: 'application/javascript' }),
      );
      try {
        await ctx.audioWorklet.addModule(url);
      } finally {
        URL.revokeObjectURL(url);
      }
      registeredContexts.add(ctx);
    }

    // Resolve any WCLAP plugins (instrument synths + effects) so the worklet can
    // host them. Failure degrades gracefully to engine PCM only.
    let plugins: WorkletPluginSpec[] | undefined;
    let routing: unknown;
    try {
      const resolved = await IamPlayer.resolvePlugins(meta);
      if (resolved) {
        plugins = resolved.plugins;
        routing = resolved.routing;
      }
    } catch {
      plugins = undefined;
    }

    const node = new AudioWorkletNode(ctx, IAM_PROCESSOR_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: { module, pack, plugins, routing },
    });

    const player = new IamPlayer(node, meta);
    await player.waitReady();
    return player;
  }

  /**
   * Resolves the WCLAP plugin bank for the worklet: compiles each used bundle
   * (embedded bytes, else fetched URL) and computes instrument/effect routing.
   */
  private static async resolvePlugins(
    meta: DecodedPack,
  ): Promise<{ plugins: WorkletPluginSpec[]; routing: unknown } | null> {
    const project = meta.project;
    if (!project) return null;
    const plan = planRack(project);
    if (!plan) return null;

    const moduleCache = new Map<number, WebAssembly.Module>();
    const plugins: WorkletPluginSpec[] = [];
    for (const inst of plan.instances) {
      let module = moduleCache.get(inst.pluginBankId);
      if (!module) {
        const decoded = meta.plugins.find((p) => p.id === inst.pluginBankId);
        const banked = project.plugins.find((p) => p.id === inst.pluginBankId);
        let bytes: Uint8Array | undefined;
        if (decoded?.embedded && decoded.data) {
          bytes = decoded.data;
        } else {
          const url = decoded?.url || banked?.url;
          if (!url) continue;
          const res = await fetch(url);
          if (!res.ok) continue;
          bytes = new Uint8Array(await res.arrayBuffer());
        }
        const { moduleBytes } = await loadWclapBundle(bytes);
        module = await WebAssembly.compile(
          moduleBytes.buffer.slice(
            moduleBytes.byteOffset,
            moduleBytes.byteOffset + moduleBytes.byteLength,
          ) as ArrayBuffer,
        );
        moduleCache.set(inst.pluginBankId, module);
      }
      plugins.push({
        instanceId: inst.instanceId,
        module,
        clapPluginId: inst.clapPluginId,
        params: inst.params,
        audioInputs: inst.audioInputs,
      });
    }
    return { plugins, routing: plan.routing };
  }

  private readyResolve?: () => void;
  private readyReject?: (e: Error) => void;
  private ready = false;

  private waitReady(): Promise<void> {
    if (this.ready) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
  }

  private onMessage(m: { type: string } & Record<string, unknown>) {
    if (m.type === 'ready') {
      this.ready = true;
      this.readyResolve?.();
      return;
    }
    if (m.type === 'error') {
      this.readyReject?.(new Error(String(m.message)));
      return;
    }
    if (m.type === 'tick') {
      const sectionId = m.section as number;
      this.status = {
        sectionId,
        sectionName: this.sectionName(sectionId),
        positionBeats: m.beats as number,
        playing: m.playing as boolean,
        rate: m.rate as number,
      };
      for (const s of this.statusListeners) s(this.status);
      for (const raw of m.events as IamEvent[]) {
        const named = this.nameEvent(raw);
        for (const l of this.listeners) l(named);
      }
    }
  }

  private sectionName(id: number): string | null {
    if (id === NONE_ID) return null;
    return this.meta.sections.find((s) => s.id === id)?.name ?? null;
  }

  private nameEvent(e: IamEvent): NamedEvent {
    switch (e.type) {
      case EventType.SectionChanged:
        return {
          ...e,
          kind: 'sectionChanged',
          fromName: this.sectionName(e.a),
          toName: this.sectionName(e.b),
        };
      case EventType.CueFired:
        return {
          ...e,
          kind: 'cueFired',
          name: this.meta.cues.find((c) => c.id === e.a)?.name ?? null,
        };
      case EventType.GotoScheduled:
        return { ...e, kind: 'gotoScheduled', toName: this.sectionName(e.a) };
      case EventType.Emit:
        return { ...e, kind: 'emit' };
      case EventType.Ended:
        return { ...e, kind: 'ended' };
      case EventType.Looped:
        return { ...e, kind: 'looped', name: this.sectionName(e.a) };
      case EventType.OneShot:
        return { ...e, kind: 'oneShot' };
      case EventType.RtpcChanged:
        return {
          ...e,
          kind: 'rtpcChanged',
          name: this.meta.rtpcs.find((r) => r.id === e.a)?.name ?? null,
        };
      default:
        return { ...e, kind: 'unknown' };
    }
  }

  // -- control -----------------------------------------------------------

  private post(msg: Record<string, unknown>) {
    this.node.port.postMessage(msg);
  }

  play(): void {
    this.post({ type: 'play' });
  }

  playSection(section: string | number, anchor?: string | number): void {
    const sid = typeof section === 'string' ? this.resolveSection(section) : section;
    let aid = NONE_ID;
    if (anchor !== undefined) {
      if (typeof anchor === 'number') {
        aid = anchor;
      } else {
        const s = this.meta.sections.find((x) => x.id === sid);
        const a = s?.anchors.find((x) => x.name === anchor);
        if (!a) throw new Error(`Unknown anchor '${anchor}'`);
        aid = a.id;
      }
    }
    this.post({ type: 'playSection', section: sid, anchor: aid });
  }

  stop(fadeMs = 0): void {
    this.post({ type: 'stop', fadeMs });
  }

  pause(): void {
    this.post({ type: 'pause' });
  }

  resume(): void {
    this.post({ type: 'resume' });
  }

  /** Playback rate; negative values play in reverse. Clamped to [-4, 4]. */
  setRate(rate: number): void {
    this.post({ type: 'rate', value: rate });
  }

  seekBeats(beats: number): void {
    this.post({ type: 'seek', beats });
  }

  /**
   * Live mixer: change a track's volume/pan/mute during playback without
   * rebuilding the module. Applies to PCM and instrument (synth) tracks alike.
   */
  setTrackVolume(sectionId: number, trackId: number, value: number): void {
    this.post({ type: 'trackVolume', section: sectionId, track: trackId, value });
  }

  setTrackPan(sectionId: number, trackId: number, value: number): void {
    this.post({ type: 'trackPan', section: sectionId, track: trackId, value });
  }

  setTrackMute(sectionId: number, trackId: number, muted: boolean): void {
    this.post({ type: 'trackMute', section: sectionId, track: trackId, muted });
  }

  setSeed(seed: number): void {
    this.post({ type: 'seed', value: seed });
  }

  triggerCue(cue: string | number): void {
    const id =
      typeof cue === 'string'
        ? this.meta.cues.find((c) => c.name === cue)?.id
        : cue;
    if (id === undefined) throw new Error(`Unknown cue '${cue}'`);
    this.post({ type: 'cue', id });
  }

  setRtpc(rtpc: string | number, value: number | boolean | string): void {
    const def =
      typeof rtpc === 'string'
        ? this.meta.rtpcs.find((r) => r.name === rtpc)
        : this.meta.rtpcs.find((r) => r.id === rtpc);
    if (!def) throw new Error(`Unknown RTPC '${rtpc}'`);
    let v: number;
    if (typeof value === 'boolean') {
      v = value ? 1 : 0;
    } else if (typeof value === 'string') {
      const idx = def.variants.indexOf(value);
      if (idx < 0) throw new Error(`Unknown enum variant '${value}'`);
      v = idx;
    } else {
      v = value;
    }
    this.post({ type: 'rtpc', id: def.id, value: v });
  }

  private resolveSection(name: string): number {
    const s = this.meta.sections.find((x) => x.name === name);
    if (!s) throw new Error(`Unknown section '${name}'`);
    return s.id;
  }

  // -- events --------------------------------------------------------------

  onEvent(cb: (e: NamedEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onStatus(cb: (s: IamPlayerStatus) => void): () => void {
    this.statusListeners.add(cb);
    return () => this.statusListeners.delete(cb);
  }

  dispose(): void {
    this.node.port.onmessage = null;
    this.node.disconnect();
    this.listeners.clear();
    this.statusListeners.clear();
  }
}
