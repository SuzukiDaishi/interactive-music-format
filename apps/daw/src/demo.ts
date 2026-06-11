/** Loads the synthesized demo project into the editor. */
import type { IamProject } from '@iam/pack';
import { store, AssetAudio } from './store';
// Shared with examples/make-demo.mjs — single source of truth for the demo.
import { makeDemo } from '../../../examples/demo-project.mjs';

export function loadDemoProject(): void {
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
  store.loadProject(project, audio);
}
