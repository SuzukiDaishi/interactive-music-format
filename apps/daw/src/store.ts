/**
 * DAW application state: one mutable project + decoded asset audio.
 * Components subscribe to a version counter and read fields directly.
 */
import { useSyncExternalStore } from 'react';
import {
  AssetMeta,
  EncodeAsset,
  IamProject,
  Section,
  Track,
  emptyProject,
} from '@iam/pack';

export interface AssetAudio {
  id: number;
  name: string;
  channels: 1 | 2;
  sampleRate: number;
  frames: number;
  /** Interleaved f32. */
  data: Float32Array;
}

export type Selection =
  | { kind: 'none' }
  | { kind: 'item'; sectionId: number; trackId: number; itemId: number }
  | { kind: 'track'; sectionId: number; trackId: number };

class DawStore {
  project: IamProject = emptyProject('New Project');
  assets = new Map<number, AssetAudio>();
  selectedSectionId: number | null = null;
  selectedCueId: number | null = null;
  selectedAssetId: number | null = null;
  selection: Selection = { kind: 'none' };
  /** Increments on every mutation. */
  version = 0;
  /** True when edits were made since the last preview build. */
  dirty = false;

  private listeners = new Set<() => void>();

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getVersion = (): number => this.version;

  /** Apply a mutation and notify subscribers. */
  update(fn: (s: DawStore) => void): void {
    fn(this);
    this.version++;
    this.dirty = true;
    for (const l of this.listeners) l();
  }

  /** Notify without marking the project dirty (UI-only state). */
  touch(fn: (s: DawStore) => void): void {
    fn(this);
    this.version++;
    for (const l of this.listeners) l();
  }

  // -- helpers ---------------------------------------------------------------

  get selectedSection(): Section | null {
    return this.project.sections.find((s) => s.id === this.selectedSectionId) ?? null;
  }

  nextId(ids: number[]): number {
    return ids.length === 0 ? 0 : Math.max(...ids) + 1;
  }

  nextSectionId(): number {
    return this.nextId(this.project.sections.map((s) => s.id));
  }

  nextAssetId(): number {
    return this.nextId([...this.assets.keys()]);
  }

  nextCueId(): number {
    return this.nextId(this.project.cues.map((c) => c.id));
  }

  nextRtpcId(): number {
    return this.nextId(this.project.rtpcs.map((r) => r.id));
  }

  trackOf(section: Section, trackId: number): Track | null {
    return section.tracks.find((t) => t.id === trackId) ?? null;
  }

  /** Asset metadata list kept in sync with the audio map. */
  assetMetas(): AssetMeta[] {
    return [...this.assets.values()].map((a) => ({
      id: a.id,
      name: a.name,
      channels: a.channels,
      sampleRate: a.sampleRate,
      frames: a.frames,
    }));
  }

  /** Assets converted for pack encoding. */
  encodeAssets(format: 'pcm16' | 'f32'): EncodeAsset[] {
    return [...this.assets.values()].map((a) => {
      if (format === 'f32') {
        return { ...a, format: 'f32' as const, data: a.data };
      }
      const pcm = new Int16Array(a.data.length);
      for (let i = 0; i < a.data.length; i++) {
        const v = Math.max(-1, Math.min(1, a.data[i]));
        pcm[i] = Math.round(v * 32767);
      }
      return { ...a, format: 'pcm16' as const, data: pcm };
    });
  }

  /** Returns the project with asset metadata synced. */
  syncedProject(): IamProject {
    this.project.assets = this.assetMetas();
    return this.project;
  }

  loadProject(project: IamProject, assets: AssetAudio[]): void {
    this.update((s) => {
      s.project = project;
      s.assets = new Map(assets.map((a) => [a.id, a]));
      s.selectedSectionId = project.sections[0]?.id ?? null;
      s.selectedCueId = project.cues[0]?.id ?? null;
      s.selectedAssetId = assets[0]?.id ?? null;
      s.selection = { kind: 'none' };
    });
  }
}

export const store = new DawStore();

/** Re-render the component whenever the store changes. */
export function useStore(): DawStore {
  useSyncExternalStore(store.subscribe, store.getVersion);
  return store;
}
