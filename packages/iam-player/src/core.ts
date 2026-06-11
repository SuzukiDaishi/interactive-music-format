/**
 * Synchronous core wrapper around an instantiated IAM engine.
 *
 * Environment-agnostic: works on the main thread, inside an
 * AudioWorkletGlobalScope, and in Node.js (offline rendering / tests).
 */

import {
  DecodedPack,
  decodePack,
  extractPack,
  IamEvent,
  NONE_ID,
} from '@iam/pack';

export interface EngineExports {
  memory: WebAssembly.Memory;
  iam_abi_version(): number;
  iam_alloc(size: number): number;
  iam_free(ptr: number, size: number): void;
  iam_load_pack(ptr: number, len: number): number;
  iam_init(sampleRate: number, channels: number): number;
  iam_play(): void;
  iam_play_section(sectionId: number, anchorId: number): void;
  iam_stop(fadeMs: number): void;
  iam_pause(): void;
  iam_resume(): void;
  iam_is_playing(): number;
  iam_process(outPtr: number, frames: number): void;
  iam_trigger_cue(cueId: number): void;
  iam_set_rtpc(rtpcId: number, value: number): void;
  iam_get_rtpc(rtpcId: number): number;
  iam_set_rate(rate: number): void;
  iam_get_rate(): number;
  iam_seek_beats(beats: number): void;
  iam_set_seed(seed: number): void;
  iam_get_section(): number;
  iam_get_position_beats(): number;
  iam_get_position_samples(): number;
  iam_poll_event(outPtr: number): number;
}

const LOAD_ERRORS: Record<number, string> = {
  [-1]: 'invalid arguments',
  [-2]: 'pack too short',
  [-3]: 'bad magic (not an IAMP pack)',
  [-4]: 'unsupported pack version',
  [-5]: 'corrupt pack data',
  [-6]: 'missing PROJ chunk',
  [-7]: 'broken reference in pack',
};

/**
 * Low-level synchronous module. Construct via {@link IamCore.create} with
 * the raw bytes of a .iam.wasm file.
 */
export class IamCore {
  private outPtr = 0;
  private outCap = 0;
  private eventPtr: number;
  private channels = 2;

  private constructor(
    public readonly exports: EngineExports,
    public readonly meta: DecodedPack,
  ) {
    this.eventPtr = exports.iam_alloc(16);
  }

  /** Instantiates the engine and loads the embedded pack. */
  static async create(iamWasmBytes: Uint8Array): Promise<IamCore> {
    const pack = extractPack(iamWasmBytes);
    if (!pack) throw new Error('No iam.pack section found: not a .iam.wasm file');
    const { instance } = await WebAssembly.instantiate(toBuffer(iamWasmBytes), {});
    return IamCore.fromInstance(instance, pack);
  }

  /**
   * Synchronous variant for AudioWorklet use: instantiate from a
   * precompiled module plus the pack bytes extracted on the main thread.
   */
  static fromModule(module: WebAssembly.Module, pack: Uint8Array): IamCore {
    const instance = new WebAssembly.Instance(module, {});
    return IamCore.fromInstance(instance, pack);
  }

  private static fromInstance(instance: WebAssembly.Instance, pack: Uint8Array): IamCore {
    const exports = instance.exports as unknown as EngineExports;
    if (typeof exports.iam_abi_version !== 'function' || exports.iam_abi_version() !== 1) {
      throw new Error('Unsupported IAM engine ABI version');
    }
    const ptr = exports.iam_alloc(pack.length);
    new Uint8Array(exports.memory.buffer, ptr, pack.length).set(pack);
    const rc = exports.iam_load_pack(ptr, pack.length);
    exports.iam_free(ptr, pack.length);
    if (rc !== 0) {
      throw new Error(`iam_load_pack failed: ${LOAD_ERRORS[rc] ?? `error ${rc}`}`);
    }
    return new IamCore(exports, decodePack(pack));
  }

  init(sampleRate: number, channels: 1 | 2 = 2): void {
    const rc = this.exports.iam_init(sampleRate, channels);
    if (rc !== 0) throw new Error(`iam_init failed (${rc})`);
    this.channels = channels;
  }

  // -- name/id resolution --------------------------------------------------

  sectionId(name: string): number {
    const s = this.meta.sections.find((x) => x.name === name);
    if (!s) throw new Error(`Unknown section '${name}'`);
    return s.id;
  }

  sectionName(id: number): string | null {
    if (id === NONE_ID) return null;
    return this.meta.sections.find((x) => x.id === id)?.name ?? null;
  }

  rtpcId(name: string): number {
    const r = this.meta.rtpcs.find((x) => x.name === name);
    if (!r) throw new Error(`Unknown RTPC '${name}'`);
    return r.id;
  }

  cueId(name: string): number {
    const c = this.meta.cues.find((x) => x.name === name);
    if (!c) throw new Error(`Unknown cue '${name}'`);
    return c.id;
  }

  // -- transport -------------------------------------------------------------

  play(): void {
    this.exports.iam_play();
  }

  playSection(section: string | number, anchor?: string | number): void {
    const sid = typeof section === 'string' ? this.sectionId(section) : section;
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
    this.exports.iam_play_section(sid, aid);
  }

  stop(fadeMs = 0): void {
    this.exports.iam_stop(fadeMs);
  }

  pause(): void {
    this.exports.iam_pause();
  }

  resume(): void {
    this.exports.iam_resume();
  }

  get playing(): boolean {
    return this.exports.iam_is_playing() !== 0;
  }

  setRate(rate: number): void {
    this.exports.iam_set_rate(rate);
  }

  get rate(): number {
    return this.exports.iam_get_rate();
  }

  seekBeats(beats: number): void {
    this.exports.iam_seek_beats(beats);
  }

  setSeed(seed: number): void {
    this.exports.iam_set_seed(seed);
  }

  triggerCue(cue: string | number): void {
    this.exports.iam_trigger_cue(typeof cue === 'string' ? this.cueId(cue) : cue);
  }

  setRtpc(rtpc: string | number, value: number | boolean | string): void {
    const id = typeof rtpc === 'string' ? this.rtpcId(rtpc) : rtpc;
    let v: number;
    if (typeof value === 'boolean') {
      v = value ? 1 : 0;
    } else if (typeof value === 'string') {
      const r = this.meta.rtpcs.find((x) => x.id === id);
      const idx = r?.variants.indexOf(value) ?? -1;
      if (idx < 0) throw new Error(`Unknown enum variant '${value}'`);
      v = idx;
    } else {
      v = value;
    }
    this.exports.iam_set_rtpc(id, v);
  }

  getRtpc(rtpc: string | number): number {
    const id = typeof rtpc === 'string' ? this.rtpcId(rtpc) : rtpc;
    return this.exports.iam_get_rtpc(id);
  }

  get currentSection(): string | null {
    return this.sectionName(this.exports.iam_get_section());
  }

  get currentSectionId(): number {
    return this.exports.iam_get_section();
  }

  get positionBeats(): number {
    return this.exports.iam_get_position_beats();
  }

  get positionSeconds(): number {
    return this.exports.iam_get_position_samples() / this.meta.bankSampleRate;
  }

  // -- audio & events --------------------------------------------------------

  /** Renders `frames` interleaved f32 frames. The returned view is valid
   *  until the next call into the module. */
  render(frames: number): Float32Array {
    const need = frames * this.channels * 4;
    if (need > this.outCap) {
      if (this.outPtr) this.exports.iam_free(this.outPtr, this.outCap);
      this.outCap = need;
      this.outPtr = this.exports.iam_alloc(need);
    }
    this.exports.iam_process(this.outPtr, frames);
    return new Float32Array(this.exports.memory.buffer, this.outPtr, frames * this.channels);
  }

  pollEvent(): IamEvent | null {
    if (this.exports.iam_poll_event(this.eventPtr) === 0) return null;
    const v = new DataView(this.exports.memory.buffer, this.eventPtr, 16);
    return {
      type: v.getUint32(0, true),
      a: v.getUint32(4, true),
      b: v.getUint32(8, true),
      c: v.getFloat32(12, true),
    };
  }

  pollEvents(): IamEvent[] {
    const out: IamEvent[] = [];
    for (;;) {
      const e = this.pollEvent();
      if (!e) break;
      out.push(e);
    }
    return out;
  }
}

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer as ArrayBuffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}
