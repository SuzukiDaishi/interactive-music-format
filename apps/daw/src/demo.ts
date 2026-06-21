/** Loads the synthesized demo project into the editor. */
import type { IamProject } from '@iam/pack';
import { store, AssetAudio } from './store';
// Shared with examples/make-demo.mjs — single source of truth for the demo.
import { makeDemo } from '../../../examples/demo-project.mjs';
import { findLibraryEntry, fetchBundleBytes } from './wclapLibrary';

export async function loadDemoProject(): Promise<void> {
  const { project, assets } = makeDemo() as unknown as {
    project: IamProject;
    assets: {
      id: number;
      name: string;
      channels: 1 | 2;
      sampleRate: number;
      frames: number;
      data: Int16Array;
    }[];
  };
  const audio: AssetAudio[] = assets.map((a) => {
    const f = new Float32Array(a.data.length);
    for (let i = 0; i < a.data.length; i++) f[i] = a.data[i] / 32768;
    return { id: a.id, name: a.name, channels: a.channels, sampleRate: a.sampleRate, frames: a.frames, data: f };
  });

  // Fetch the embedded WCLAP bundle bytes so the synth/limiter actually sound
  // in preview and survive export.
  const bundles = new Map<number, Uint8Array>();
  await Promise.all(
    project.plugins
      .filter((p) => p.embedded && p.clapPluginId)
      .map(async (p) => {
        const entry = findLibraryEntry(p.clapPluginId!);
        if (!entry) return;
        try {
          bundles.set(p.id, await fetchBundleBytes(entry.url));
        } catch {
          // Leave the bundle out; the player falls back to PCM-only playback.
        }
      }),
  );

  store.loadProject(project, audio, bundles);
}
