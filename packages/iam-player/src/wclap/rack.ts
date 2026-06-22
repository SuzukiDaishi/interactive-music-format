/**
 * A WCLAP "rack": owns the plugin instances of a module and turns the engine's
 * PCM mix + MIDI event stream into a final stereo mix.
 *
 * Routing (MVP): each instrument track's instance is summed into the master bus
 * after passing through its own insert-effect chain; the master bus then runs
 * through the project's master effect chain. Per-PCM-track inserts are a future
 * extension (they need per-track buffers from the engine).
 */

import type { IamMidiEvent } from '@iam/pack';
import { MidiStatus } from '@iam/pack';
import { WclapInstance, WclapInstanceOptions } from './host.js';

export interface RackInstanceSpec {
  instanceId: number;
  module: WebAssembly.Module;
  clapPluginId?: string;
  params?: { id: number; value: number }[];
  /** 0 for instruments/synths, 1 for effects. */
  audioInputs: 0 | 1;
}

export interface RackRouting {
  /** Instrument instances summed into the bus, each with an insert chain. */
  instruments: { instanceId: number; effects: number[] }[];
  /** Master bus effect chain (instance ids, applied in order). */
  masterEffects: number[];
}

export interface RackOptions {
  sampleRate: number;
  maxFrames: number;
  trampoline: WebAssembly.Module;
}

export class WclapRack {
  private instances = new Map<number, WclapInstance>();
  private routing: RackRouting;
  private scratchL: Float32Array;
  private scratchR: Float32Array;

  constructor(specs: RackInstanceSpec[], routing: RackRouting, opts: RackOptions) {
    this.routing = routing;
    this.scratchL = new Float32Array(opts.maxFrames);
    this.scratchR = new Float32Array(opts.maxFrames);
    for (const spec of specs) {
      const o: WclapInstanceOptions = {
        sampleRate: opts.sampleRate,
        maxFrames: opts.maxFrames,
        clapPluginId: spec.clapPluginId,
        audioInputs: spec.audioInputs,
        params: spec.params,
        trampoline: opts.trampoline,
      };
      try {
        this.instances.set(spec.instanceId, new WclapInstance(spec.module, o));
      } catch {
        // A failed plugin is skipped; the rest of the mix still plays.
      }
    }
  }

  get size(): number {
    return this.instances.size;
  }

  /** Queues engine MIDI events onto the matching instrument instances. */
  handleMidi(events: IamMidiEvent[]): void {
    for (const e of events) {
      if (e.status === MidiStatus.NoteOff && e.instanceId === 0xffffffff) {
        // Broadcast all-notes-off.
        for (const inst of this.instances.values()) inst.allNotesOff(e.frameOffset);
        continue;
      }
      const inst = this.instances.get(e.instanceId);
      if (!inst) continue;
      if (e.status === MidiStatus.NoteOn) inst.noteOn(e.key, 0, e.velocity, e.frameOffset);
      else if (e.status === MidiStatus.NoteOff) inst.noteOff(e.key, 0, e.frameOffset);
    }
  }

  private chain(effects: number[], l: Float32Array, r: Float32Array, frames: number) {
    let curL = l;
    let curR = r;
    for (const id of effects) {
      const fx = this.instances.get(id);
      if (!fx) continue;
      const out = fx.process(frames, curL, curR);
      curL = out.left;
      curR = out.right;
    }
    return { l: curL, r: curR };
  }

  /**
   * Renders into the interleaved stereo `bus` (length >= frames*2), which starts
   * as the engine PCM mix and is overwritten with the final mix.
   */
  render(bus: Float32Array, frames: number, gain?: (instanceId: number) => number): void {
    const L = this.scratchL;
    const R = this.scratchR;
    for (let i = 0; i < frames; i++) {
      L[i] = bus[i * 2];
      R[i] = bus[i * 2 + 1];
    }
    // Sum instrument instances (each through its insert chain) into the bus.
    // `gain` (optional) applies the instrument track's live volume/mute so the
    // synth honors the mixer just like PCM tracks.
    for (const ins of this.routing.instruments) {
      const inst = this.instances.get(ins.instanceId);
      if (!inst) continue;
      const g = gain ? gain(ins.instanceId) : 1;
      const dry = inst.process(frames);
      const wet = this.chain(ins.effects, dry.left, dry.right, frames);
      for (let i = 0; i < frames; i++) {
        L[i] += wet.l[i] * g;
        R[i] += wet.r[i] * g;
      }
    }
    // Master effect chain.
    const m = this.chain(this.routing.masterEffects, L, R, frames);
    for (let i = 0; i < frames; i++) {
      bus[i * 2] = m.l[i];
      bus[i * 2 + 1] = m.r[i];
    }
  }

  destroy(): void {
    for (const inst of this.instances.values()) inst.destroy();
    this.instances.clear();
  }
}
