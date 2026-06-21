/**
 * The bundled WCLAP plugin library (the `.wclap` artifacts shipped in /wclap).
 * Each entry exposes a URL (resolved by Vite) so the DAW can fetch the bundle
 * bytes on demand and embed them into a project's WCLP chunk.
 */
import simpleSynthUrl from '../../../wclap/z-audio-simple-synth.wclap.tar.gz?url';
import formulaPianoUrl from '../../../wclap/z-audio-formula-piano.wclap.tar.gz?url';
import formulaDrumsUrl from '../../../wclap/z-audio-formula-drums.wclap.tar.gz?url';
import simpleEqUrl from '../../../wclap/z-audio-simple-eq.wclap.tar.gz?url';
import limiterUrl from '../../../wclap/z-audio-limiter.wclap.tar.gz?url';
import compressorUrl from '../../../wclap/z-audio-compressor.wclap.tar.gz?url';
import reverbUrl from '../../../wclap/z-audio-parametric-reverb.wclap.tar.gz?url';

export type WclapKind = 'instrument' | 'effect';

export interface WclapLibraryEntry {
  /** CLAP plugin id (matches the bundle manifest's default plugin). */
  clapPluginId: string;
  name: string;
  kind: WclapKind;
  url: string;
}

export const WCLAP_LIBRARY: WclapLibraryEntry[] = [
  { clapPluginId: 'dev.zaudio.simple-synth', name: 'Z Audio Simple Synth', kind: 'instrument', url: simpleSynthUrl },
  { clapPluginId: 'dev.zaudio.formula-piano', name: 'Z Audio Formula Piano', kind: 'instrument', url: formulaPianoUrl },
  { clapPluginId: 'dev.zaudio.formula-drums', name: 'Z Audio Formula Drum Set', kind: 'instrument', url: formulaDrumsUrl },
  { clapPluginId: 'dev.zaudio.simple-eq', name: 'Z Audio Simple EQ', kind: 'effect', url: simpleEqUrl },
  { clapPluginId: 'dev.zaudio.limiter', name: 'Z Audio Limiter', kind: 'effect', url: limiterUrl },
  { clapPluginId: 'dev.zaudio.compressor', name: 'Z Audio Compressor', kind: 'effect', url: compressorUrl },
  { clapPluginId: 'dev.zaudio.parametric-reverb', name: 'Z Audio Parametric Reverb', kind: 'effect', url: reverbUrl },
];

export function findLibraryEntry(clapPluginId: string): WclapLibraryEntry | undefined {
  return WCLAP_LIBRARY.find((e) => e.clapPluginId === clapPluginId);
}

/** Fetches the raw `.wclap.tar.gz` bytes for a library entry. */
export async function fetchBundleBytes(url: string): Promise<Uint8Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch WCLAP bundle: ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}
