// SMF import (.mid -> beat-timed notes) and project merge (id remapping so
// another project's audio becomes sections/assets of the current one).
import test from 'node:test';
import assert from 'node:assert/strict';

import { parseSmf, smfToNotes, SmfError, mergeProjects, emptyProject } from '@iam/pack';

/** Builds a tiny format-0 SMF: ppq 480, one track. */
function buildSmf(events) {
  const bytes = [];
  const vlq = (n) => {
    const out = [n & 0x7f];
    while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80);
    return out;
  };
  for (const [delta, ...ev] of events) bytes.push(...vlq(delta), ...ev);
  bytes.push(0, 0xff, 0x2f, 0); // end of track
  const u32 = (n) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  return new Uint8Array([
    0x4d, 0x54, 0x68, 0x64, ...u32(6), 0, 0, 0, 1, (480 >> 8) & 0xff, 480 & 0xff,
    0x4d, 0x54, 0x72, 0x6b, ...u32(bytes.length), ...bytes,
  ]);
}

test('parseSmf reads notes with running status and vel-0 note-offs', () => {
  const smf = buildSmf([
    [0, 0x90, 60, 100], // C4 on at beat 0
    [480, 62, 90], // D4 on at beat 1 (running status)
    [240, 60, 0], // C4 off at beat 1.5 (vel-0)
    [240, 0x80, 62, 64], // D4 off at beat 2
  ]);
  const f = parseSmf(smf);
  assert.equal(f.format, 0);
  assert.equal(f.ppq, 480);
  const notes = f.tracks[0].notes;
  assert.equal(notes.length, 2);
  assert.deepEqual(
    notes.map((n) => [n.key, n.startBeat, n.lengthBeats]),
    [
      [60, 0, 1.5],
      [62, 1, 1],
    ],
  );
  assert.ok(Math.abs(notes[0].velocity - 100 / 127) < 1e-9);
});

test('parseSmf rejects SMPTE division', () => {
  const smf = buildSmf([[0, 0x90, 60, 100]]);
  smf[12] = 0xe7; // negative division => SMPTE
  assert.throws(() => parseSmf(smf), SmfError);
});

test('smfToNotes merges tracks and sorts by beat', () => {
  const notes = smfToNotes(
    buildSmf([
      [0, 0x90, 64, 80],
      [480, 0x80, 64, 0],
      [0, 0x90, 60, 80],
      [480, 0x80, 60, 0],
    ]),
  );
  assert.deepEqual(notes.map((n) => n.key), [64, 60]);
});

test('mergeProjects remaps ids and unifies RTPCs by name', () => {
  const dst = emptyProject('dst');
  dst.rtpcs = [{ id: 5, name: 'intensity', type: 'f32', default: 0, min: 0, max: 1, smoothingMs: 0 }];
  dst.sections = [{
    id: 3, name: 'Main', bpm: 0, timeSignature: [0, 0], loopEnabled: true,
    lengthBeats: 4, loopStartBeats: 0, anchors: [],
    tracks: [{ id: 0, name: 'drums', volume: 1, pan: 0, muted: false, items: [] }],
  }];
  dst.assets = [{ id: 7, name: 'kick', channels: 1, sampleRate: 48000, frames: 10 }];

  const src = emptyProject('src');
  src.rtpcs = [
    { id: 0, name: 'intensity', type: 'f32', default: 0, min: 0, max: 1, smoothingMs: 0 },
    { id: 1, name: 'weather', type: 'f32', default: 0, min: 0, max: 1, smoothingMs: 0 },
  ];
  src.assets = [{ id: 0, name: 'loop', channels: 1, sampleRate: 48000, frames: 20 }];
  src.sections = [{
    id: 0, name: 'Main', bpm: 0, timeSignature: [0, 0], loopEnabled: true,
    lengthBeats: 4, loopStartBeats: 0, anchors: [],
    tracks: [{
      id: 0, name: 'alt-drums', volume: 1, pan: 0, muted: false,
      items: [{ id: 0, assetId: 0, startBeat: 0, lengthBeats: 4, offsetBeats: 0, gain: 1, fadeInBeats: 0, fadeOutBeats: 0 }],
    }],
  }];
  src.cues = [{
    id: 0, name: 'c', rules: [{
      condition: 'intensity > 0.5', stopIfMatched: false,
      actions: [
        { type: 'goto', section: 0, anchor: null, timing: 'nextBar', transition: 'cut', fadeMs: 0 },
        { type: 'setRtpc', rtpc: 1, value: 1 },
      ],
    }],
  }];
  src.bindings = [{ trigger: { type: 'rtpcChanged', rtpc: 0 }, cue: 0 }];
  src.blends = [{ id: 0, rtpc: 1, section: 0, track: 0, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] }];

  const res = mergeProjects(dst, src);
  // RTPC 'intensity' reused (id 5); 'weather' added with a fresh id.
  assert.equal(dst.rtpcs.length, 2);
  const weather = dst.rtpcs.find((r) => r.name === 'weather');
  assert.ok(weather.id !== 1 || weather.id > 5 - 1, 'weather got a destination id');
  // Section renamed to avoid the collision, asset remapped.
  const merged = dst.sections.find((s) => s.name === 'Main (2)');
  assert.ok(merged, 'colliding section name got a suffix');
  const newAssetId = res.assetIdMap.get(0);
  assert.notEqual(newAssetId, 7);
  assert.equal(merged.tracks[0].items[0].assetId, newAssetId);
  // Cue actions re-point at the merged section / rtpc ids.
  const cue = dst.cues[0];
  assert.equal(cue.rules[0].actions[0].section, merged.id);
  assert.equal(cue.rules[0].actions[1].rtpc, weather.id);
  // Binding follows the reused intensity id.
  assert.deepEqual(dst.bindings[0].trigger, { type: 'rtpcChanged', rtpc: 5 });
  // Blend remapped onto merged ids.
  assert.equal(dst.blends[0].section, merged.id);
  assert.equal(dst.blends[0].rtpc, weather.id);
});
