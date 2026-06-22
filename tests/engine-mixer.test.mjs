// Live mixer ABI: track volume/pan/mute can be changed during playback without
// rebuilding the module, and the engine exposes the instrument track's
// volume/mute so a host that renders synths externally can honor the mixer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { encodePack, buildIamWasm } from '@iam/pack';
import { IamCore } from '@iam/player';

const SR = 48000;
const engineWasm = new Uint8Array(
  await readFile(fileURLToPath(new URL('../runtime/engine.wasm', import.meta.url))),
);

function project() {
  return {
    formatVersion: 1,
    name: 'mixer',
    bankSampleRate: SR,
    bpm: 120,
    timeSignature: [4, 4],
    startSectionId: 0,
    rtpcs: [],
    plugins: [{ id: 0, name: 's', clapPluginId: 'x', url: 'u', embedded: false }],
    pluginInstances: [{ id: 0, pluginBankId: 0, params: [] }],
    masterEffects: [],
    sections: [
      {
        id: 0,
        name: 'A',
        bpm: 0,
        timeSignature: [0, 0],
        loopEnabled: true,
        lengthBeats: 4,
        loopStartBeats: 0,
        tracks: [
          {
            id: 0,
            name: 'pcm',
            volume: 1,
            pan: 0,
            muted: false,
            items: [
              { id: 0, assetId: 0, startBeat: 0, lengthBeats: 4, offsetBeats: 0, gain: 1, fadeInBeats: 0, fadeOutBeats: 0 },
            ],
          },
          {
            id: 1,
            name: 'lead',
            volume: 1,
            pan: 0,
            muted: false,
            kind: 'instrument',
            instrument: 0,
            items: [],
            notes: [{ startBeat: 0, lengthBeats: 1, key: 60, velocity: 1, channel: 0 }],
          },
        ],
        anchors: [],
      },
    ],
    cues: [],
    bindings: [],
    assets: [{ id: 0, name: 'a', channels: 1, sampleRate: SR, frames: SR }],
  };
}

function makeCore() {
  const asset = {
    id: 0, name: 'a', channels: 1, sampleRate: SR, frames: SR,
    format: 'f32', data: new Float32Array(SR).fill(0.5),
  };
  const pack = encodePack(project(), [asset], { includeMeta: true });
  return IamCore.create(buildIamWasm(engineWasm, pack));
}

test('PCM track volume/mute change live during playback', async () => {
  const core = await makeCore();
  core.init(SR, 2);
  core.play();
  const energy = () => {
    const out = core.render(256);
    let e = 0;
    for (let i = 0; i < 256 * 2; i++) e += Math.abs(out[i]);
    return e;
  };
  const base = energy();
  assert.ok(base > 1, 'full-volume PCM is audible');
  core.setTrackVolume(0, 0, 0.5);
  const half = energy();
  assert.ok(half < base * 0.75 && half > base * 0.25, `volume 0.5 roughly halves (base=${base}, half=${half})`);
  core.setTrackMute(0, 0, true);
  assert.ok(energy() < 1e-3, 'muted track is silent');
});

test('instrument_gain reflects the instrument track volume/mute live', async () => {
  const core = await makeCore();
  core.init(SR, 2);
  core.play();
  assert.equal(core.instrumentGain(0), 1, 'default instrument gain is 1');
  core.setTrackVolume(0, 1, 0.3);
  assert.ok(Math.abs(core.instrumentGain(0) - 0.3) < 1e-5, 'gain follows volume');
  core.setTrackMute(0, 1, true);
  assert.equal(core.instrumentGain(0), 0, 'muted instrument gain is 0');
  // Unknown instance stays audible (1.0) rather than silencing tails.
  assert.equal(core.instrumentGain(99), 1, 'unknown instance defaults to 1');
});
