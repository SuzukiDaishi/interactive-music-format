/**
 * Preview engine: builds a .iam.wasm from the current project in memory
 * and plays it through @iam/player — the preview is bit-identical to what
 * an exported module will do.
 */
import { useSyncExternalStore } from 'react';
import { buildIamWasm, encodePack, NONE_ID } from '@iam/pack';
import { IamPlayer, IamPlayerStatus, NamedEvent } from '@iam/player';
import { store } from './store';
import engineWasmUrl from '../../../runtime/engine.wasm?url';

export interface LogEntry {
  time: string;
  text: string;
}

class PreviewEngine {
  player: IamPlayer | null = null;
  status: IamPlayerStatus = {
    sectionId: NONE_ID,
    sectionName: null,
    positionBeats: 0,
    playing: false,
    rate: 1,
  };
  log: LogEntry[] = [];
  building = false;
  error: string | null = null;
  rate = 1;

  private ctx: AudioContext | null = null;
  private engineBytes: Uint8Array | null = null;
  private version = 0;
  private listeners = new Set<() => void>();

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = (): number => this.version;

  private emit() {
    this.version++;
    for (const l of this.listeners) l();
  }

  private pushLog(text: string) {
    const d = new Date();
    const time = d.toLocaleTimeString('en-GB', { hour12: false });
    this.log.push({ time, text });
    if (this.log.length > 200) this.log.shift();
  }

  private async ensureEngine(): Promise<Uint8Array> {
    if (!this.engineBytes) {
      const res = await fetch(engineWasmUrl);
      if (!res.ok) throw new Error('Failed to load engine.wasm');
      this.engineBytes = new Uint8Array(await res.arrayBuffer());
    }
    return this.engineBytes;
  }

  /** Builds the current project into a .iam.wasm byte array. */
  async buildModule(format: 'pcm16' | 'f32' = 'pcm16'): Promise<Uint8Array> {
    const engine = await this.ensureEngine();
    const pack = encodePack(store.syncedProject(), store.encodeAssets(format), {
      includeMeta: true,
    });
    return buildIamWasm(engine, pack);
  }

  /** (Re)builds the module and starts playback. */
  async play(sectionId?: number): Promise<void> {
    this.building = true;
    this.error = null;
    this.emit();
    try {
      // f32 avoids the pcm16 conversion for snappy preview rebuilds.
      const bytes = await this.buildModule('f32');
      if (!this.ctx) this.ctx = new AudioContext();
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      this.disposePlayer();
      const player = await IamPlayer.load(bytes, this.ctx);
      player.node.connect(this.ctx.destination);
      player.onStatus((s) => {
        this.status = s;
        this.emit();
      });
      player.onEvent((e) => {
        this.pushLog(describeEvent(e));
        this.emit();
      });
      player.setRate(this.rate);
      this.player = player;
      store.touch((s) => {
        s.dirty = false;
      });
      if (sectionId !== undefined) {
        player.playSection(sectionId);
        this.pushLog(`▶ preview section`);
      } else {
        player.play();
        this.pushLog('▶ play module');
      }
    } catch (e) {
      this.error = e instanceof Error ? e.message : String(e);
      this.pushLog(`build error: ${this.error}`);
    } finally {
      this.building = false;
      this.emit();
    }
  }

  stop(fadeMs = 150): void {
    this.player?.stop(fadeMs);
    this.pushLog('⏹ stop');
    this.emit();
  }

  pause(): void {
    this.player?.pause();
  }

  resume(): void {
    this.player?.resume();
  }

  setRate(rate: number): void {
    this.rate = rate;
    this.player?.setRate(rate);
    this.emit();
  }

  seekBeats(beats: number): void {
    this.player?.seekBeats(beats);
  }

  setRtpc(name: string, value: number | boolean | string): void {
    try {
      this.player?.setRtpc(name, value);
    } catch {
      // RTPC may not exist in the previously built module; rebuild on play.
    }
  }

  triggerCue(name: string): void {
    try {
      this.player?.triggerCue(name);
      this.pushLog(`cue ⇒ ${name}`);
      this.emit();
    } catch {
      this.pushLog(`cue '${name}' not in the running preview (press Play to rebuild)`);
      this.emit();
    }
  }

  clearLog(): void {
    this.log = [];
    this.emit();
  }

  private disposePlayer() {
    if (this.player) {
      this.player.stop(0);
      this.player.dispose();
      this.player = null;
    }
  }
}

function describeEvent(e: NamedEvent): string {
  switch (e.kind) {
    case 'sectionChanged':
      return `section: ${e.fromName ?? '∅'} → ${e.toName ?? '∅'}`;
    case 'cueFired':
      return `cue fired: ${e.name ?? e.a}`;
    case 'gotoScheduled':
      return `goto scheduled → ${e.toName ?? e.a}`;
    case 'emit':
      return `emit(${e.a})`;
    case 'ended':
      return 'ended';
    case 'looped':
      return `loop: ${e.name ?? e.a}`;
    case 'oneShot':
      return `one-shot: asset ${e.a}`;
    case 'rtpcChanged':
      return `rtpc ${e.name ?? e.a} = ${e.c.toFixed(3)}`;
    default:
      return `event ${e.type}`;
  }
}

export const preview = new PreviewEngine();

export function usePreview(): PreviewEngine {
  useSyncExternalStore(preview.subscribe, preview.getVersion);
  return preview;
}
