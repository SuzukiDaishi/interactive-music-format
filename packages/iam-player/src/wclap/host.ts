/**
 * A minimal CLAP host for WCLAP plugins, small enough to run inside an
 * AudioWorklet. It drives the real CLAP wasm32 ABI: instantiate `module.wasm`,
 * resolve `clap_entry` -> plugin factory -> plugin, activate it and call
 * `process()` per audio block with note/parameter events.
 *
 * Host callbacks (`clap_host`, `clap_input_events`, `clap_output_events`) are
 * provided through a tiny generated wasm trampoline whose exported functions are
 * placed into the plugin's indirect function table — `WebAssembly.Function` is
 * not required, so this works in browsers and Node alike.
 */

// CLAP event constants.
const EVENT_NOTE_ON = 0;
const EVENT_NOTE_OFF = 1;
const EVENT_PARAM_VALUE = 5;
const SIZE_NOTE = 40;
const SIZE_PARAM = 48;

// clap_plugin struct member offsets (function-pointer table indices).
const PL_INIT = 8;
const PL_ACTIVATE = 16;
const PL_START = 24;
const PL_STOP = 28;
const PL_PROCESS = 36;

/** LEB128 unsigned encode. */
function uleb(n: number): number[] {
  const out: number[] = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
}

/**
 * Builds a wasm module exposing 7 host-callback trampolines that forward to
 * imported JS functions (`h.*`). Compiled once and reused per instance.
 */
export function buildTrampolineModule(): WebAssembly.Module {
  // Param/result types: A=(i32,i32)->i32, B=(i32)->(), C=(i32)->i32
  const types: [number[], number[]][] = [
    [[0x7f, 0x7f], [0x7f]],
    [[0x7f], []],
    [[0x7f], [0x7f]],
  ];
  // import/export order; the clap_host + event-list callbacks.
  const fns: [string, number][] = [
    ['get_extension', 0],
    ['req_restart', 1],
    ['req_process', 1],
    ['req_callback', 1],
    ['inev_size', 2],
    ['inev_get', 0],
    ['outev_push', 0],
  ];
  const enc = new TextEncoder();
  const sec = (id: number, payload: number[]) => [id, ...uleb(payload.length), ...payload];

  const tsec: number[] = [...uleb(types.length)];
  for (const [p, r] of types) tsec.push(0x60, ...uleb(p.length), ...p, ...uleb(r.length), ...r);

  const isec: number[] = [...uleb(fns.length)];
  for (const [n, ti] of fns) {
    const mod = enc.encode('h');
    const nm = enc.encode(n);
    isec.push(...uleb(mod.length), ...mod, ...uleb(nm.length), ...nm, 0x00, ...uleb(ti));
  }

  const fsec: number[] = [...uleb(fns.length)];
  for (const [, ti] of fns) fsec.push(...uleb(ti));

  const esec: number[] = [...uleb(fns.length)];
  for (let i = 0; i < fns.length; i++) {
    const nm = enc.encode('t_' + fns[i][0]);
    esec.push(...uleb(nm.length), ...nm, 0x00, ...uleb(fns.length + i));
  }

  const csec: number[] = [...uleb(fns.length)];
  for (let i = 0; i < fns.length; i++) {
    const nparams = types[fns[i][1]][0].length;
    const body: number[] = [0x00];
    for (let p = 0; p < nparams; p++) body.push(0x20, ...uleb(p));
    body.push(0x10, ...uleb(i), 0x0b);
    csec.push(...uleb(body.length), ...body);
  }

  const bytes = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0, 0, 0,
    ...sec(1, tsec),
    ...sec(2, isec),
    ...sec(3, fsec),
    ...sec(7, esec),
    ...sec(10, csec),
  ]);
  return new WebAssembly.Module(bytes);
}

export interface WclapInstanceOptions {
  sampleRate: number;
  maxFrames: number;
  /** CLAP plugin id within the bundle (defaults to the first plugin). */
  clapPluginId?: string;
  /** Number of audio input ports (0 for instruments, 1 for effects). */
  audioInputs: 0 | 1;
  /** Initial parameter values. */
  params?: { id: number; value: number }[];
  /** Shared, pre-compiled trampoline module. */
  trampoline: WebAssembly.Module;
}

interface PendingEvent {
  time: number;
  bytes: Uint8Array;
}

/** A live WCLAP plugin instance bound to one audio stream. */
export class WclapInstance {
  private ex: WebAssembly.Exports & Record<string, any>;
  private mem!: WebAssembly.Memory;
  private table!: WebAssembly.Table;
  private plug = 0;
  private inEventPtrs: number[] = [];
  private events: PendingEvent[] = [];
  private active = new Set<number>(); // key|channel<<8 of sounding notes
  private inPtrs!: { l: number; r: number };
  private outPtrs!: { l: number; r: number };
  private procPtr = 0;
  private frames: number;
  private evIdx = { size: 0, get: 0, push: 0 };
  private evPool = 0;
  private static readonly EV_POOL = 512;
  private static readonly EV_STRIDE = 48;
  readonly audioInputs: 0 | 1;

  constructor(module: WebAssembly.Module, opts: WclapInstanceOptions) {
    this.frames = opts.maxFrames;
    this.audioInputs = opts.audioInputs;
    const instance = new WebAssembly.Instance(module, {});
    this.ex = instance.exports as Record<string, any>;
    if (typeof this.ex._initialize === 'function') this.ex._initialize();
    this.mem = this.ex.memory as WebAssembly.Memory;
    this.table = this.ex.__indirect_function_table as WebAssembly.Table;
    this.setup(opts);
    for (const p of opts.params ?? []) this.setParam(p.id, p.value, 0);
  }

  private dv() {
    return new DataView(this.mem.buffer);
  }
  private malloc(n: number): number {
    return (this.ex.malloc as (n: number) => number)(n);
  }
  private cstr(s: string): number {
    const b = new TextEncoder().encode(s);
    const p = this.malloc(b.length + 1);
    new Uint8Array(this.mem.buffer, p, b.length + 1).set([...b, 0]);
    return p;
  }

  private setup(opts: WclapInstanceOptions) {
    // Host callbacks closing over this instance's memory + event list.
    const imports = {
      h: {
        get_extension: () => 0,
        req_restart: () => {},
        req_process: () => {},
        req_callback: () => {},
        inev_size: () => this.inEventPtrs.length,
        inev_get: (_ctx: number, i: number) => this.inEventPtrs[i] ?? 0,
        outev_push: () => 1,
      },
    };
    const tramp = new WebAssembly.Instance(opts.trampoline, imports).exports as Record<string, any>;
    const order = [
      'get_extension',
      'req_restart',
      'req_process',
      'req_callback',
      'inev_size',
      'inev_get',
      'outev_push',
    ];
    const base = this.table.length;
    this.table.grow(order.length);
    const idx: Record<string, number> = {};
    order.forEach((n, i) => {
      this.table.set(base + i, tramp['t_' + n]);
      idx[n] = base + i;
    });
    this.evIdx = { size: idx.inev_size, get: idx.inev_get, push: idx.outev_push };

    // clap_host struct.
    const d = this.dv();
    const hostPtr = this.malloc(64);
    d.setUint32(hostPtr + 0, 1, true);
    d.setUint32(hostPtr + 4, 2, true);
    d.setUint32(hostPtr + 8, 2, true);
    d.setUint32(hostPtr + 12, 0, true);
    d.setUint32(hostPtr + 16, this.cstr('iam'), true);
    d.setUint32(hostPtr + 20, this.cstr('iam'), true);
    d.setUint32(hostPtr + 24, this.cstr('-'), true);
    d.setUint32(hostPtr + 28, this.cstr('1'), true);
    d.setUint32(hostPtr + 32, idx.get_extension, true);
    d.setUint32(hostPtr + 36, idx.req_restart, true);
    d.setUint32(hostPtr + 40, idx.req_process, true);
    d.setUint32(hostPtr + 44, idx.req_callback, true);

    // clap_entry -> factory -> create_plugin.
    const entryGlobal = this.ex.clap_entry;
    const entryPtr = typeof entryGlobal === 'object' ? entryGlobal.value : entryGlobal;
    const initFn = this.table.get(this.dv().getUint32(entryPtr + 12, true)) as (p: number) => number;
    initFn(this.cstr('/wclap'));
    const getFactory = this.table.get(this.dv().getUint32(entryPtr + 20, true)) as (
      id: number,
    ) => number;
    const facPtr = getFactory(this.cstr('clap.plugin-factory'));
    if (!facPtr) throw new Error('WCLAP: no plugin factory');
    const pluginId = opts.clapPluginId ?? this.firstPluginId(facPtr);
    const createFn = this.table.get(this.dv().getUint32(facPtr + 8, true)) as (
      f: number,
      h: number,
      id: number,
    ) => number;
    this.plug = createFn(facPtr, hostPtr, this.cstr(pluginId));
    if (!this.plug) throw new Error(`WCLAP: create_plugin failed for ${pluginId}`);

    this.pfn(PL_INIT)(this.plug);
    this.pfn(PL_ACTIVATE)(this.plug, opts.sampleRate, 1, opts.maxFrames);
    this.pfn(PL_START)(this.plug);
    this.allocAudio();
  }

  private firstPluginId(facPtr: number): string {
    const countFn = this.table.get(this.dv().getUint32(facPtr + 0, true)) as (f: number) => number;
    const descFn = this.table.get(this.dv().getUint32(facPtr + 4, true)) as (
      f: number,
      i: number,
    ) => number;
    if (countFn(facPtr) < 1) throw new Error('WCLAP: factory exposes no plugins');
    const desc = descFn(facPtr, 0);
    const idPtr = this.dv().getUint32(desc + 12, true);
    return this.readCstr(idPtr);
  }

  private readCstr(p: number): string {
    const u = new Uint8Array(this.mem.buffer);
    let s = '';
    while (u[p]) s += String.fromCharCode(u[p++]);
    return s;
  }

  private pfn(off: number): (...a: number[]) => number {
    return this.table.get(this.dv().getUint32(this.plug + off, true)) as (...a: number[]) => number;
  }

  private allocAudio() {
    const N = this.frames;
    this.outPtrs = { l: this.malloc(N * 4), r: this.malloc(N * 4) };
    this.inPtrs = { l: this.malloc(N * 4), r: this.malloc(N * 4) };
    const d = this.dv();
    const outCh = this.malloc(8);
    d.setUint32(outCh + 0, this.outPtrs.l, true);
    d.setUint32(outCh + 4, this.outPtrs.r, true);
    const audioOut = this.malloc(24);
    d.setUint32(audioOut + 0, outCh, true);
    d.setUint32(audioOut + 8, 2, true);
    const inCh = this.malloc(8);
    d.setUint32(inCh + 0, this.inPtrs.l, true);
    d.setUint32(inCh + 4, this.inPtrs.r, true);
    const audioIn = this.malloc(24);
    d.setUint32(audioIn + 0, inCh, true);
    d.setUint32(audioIn + 8, 2, true);

    const inEv = this.malloc(12);
    const outEv = this.malloc(8);
    // ctx=0; size/get/push are the trampoline table indices captured in setup.
    d.setUint32(inEv + 4, this.evIdx.size, true);
    d.setUint32(inEv + 8, this.evIdx.get, true);
    d.setUint32(outEv + 4, this.evIdx.push, true);

    this.evPool = this.malloc(WclapInstance.EV_POOL * WclapInstance.EV_STRIDE);
    this.procPtr = this.malloc(64);
    d.setUint32(this.procPtr + 8, N, true); // frames_count (rewritten each block)
    d.setUint32(this.procPtr + 16, this.audioInputs ? audioIn : 0, true);
    d.setUint32(this.procPtr + 20, audioOut, true);
    d.setUint32(this.procPtr + 24, this.audioInputs, true);
    d.setUint32(this.procPtr + 28, 1, true);
    d.setUint32(this.procPtr + 32, inEv, true);
    d.setUint32(this.procPtr + 36, outEv, true);
  }

  private pushEvent(bytes: Uint8Array, time: number) {
    this.events.push({ time, bytes });
  }

  noteOn(key: number, channel: number, velocity: number, time: number) {
    const ev = new Uint8Array(SIZE_NOTE);
    const d = new DataView(ev.buffer);
    d.setUint32(0, SIZE_NOTE, true);
    d.setUint32(4, time, true);
    d.setUint16(10, EVENT_NOTE_ON, true);
    d.setInt32(16, -1, true);
    d.setInt16(20, 0, true);
    d.setInt16(22, channel, true);
    d.setInt16(24, key, true);
    d.setFloat64(32, velocity, true);
    this.pushEvent(ev, time);
    this.active.add(key | (channel << 8));
  }

  noteOff(key: number, channel: number, time: number) {
    const ev = new Uint8Array(SIZE_NOTE);
    const d = new DataView(ev.buffer);
    d.setUint32(0, SIZE_NOTE, true);
    d.setUint32(4, time, true);
    d.setUint16(10, EVENT_NOTE_OFF, true);
    d.setInt32(16, -1, true);
    d.setInt16(20, 0, true);
    d.setInt16(22, channel, true);
    d.setInt16(24, key, true);
    d.setFloat64(32, 0, true);
    this.pushEvent(ev, time);
    this.active.delete(key | (channel << 8));
  }

  allNotesOff(time: number) {
    for (const k of [...this.active]) this.noteOff(k & 0xff, (k >> 8) & 0xff, time);
  }

  setParam(id: number, value: number, time: number) {
    const ev = new Uint8Array(SIZE_PARAM);
    const d = new DataView(ev.buffer);
    d.setUint32(0, SIZE_PARAM, true);
    d.setUint32(4, time, true);
    d.setUint16(10, EVENT_PARAM_VALUE, true);
    d.setUint32(16, id >>> 0, true);
    d.setInt32(24, -1, true);
    d.setInt16(28, -1, true);
    d.setInt16(30, -1, true);
    d.setInt16(32, -1, true);
    d.setFloat64(40, value, true);
    this.pushEvent(ev, time);
  }

  /**
   * Processes one block. For effects, pass the input bus. Returns interleaved
   * stereo? No — returns separate L/R views valid until the next call.
   */
  process(frames: number, inL?: Float32Array, inR?: Float32Array): { left: Float32Array; right: Float32Array } {
    const d = this.dv();
    // Materialize queued events (sorted by time) into the fixed event pool.
    this.events.sort((a, b) => a.time - b.time);
    this.inEventPtrs = [];
    const count = Math.min(this.events.length, WclapInstance.EV_POOL);
    for (let i = 0; i < count; i++) {
      const e = this.events[i];
      const ptr = this.evPool + i * WclapInstance.EV_STRIDE;
      const t = Math.min(Math.max(0, e.time), frames - 1);
      new DataView(e.bytes.buffer).setUint32(4, t, true);
      new Uint8Array(this.mem.buffer, ptr, e.bytes.length).set(e.bytes);
      this.inEventPtrs.push(ptr);
    }
    this.events = [];

    if (this.audioInputs && inL && inR) {
      new Float32Array(this.mem.buffer, this.inPtrs.l, frames).set(inL.subarray(0, frames));
      new Float32Array(this.mem.buffer, this.inPtrs.r, frames).set(inR.subarray(0, frames));
    }
    d.setUint32(this.procPtr + 8, frames, true);
    this.pfn(PL_PROCESS)(this.plug, this.procPtr);
    return {
      left: new Float32Array(this.mem.buffer, this.outPtrs.l, frames),
      right: new Float32Array(this.mem.buffer, this.outPtrs.r, frames),
    };
  }

  destroy() {
    try {
      this.pfn(PL_STOP)(this.plug);
    } catch {
      // ignore
    }
  }
}
