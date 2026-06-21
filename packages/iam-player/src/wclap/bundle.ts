/**
 * WCLAP (WebCLAP) bundle loading.
 *
 * A `.wclap` artifact is a gzipped tar containing `module.wasm` (the CLAP
 * plugin compiled to wasm32), a `plugin.json` manifest and an optional `ui/`.
 * Decompression happens off the audio thread (main thread / Node), so this
 * module is async; the audio worklet only ever sees the extracted module bytes.
 */

export interface WclapManifestPlugin {
  id: string;
  name?: string;
  features?: string[];
}

export interface WclapManifest {
  manifest_version?: number;
  id: string;
  name?: string;
  plugins?: WclapManifestPlugin[];
  [key: string]: unknown;
}

export interface WclapBundle {
  manifest: WclapManifest;
  /** Raw bytes of the CLAP `module.wasm`. */
  moduleBytes: Uint8Array;
}

/** Gunzip helper that works in Node and browsers (no extra dependencies). */
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  // Node.js path. The specifier is kept non-literal so bundlers/TS don't try to
  // resolve node:zlib in a browser build.
  const g = globalThis as unknown as { process?: { versions?: { node?: string } } };
  if (g.process?.versions?.node) {
    const mod = 'node:zlib';
    const zlib: any = await import(/* @vite-ignore */ mod);
    return new Uint8Array(zlib.gunzipSync(bytes));
  }
  // Browser path.
  const G = globalThis as any;
  if (typeof G.DecompressionStream !== 'undefined') {
    const ds = new G.DecompressionStream('gzip');
    const stream = new Response(bytes as any).body!.pipeThrough(ds);
    const buf = await new Response(stream as any).arrayBuffer();
    return new Uint8Array(buf);
  }
  throw new Error('No gzip implementation available (need Node zlib or DecompressionStream)');
}

/** Minimal POSIX/ustar tar reader: returns a map of file name -> bytes. */
export function untar(bytes: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const dec = new TextDecoder();
  let off = 0;
  while (off + 512 <= bytes.length) {
    const header = bytes.subarray(off, off + 512);
    // Two consecutive zero blocks mark the end of the archive.
    if (header.every((b) => b === 0)) break;
    const name = dec.decode(header.subarray(0, 100)).replace(/\0.*$/, '');
    const sizeStr = dec.decode(header.subarray(124, 136)).replace(/\0.*$/, '').trim();
    const size = parseInt(sizeStr, 8) || 0;
    const typeFlag = header[156];
    off += 512;
    if (size > 0) {
      // typeFlag '0' or '\0' = regular file; others (dirs, etc.) are skipped.
      if (typeFlag === 0x30 || typeFlag === 0) {
        files.set(name.replace(/^\.\//, ''), bytes.subarray(off, off + size));
      }
      off += Math.ceil(size / 512) * 512;
    }
  }
  return files;
}

/** Extracts the manifest and module bytes from a `.wclap` (.tar.gz) artifact. */
export async function loadWclapBundle(tgz: Uint8Array): Promise<WclapBundle> {
  const tar = untar(await gunzip(tgz));
  const moduleBytes = tar.get('module.wasm');
  if (!moduleBytes) throw new Error('WCLAP bundle missing module.wasm');
  const manifestBytes = tar.get('plugin.json');
  let manifest: WclapManifest = { id: 'unknown' };
  if (manifestBytes) {
    try {
      manifest = JSON.parse(new TextDecoder().decode(manifestBytes));
    } catch {
      // Best-effort: a missing/broken manifest still leaves a usable module.
    }
  }
  return { manifest, moduleBytes: moduleBytes.slice() };
}
