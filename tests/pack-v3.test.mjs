// IAMP v3 format: new chunks (BLND/PMOD/NSRC) and actions round-trip through
// encode/decode, the engine loads v3 packs, and v2 packs still decode/play.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  encodePack,
  decodePack,
  extractPack,
  buildIamWasm,
  PACK_VERSION,
} from '@iam/pack';
import { IamCore } from '@iam/player';

const SR = 48000;
const engineWasm = new Uint8Array(
  await readFile(fileURLToPath(new URL('../runtime/engine.wasm', import.meta.url))),
);

function tone(frames, amp) {
  return new Float32Array(frames).fill(amp);
}

function v3Project() {
  return {
    formatVersion: 1,
    name: 'v3 roundtrip',
    bankSampleRate: SR,
    bpm: 120,
    timeSignature: [4, 4],
    startSectionId: 0,
    rtpcs: [
      { id: 1, name: 'intensity', type: 'f32', default: 0, min: 0, max: 1, smoothingMs: 0 },
    ],
    plugins: [{ id: 0, name: 'gen', clapPluginId: 'g', url: 'u', embedded: false }],
    pluginInstances: [
      { id: 0, pluginBankId: 0, params: [] },
      { id: 1, pluginBankId: 0, params: [] },
    ],
    masterEffects: [],
    sections: [
      {
        id: 0, name: 'A', bpm: 0, timeSignature: [0, 0],
        loopEnabled: true, lengthBeats: 4, loopStartBeats: 0,
        tracks: [
          { id: 0, name: 'base', volume: 1, pan: 0, muted: false, items: [
            { id: 0, assetId: 0, startBeat: 0, lengthBeats: 4, offsetBeats: 0, gain: 1, fadeInBeats: 0, fadeOutBeats: 0 },
          ] },
          { id: 1, name: 'layer', volume: 1, pan: 0, muted: false, items: [
            { id: 1, assetId: 1, startBeat: 0, lengthBeats: 4, offsetBeats: 0, gain: 1, fadeInBeats: 0, fadeOutBeats: 0 },
          ] },
        ],
        anchors: [],
      },
      {
        id: 1, name: 'B', bpm: 0, timeSignature: [0, 0],
        loopEnabled: false, lengthBeats: 4, loopStartBeats: 0,
        tracks: [
          { id: 0, name: 'alt', volume: 1, pan: 0, muted: false, items: [
            { id: 0, assetId: 1, startBeat: 0, lengthBeats: 4, offsetBeats: 0, gain: 1, fadeInBeats: 0, fadeOutBeats: 0 },
          ] },
        ],
        anchors: [],
      },
    ],
    cues: [
      { id: 0, name: 'v3_actions', rules: [
        { condition: '', stopIfMatched: false, actions: [
          { type: 'setTrackGain', section: 0, track: 1, gain: 0.5, fadeMs: 10, timing: 'nextBar' },
          { type: 'setTrackGain', section: 0, track: 1, gain: 0, fadeMs: 0, gainExpr: 'intensity * 0.5' },
          { type: 'gotoTrack', section: 0, track: 1, sourceSection: 1, sourceTrack: 0, timing: 'nextBar', transition: 'crossfade', fadeMs: 50 },
          { type: 'gotoTrack', section: 0, track: 1, sourceSection: null, sourceTrack: null, timing: 'immediate', transition: 'cut', fadeMs: 0 },
          { type: 'setPluginParam', instance: 0, param: 7, value: 0.25 },
          { type: 'setPluginParam', instance: 0, param: 8, value: 0, valueExpr: 'intensity' },
          { type: 'setRtpc', rtpc: 1, value: 0, valueExpr: '1 - intensity' },
        ] },
      ] },
    ],
    bindings: [{ trigger: { type: 'moduleStart' }, cue: 0 }],
    assets: [
      { id: 0, name: 'a', channels: 1, sampleRate: SR, frames: SR },
      { id: 1, name: 'b', channels: 1, sampleRate: SR, frames: SR },
    ],
    blends: [
      { id: 0, rtpc: 1, section: 0, track: 1, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
    ],
    paramMods: [
      // Values exactly representable in f32 so deepEqual survives the roundtrip.
      { instance: 0, param: 3, rtpc: 1, points: [{ x: 0, y: 0.25 }, { x: 1, y: 0.75 }] },
    ],
    noteSources: [{ generator: 0, target: 1 }],
  };
}

function v3Assets() {
  return [
    { id: 0, name: 'a', channels: 1, sampleRate: SR, frames: SR, format: 'f32', data: tone(SR, 0.25) },
    { id: 1, name: 'b', channels: 1, sampleRate: SR, frames: SR, format: 'f32', data: tone(SR, 0.5) },
  ];
}

test('v3 chunks and actions round-trip through encode/decode', () => {
  const pack = encodePack(v3Project(), v3Assets(), { includeMeta: true });
  const dec = decodePack(pack);
  assert.equal(dec.name, 'v3 roundtrip');
  assert.deepEqual(dec.blends, v3Project().blends);
  assert.deepEqual(dec.paramMods, v3Project().paramMods);
  assert.deepEqual(dec.noteSources, v3Project().noteSources);
  // META carries the full project including the new arrays and actions.
  assert.equal(dec.project.cues[0].rules[0].actions.length, 7);
  assert.equal(dec.project.blends.length, 1);
});

test('the engine loads a v3 pack and plays it', async () => {
  const pack = encodePack(v3Project(), v3Assets(), { includeMeta: false });
  const core = await IamCore.create(buildIamWasm(engineWasm, pack));
  core.init(SR, 2);
  core.play();
  const out = core.render(256);
  let e = 0;
  for (const s of out) e += Math.abs(s);
  assert.ok(e > 1, 'v3 module renders audio');
});

test('a v2 pack still decodes and plays on the v3 stack', async () => {
  const fixture = new Uint8Array(
    await readFile(fileURLToPath(new URL('./fixtures/v2-mini.iam.wasm', import.meta.url))),
  );
  const pack = extractPack(fixture);
  assert.ok(pack, 'fixture contains an iam.pack section');
  const dec = decodePack(pack);
  assert.equal(dec.name, 'V2 Fixture');
  assert.equal(dec.blends.length, 0);
  // Re-wrap the v2 pack around the freshly built v3 engine and play it.
  const core = await IamCore.create(buildIamWasm(engineWasm, pack));
  core.init(SR, 2);
  core.play();
  const out = core.render(256);
  assert.ok(Math.abs(out[0]) > 0.01, 'v2 pack is audible on the v3 engine');
  // The v2 cue still works: raising `energy` jumps to section B.
  core.setRtpc('energy', 1);
  core.render(256);
  assert.equal(core.currentSection, 'B');
});

test('encoder writes PACK_VERSION 3', () => {
  const pack = encodePack(v3Project(), v3Assets(), { includeMeta: false });
  const version = new DataView(pack.buffer, pack.byteOffset).getUint32(4, true);
  assert.equal(version, 3);
  assert.equal(PACK_VERSION, 3);
});
