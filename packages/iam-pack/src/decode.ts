/**
 * IAMP v1 binary decoder (for tooling: re-importing a .iam.wasm into the
 * DAW, inspecting metadata, extracting assets). The runtime engine has its
 * own Rust decoder; this one mirrors it.
 */

import {
  AssetMeta,
  BlendCurve,
  EncodeAsset,
  IamProject,
  MIN_PACK_VERSION,
  NONE_ID,
  NoteSource,
  PACK_MAGIC,
  PACK_VERSION,
  ParamMod,
  PluginInstance,
} from './model.js';

export interface SectionInfo {
  id: number;
  name: string;
  lengthBeats: number;
  loopEnabled: boolean;
  anchors: { id: number; name: string; beat: number }[];
  tracks: { id: number; name: string }[];
}

export interface RtpcInfo {
  id: number;
  name: string;
  type: 'f32' | 'bool' | 'enum';
  variants: string[];
  default: number;
  min: number;
  max: number;
}

export interface CueInfo {
  id: number;
  name: string;
}

/** A WCLAP plugin bank entry as decoded from the WCLP chunk. */
export interface DecodedPlugin {
  id: number;
  name: string;
  clapPluginId: string;
  url: string;
  embedded: boolean;
  /** Embedded `.wclap` bundle bytes, when `embedded` is true. */
  data?: Uint8Array;
}

export interface DecodedPack {
  /** Project header fields read from PROJ. */
  name: string;
  bankSampleRate: number;
  bpm: number;
  timeSignature: [number, number];
  startSectionId: number | null;
  /** Lightweight name/id metadata decoded from RTPC/SECT/CUES chunks. */
  sections: SectionInfo[];
  rtpcs: RtpcInfo[];
  cues: CueInfo[];
  /** Full project JSON from the META chunk, when present. */
  project: IamProject | null;
  assets: EncodeAsset[];
  /** WCLAP plugin bank (with embedded binaries) from the WCLP chunk. */
  plugins: DecodedPlugin[];
  /** Plugin instances from the PINS chunk. */
  pluginInstances: PluginInstance[];
  /** Master effect chain (plugin instance ids) from the PINS chunk. */
  masterEffects: number[];
  /** Vertical blend curves from the BLND chunk (v3; empty for v2 packs). */
  blends: BlendCurve[];
  /** RTPC -> plugin parameter modulations from the PMOD chunk (v3). */
  paramMods: ParamMod[];
  /** Note-generator routings from the NSRC chunk (v3). */
  noteSources: NoteSource[];
}

class Reader {
  pos = 0;
  private view: DataView;

  constructor(private buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  get remaining() {
    return this.buf.length - this.pos;
  }

  bytes(n: number): Uint8Array {
    if (this.remaining < n) throw new Error('IAMP: unexpected end of data');
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }

  u8(): number {
    return this.bytes(1)[0];
  }

  u16(): number {
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }

  u32(): number {
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  f32(): number {
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  str(): string {
    const len = this.u16();
    return new TextDecoder().decode(this.bytes(len));
  }
}

const ACTION_PAYLOAD_SIZE: Record<number, number> = {
  0x01: 20, // goto (+ bridge u32)
  0x02: 8, // play
  0x03: 8, // stop
  0x04: 16, // setTrackGain
  0x05: 8, // setLoop
  0x06: 4, // emit
  0x07: 8, // setRtpc
  0x08: 12, // oneShot
  0x0b: 24, // gotoTrack
};

function skipAction(r: Reader) {
  const op = r.u8();
  if (op === 0x09) {
    const count = r.u8();
    // timing+transition+pad (3) + fadeMs (4) + bridge (4) + targets (count*12)
    r.bytes(3 + 4 + 4 + count * 12);
    return;
  }
  if (op === 0x0a) {
    // section+track (8) + gain+fadeMs (8) + timing+pad (2)
    r.bytes(16 + 2);
    r.bytes(r.u16()); // value expr
    return;
  }
  if (op === 0x0c) {
    // instance+param (8) + value (4)
    r.bytes(12);
    const exprLen = r.u16();
    r.u16(); // pad
    r.bytes(exprLen);
    return;
  }
  if (op === 0x0d) {
    // rtpc (4) + value (4)
    r.bytes(8);
    const exprLen = r.u16();
    r.u16(); // pad
    r.bytes(exprLen);
    return;
  }
  const size = ACTION_PAYLOAD_SIZE[op];
  if (size === undefined) throw new Error(`IAMP: unknown action opcode 0x${op.toString(16)}`);
  r.bytes(size);
}

export function decodePack(pack: Uint8Array): DecodedPack {
  const r = new Reader(pack);
  const magic = new TextDecoder().decode(r.bytes(4));
  if (magic !== PACK_MAGIC) throw new Error(`IAMP: bad magic '${magic}'`);
  const version = r.u32();
  if (version < MIN_PACK_VERSION || version > PACK_VERSION) {
    throw new Error(`IAMP: unsupported version ${version}`);
  }
  const chunkCount = r.u32();

  const out: DecodedPack = {
    name: '',
    bankSampleRate: 48000,
    bpm: 120,
    timeSignature: [4, 4],
    startSectionId: null,
    sections: [],
    rtpcs: [],
    cues: [],
    project: null,
    assets: [],
    plugins: [],
    pluginInstances: [],
    masterEffects: [],
    blends: [],
    paramMods: [],
    noteSources: [],
  };

  for (let i = 0; i < chunkCount; i++) {
    const id = new TextDecoder().decode(r.bytes(4));
    const len = r.u32();
    const body = r.bytes(len);
    const pad = (4 - (len % 4)) % 4;
    r.bytes(pad);
    const cr = new Reader(body);

    if (id === 'PROJ') {
      out.name = cr.str();
      out.bankSampleRate = cr.u32();
      out.bpm = cr.f32();
      const num = cr.u8();
      const den = cr.u8();
      cr.u16();
      const start = cr.u32();
      out.timeSignature = [num, den];
      out.startSectionId = start === NONE_ID ? null : start;
    } else if (id === 'ABNK') {
      const count = cr.u32();
      for (let a = 0; a < count; a++) {
        const assetId = cr.u32();
        const name = cr.str();
        const format = cr.u8();
        const channels = cr.u8() as 1 | 2;
        cr.u16();
        const sampleRate = cr.u32();
        const frames = cr.u32();
        const n = frames * channels;
        let data: Int16Array | Float32Array;
        if (format === 0) {
          const raw = cr.bytes(n * 2);
          data = new Int16Array(n);
          const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
          for (let s = 0; s < n; s++) data[s] = dv.getInt16(s * 2, true);
        } else {
          const raw = cr.bytes(n * 4);
          data = new Float32Array(n);
          const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
          for (let s = 0; s < n; s++) data[s] = dv.getFloat32(s * 4, true);
        }
        const byteLen = n * (format === 0 ? 2 : 4);
        cr.bytes((4 - (byteLen % 4)) % 4);
        out.assets.push({
          id: assetId,
          name,
          channels,
          sampleRate,
          frames,
          format: format === 0 ? 'pcm16' : 'f32',
          data,
        });
      }
    } else if (id === 'RTPC') {
      const count = cr.u32();
      for (let k = 0; k < count; k++) {
        const rid = cr.u32();
        const name = cr.str();
        const ty = cr.u8();
        cr.u8();
        const variantCount = cr.u16();
        const variants: string[] = [];
        for (let v = 0; v < variantCount; v++) variants.push(cr.str());
        const def = cr.f32();
        const min = cr.f32();
        const max = cr.f32();
        cr.f32(); // smoothing
        out.rtpcs.push({
          id: rid,
          name,
          type: ty === 0 ? 'f32' : ty === 1 ? 'bool' : 'enum',
          variants,
          default: def,
          min,
          max,
        });
      }
    } else if (id === 'SECT') {
      const count = cr.u32();
      for (let k = 0; k < count; k++) {
        const sid = cr.u32();
        const name = cr.str();
        cr.f32(); // bpm
        cr.u8();
        cr.u8();
        const loopEnabled = cr.u8() !== 0;
        cr.u8();
        const lengthBeats = cr.f32();
        cr.f32(); // loop start
        const trackCount = cr.u32();
        const tracks: { id: number; name: string }[] = [];
        for (let t = 0; t < trackCount; t++) {
          const tid = cr.u32();
          const tname = cr.str();
          cr.f32(); // volume
          cr.f32(); // pan
          cr.u8(); // muted
          cr.u8(); // kind
          cr.bytes(2); // pad
          cr.u32(); // instrument instance (NONE for audio)
          const effectCount = cr.u16();
          cr.bytes(effectCount * 4);
          const itemCount = cr.u32();
          cr.bytes(itemCount * 32); // items are fixed 32 bytes
          const noteCount = cr.u32();
          cr.bytes(noteCount * 16); // notes are fixed 16 bytes
          tracks.push({ id: tid, name: tname });
        }
        const anchorCount = cr.u32();
        const anchors: { id: number; name: string; beat: number }[] = [];
        for (let a = 0; a < anchorCount; a++) {
          const aid = cr.u32();
          const aname = cr.str();
          const beat = cr.f32();
          anchors.push({ id: aid, name: aname, beat });
        }
        out.sections.push({ id: sid, name, lengthBeats, loopEnabled, anchors, tracks });
      }
    } else if (id === 'CUES') {
      const count = cr.u32();
      for (let k = 0; k < count; k++) {
        const cid = cr.u32();
        const name = cr.str();
        const ruleCount = cr.u32();
        for (let ri = 0; ri < ruleCount; ri++) {
          const condLen = cr.u16();
          cr.bytes(condLen);
          const actionCount = cr.u8();
          cr.u8(); // stopIfMatched
          for (let ai = 0; ai < actionCount; ai++) skipAction(cr);
        }
        out.cues.push({ id: cid, name });
      }
      // bindings are skipped (rest of the chunk)
    } else if (id === 'WCLP') {
      const count = cr.u32();
      for (let k = 0; k < count; k++) {
        const pid = cr.u32();
        const name = cr.str();
        const clapPluginId = cr.str();
        const url = cr.str();
        const flags = cr.u8();
        cr.u8();
        cr.u16();
        const binLen = cr.u32();
        const embedded = (flags & 1) !== 0;
        let data: Uint8Array | undefined;
        if (binLen > 0) data = cr.bytes(binLen).slice();
        cr.bytes((4 - (binLen % 4)) % 4);
        out.plugins.push({ id: pid, name, clapPluginId, url, embedded, data });
      }
    } else if (id === 'PINS') {
      const count = cr.u32();
      for (let k = 0; k < count; k++) {
        const iid = cr.u32();
        const bankId = cr.u32();
        const clapPluginId = cr.str();
        const paramCount = cr.u16();
        cr.u16();
        const params: { id: number; value: number }[] = [];
        for (let p = 0; p < paramCount; p++) {
          const pid = cr.u32();
          const value = cr.f32();
          params.push({ id: pid, value });
        }
        out.pluginInstances.push({
          id: iid,
          pluginBankId: bankId,
          clapPluginId: clapPluginId || undefined,
          params,
        });
      }
      const mCount = cr.u32();
      for (let m = 0; m < mCount; m++) out.masterEffects.push(cr.u32());
    } else if (id === 'BLND') {
      const count = cr.u32();
      for (let k = 0; k < count; k++) {
        const bid = cr.u32();
        const rtpc = cr.u32();
        const section = cr.u32();
        const track = cr.u32();
        const pointCount = cr.u16();
        cr.u16();
        const points: { x: number; y: number }[] = [];
        for (let p = 0; p < pointCount; p++) {
          const x = cr.f32();
          const y = cr.f32();
          points.push({ x, y });
        }
        out.blends.push({ id: bid, rtpc, section, track, points });
      }
    } else if (id === 'PMOD') {
      const count = cr.u32();
      for (let k = 0; k < count; k++) {
        const instance = cr.u32();
        const param = cr.u32();
        const rtpc = cr.u32();
        const pointCount = cr.u16();
        cr.u16();
        const points: { x: number; y: number }[] = [];
        for (let p = 0; p < pointCount; p++) {
          const x = cr.f32();
          const y = cr.f32();
          points.push({ x, y });
        }
        out.paramMods.push({ instance, param, rtpc, points });
      }
    } else if (id === 'NSRC') {
      const count = cr.u32();
      for (let k = 0; k < count; k++) {
        const generator = cr.u32();
        const target = cr.u32();
        out.noteSources.push({ generator, target });
      }
    } else if (id === 'META') {
      try {
        const meta = JSON.parse(new TextDecoder().decode(body));
        if (meta && typeof meta === 'object' && meta.project) {
          out.project = meta.project as IamProject;
        }
      } catch {
        // META is best-effort; ignore malformed JSON.
      }
    }
  }
  return out;
}

/** Asset metadata list derived from decoded assets. */
export function assetMetas(assets: EncodeAsset[]): AssetMeta[] {
  return assets.map((a) => ({
    id: a.id,
    name: a.name,
    channels: a.channels,
    sampleRate: a.sampleRate,
    frames: a.frames,
  }));
}
