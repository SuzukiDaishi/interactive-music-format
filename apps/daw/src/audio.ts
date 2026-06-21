/** Audio file import and asset conversion utilities. */
import { decodePack, extractPack, IamProject, normalizeProject } from '@iam/pack';
import { AssetAudio } from './store';

/** Decodes an audio file and resamples it to the bank sample rate. */
export async function importAudioFile(
  file: File,
  bankSampleRate: number,
): Promise<Omit<AssetAudio, 'id'>> {
  const arrayBuf = await file.arrayBuffer();
  // Decode at the file's native rate first.
  const probe = new OfflineAudioContext(1, 1, 48000);
  const decoded = await probe.decodeAudioData(arrayBuf.slice(0));
  // Resample + downmix to <=2ch via an OfflineAudioContext render.
  const channels = Math.min(decoded.numberOfChannels, 2) as 1 | 2;
  const frames = Math.ceil((decoded.duration + 1 / bankSampleRate) * bankSampleRate);
  const oc = new OfflineAudioContext(channels, frames, bankSampleRate);
  const src = oc.createBufferSource();
  src.buffer = decoded;
  src.connect(oc.destination);
  src.start();
  const rendered = await oc.startRendering();
  const out = new Float32Array(rendered.length * channels);
  for (let ch = 0; ch < channels; ch++) {
    const d = rendered.getChannelData(ch);
    for (let i = 0; i < rendered.length; i++) out[i * channels + ch] = d[i];
  }
  return {
    name: file.name.replace(/\.[^.]+$/, ''),
    channels,
    sampleRate: bankSampleRate,
    frames: rendered.length,
    data: out,
  };
}

/** Converts pack assets (pcm16/f32) to editor assets (f32). */
export function packAssetsToAudio(
  assets: ReturnType<typeof decodePack>['assets'],
): AssetAudio[] {
  return assets.map((a) => {
    let data: Float32Array;
    if (a.data instanceof Float32Array) {
      data = a.data;
    } else {
      data = new Float32Array(a.data.length);
      for (let i = 0; i < a.data.length; i++) data[i] = a.data[i] / 32768;
    }
    return {
      id: a.id,
      name: a.name,
      channels: a.channels,
      sampleRate: a.sampleRate,
      frames: a.frames,
      data,
    };
  });
}

/** Imports a .iam.wasm file back into an editable project. */
export function importIamWasm(bytes: Uint8Array): {
  project: IamProject;
  assets: AssetAudio[];
} {
  const pack = extractPack(bytes);
  if (!pack) throw new Error('Not a .iam.wasm file (no iam.pack section)');
  const decoded = decodePack(pack);
  if (!decoded.project) {
    throw new Error(
      'This module has no embedded project metadata (META chunk stripped); it cannot be re-imported.',
    );
  }
  return {
    project: normalizeProject(decoded.project),
    assets: packAssetsToAudio(decoded.assets),
  };
}

export function downloadBytes(bytes: Uint8Array, filename: string): void {
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/wasm' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
