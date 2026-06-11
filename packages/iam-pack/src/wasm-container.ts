/**
 * .iam.wasm container tools.
 *
 * A .iam.wasm file is a standard WebAssembly binary (the prebuilt IAM
 * engine) with one extra custom section named "iam.pack" whose payload is
 * an IAMP data pack. See docs/01_iam_container_spec.md.
 */

import { WASM_PACK_SECTION } from './model.js';

const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d]; // \0asm

function encodeLEB(value: number): number[] {
  const out: number[] = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    out.push(b);
  } while (v !== 0);
  return out;
}

function decodeLEB(buf: Uint8Array, pos: number): [number, number] {
  let result = 0;
  let shift = 0;
  for (;;) {
    if (pos >= buf.length) throw new Error('wasm: truncated LEB128');
    const b = buf[pos++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
    if (shift > 35) throw new Error('wasm: LEB128 too long');
  }
  return [result >>> 0, pos];
}

function isWasm(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 8 &&
    WASM_MAGIC.every((b, i) => bytes[i] === b)
  );
}

interface SectionRef {
  /** Offset of the section id byte. */
  start: number;
  /** Offset just past the section payload. */
  end: number;
  id: number;
  /** For custom sections: the section name. */
  name?: string;
  /** For custom sections: payload bytes after the name. */
  data?: Uint8Array;
}

function* sections(bytes: Uint8Array): Generator<SectionRef> {
  if (!isWasm(bytes)) throw new Error('Not a WebAssembly binary');
  let pos = 8;
  while (pos < bytes.length) {
    const start = pos;
    const id = bytes[pos++];
    let size: number;
    [size, pos] = decodeLEB(bytes, pos);
    const payloadStart = pos;
    const end = payloadStart + size;
    if (end > bytes.length) throw new Error('wasm: truncated section');
    if (id === 0) {
      let nameLen: number;
      let p = payloadStart;
      [nameLen, p] = decodeLEB(bytes, p);
      const name = new TextDecoder().decode(bytes.subarray(p, p + nameLen));
      yield { start, end, id, name, data: bytes.subarray(p + nameLen, end) };
    } else {
      yield { start, end, id };
    }
    pos = end;
  }
}

function makeCustomSection(name: string, data: Uint8Array): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const payloadLen = encodeLEB(nameBytes.length).length + nameBytes.length + data.length;
  const header = [0, ...encodeLEB(payloadLen), ...encodeLEB(nameBytes.length)];
  const out = new Uint8Array(header.length + nameBytes.length + data.length);
  out.set(header, 0);
  out.set(nameBytes, header.length);
  out.set(data, header.length + nameBytes.length);
  return out;
}

/**
 * Builds a .iam.wasm: engine binary + "iam.pack" custom section. Any
 * pre-existing iam.pack section in `engineWasm` is removed first, so a
 * .iam.wasm can also be used as the engine input (repack).
 */
export function buildIamWasm(engineWasm: Uint8Array, pack: Uint8Array): Uint8Array {
  const stripped = stripPack(engineWasm);
  const section = makeCustomSection(WASM_PACK_SECTION, pack);
  const out = new Uint8Array(stripped.length + section.length);
  out.set(stripped, 0);
  out.set(section, stripped.length);
  return out;
}

/** Removes the iam.pack custom section, returning the bare engine wasm. */
export function stripPack(bytes: Uint8Array): Uint8Array {
  const drop: SectionRef[] = [];
  for (const s of sections(bytes)) {
    if (s.id === 0 && s.name === WASM_PACK_SECTION) drop.push(s);
  }
  if (drop.length === 0) return bytes;
  let total = bytes.length;
  for (const s of drop) total -= s.end - s.start;
  const out = new Uint8Array(total);
  let w = 0;
  let r = 0;
  for (const s of drop) {
    out.set(bytes.subarray(r, s.start), w);
    w += s.start - r;
    r = s.end;
  }
  out.set(bytes.subarray(r), w);
  return out;
}

/** Extracts the IAMP pack from a .iam.wasm, or null when absent. */
export function extractPack(bytes: Uint8Array): Uint8Array | null {
  for (const s of sections(bytes)) {
    if (s.id === 0 && s.name === WASM_PACK_SECTION && s.data) {
      return s.data.slice();
    }
  }
  return null;
}

/** True when the bytes look like a .iam.wasm (wasm + iam.pack section). */
export function isIamWasm(bytes: Uint8Array): boolean {
  if (!isWasm(bytes)) return false;
  try {
    return extractPack(bytes) !== null;
  } catch {
    return false;
  }
}
