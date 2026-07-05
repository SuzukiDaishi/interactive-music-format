/**
 * Minimal Standard MIDI File (SMF) reader for importing .mid files into
 * instrument tracks. Supports format 0 and 1 with PPQN time division
 * (SMPTE division is rejected), running status, and treats velocity-0
 * note-ons as note-offs. Tick times convert to beats (quarter notes), so the
 * import is tempo-agnostic — the section's BPM decides how fast it plays.
 */

import type { MidiNote } from './model.js';

export interface SmfTrack {
  /** Track name from meta event 0x03, when present. */
  name?: string;
  notes: MidiNote[];
}

export interface SmfFile {
  format: number;
  /** Pulses per quarter note. */
  ppq: number;
  tracks: SmfTrack[];
}

export class SmfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmfError';
  }
}

class Reader {
  pos = 0;
  constructor(private buf: Uint8Array) {}

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  bytes(n: number): Uint8Array {
    if (this.remaining < n) throw new SmfError('unexpected end of file');
    const b = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return b;
  }

  u8(): number {
    return this.bytes(1)[0];
  }

  u16(): number {
    const b = this.bytes(2);
    return (b[0] << 8) | b[1];
  }

  u32(): number {
    const b = this.bytes(4);
    return ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
  }

  /** Variable-length quantity. */
  vlq(): number {
    let v = 0;
    for (let i = 0; i < 4; i++) {
      const b = this.u8();
      v = (v << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) return v;
    }
    throw new SmfError('malformed variable-length quantity');
  }
}

function ascii(b: Uint8Array): string {
  let s = '';
  for (const c of b) s += String.fromCharCode(c);
  return s;
}

/** Parses SMF bytes into per-track beat-timed notes. */
export function parseSmf(bytes: Uint8Array): SmfFile {
  const r = new Reader(bytes);
  if (ascii(r.bytes(4)) !== 'MThd') throw new SmfError('not a MIDI file (missing MThd)');
  const headLen = r.u32();
  if (headLen < 6) throw new SmfError('bad MThd length');
  const format = r.u16();
  const trackCount = r.u16();
  const division = r.u16();
  r.bytes(headLen - 6);
  if (format !== 0 && format !== 1) {
    throw new SmfError(`unsupported SMF format ${format} (only 0 and 1)`);
  }
  if (division & 0x8000) throw new SmfError('SMPTE time division is not supported');
  const ppq = division & 0x7fff;
  if (ppq === 0) throw new SmfError('bad time division (0 PPQN)');

  const tracks: SmfTrack[] = [];
  for (let t = 0; t < trackCount; t++) {
    if (ascii(r.bytes(4)) !== 'MTrk') throw new SmfError(`track ${t}: missing MTrk`);
    const len = r.u32();
    const tr = new Reader(r.bytes(len));
    const notes: MidiNote[] = [];
    /** key|channel<<8 -> { startTick, velocity } of the open note. */
    const open = new Map<number, { tick: number; velocity: number }>();
    let name: string | undefined;
    let tick = 0;
    let status = 0;

    const noteOff = (key: number, ch: number) => {
      const k = key | (ch << 8);
      const on = open.get(k);
      if (!on) return;
      open.delete(k);
      const lengthTicks = Math.max(1, tick - on.tick);
      notes.push({
        startBeat: on.tick / ppq,
        lengthBeats: lengthTicks / ppq,
        key,
        velocity: on.velocity / 127,
        channel: ch,
      });
    };

    while (tr.remaining > 0) {
      tick += tr.vlq();
      let b = tr.u8();
      if (b < 0x80) {
        // Running status: reuse the previous status byte.
        if (status === 0) throw new SmfError(`track ${t}: dangling data byte`);
        tr.pos--;
        b = status;
      }
      if (b === 0xff) {
        const type = tr.u8();
        const len2 = tr.vlq();
        const data = tr.bytes(len2);
        if (type === 0x03 && !name) name = ascii(data);
        status = 0;
        continue;
      }
      if (b === 0xf0 || b === 0xf7) {
        tr.bytes(tr.vlq());
        status = 0;
        continue;
      }
      status = b;
      const kind = b & 0xf0;
      const ch = b & 0x0f;
      switch (kind) {
        case 0x80: {
          const key = tr.u8();
          tr.u8(); // release velocity
          noteOff(key, ch);
          break;
        }
        case 0x90: {
          const key = tr.u8();
          const vel = tr.u8();
          if (vel === 0) {
            noteOff(key, ch);
          } else {
            // Retrigger closes the previous note first.
            noteOff(key, ch);
            open.set(key | (ch << 8), { tick, velocity: vel });
          }
          break;
        }
        case 0xa0:
        case 0xb0:
        case 0xe0:
          tr.bytes(2);
          break;
        case 0xc0:
        case 0xd0:
          tr.bytes(1);
          break;
        default:
          throw new SmfError(`track ${t}: unexpected status 0x${b.toString(16)}`);
      }
    }
    // Close any notes left hanging at end of track.
    for (const k of [...open.keys()]) noteOff(k & 0xff, (k >> 8) & 0x0f);
    notes.sort((a, b2) => a.startBeat - b2.startBeat || a.key - b2.key);
    tracks.push({ name, notes });
  }
  return { format, ppq, tracks };
}

/** All notes of all tracks merged into one beat-sorted list. */
export function smfToNotes(bytes: Uint8Array): MidiNote[] {
  const f = parseSmf(bytes);
  const notes = f.tracks.flatMap((t) => t.notes);
  notes.sort((a, b) => a.startBeat - b.startBeat || a.key - b.key);
  return notes;
}
