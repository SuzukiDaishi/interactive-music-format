// Full chain: the engine sequences an instrument track's notes, the WclapRack
// hosts the real Z Audio synth, and the combined mix is audible. This is the
// "JS playback" path proven end-to-end (offline render).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { encodePack, buildIamWasm } from '@iam/pack';
import { IamCore, loadWclapBundle, buildTrampolineModule, WclapRack } from '@iam/player';

const SR = 48000;
const engineWasm = new Uint8Array(
  await readFile(fileURLToPath(new URL('../runtime/engine.wasm', import.meta.url))),
);
const wclapDir = fileURLToPath(new URL('../wclap/', import.meta.url));

function project() {
  return {
    formatVersion: 1,
    name: 'Synth Demo',
    bankSampleRate: SR,
    bpm: 120,
    timeSignature: [4, 4],
    startSectionId: 0,
    rtpcs: [],
    plugins: [
      { id: 0, name: 'Synth', clapPluginId: 'dev.zaudio.simple-synth', url: 'wclap/synth', embedded: false },
    ],
    pluginInstances: [{ id: 0, pluginBankId: 0, params: [] }],
    masterEffects: [],
    sections: [
      {
        id: 0,
        name: 'Loop',
        bpm: 0,
        timeSignature: [0, 0],
        loopEnabled: false,
        lengthBeats: 4,
        loopStartBeats: 0,
        tracks: [
          {
            id: 0,
            name: 'Lead',
            volume: 1,
            pan: 0,
            muted: false,
            kind: 'instrument',
            instrument: 0,
            items: [],
            notes: [
              { startBeat: 0, lengthBeats: 1, key: 60, velocity: 1.0, channel: 0 },
              { startBeat: 1, lengthBeats: 1, key: 64, velocity: 1.0, channel: 0 },
              { startBeat: 2, lengthBeats: 2, key: 67, velocity: 1.0, channel: 0 },
            ],
          },
        ],
        anchors: [],
      },
    ],
    cues: [],
    bindings: [],
    assets: [],
  };
}

test('engine-sequenced WCLAP synth produces an audible mix', async () => {
  const pack = encodePack(project(), []);
  const core = await IamCore.create(buildIamWasm(engineWasm, pack));
  core.init(SR, 2);

  const { moduleBytes } = await loadWclapBundle(
    new Uint8Array(await readFile(wclapDir + 'z-audio-simple-synth.wclap.tar.gz')),
  );
  const module = new WebAssembly.Module(moduleBytes);
  const trampoline = buildTrampolineModule();
  const block = 512;
  const rack = new WclapRack(
    [{ instanceId: 0, module, audioInputs: 0 }],
    { instruments: [{ instanceId: 0, effects: [] }], masterEffects: [] },
    { sampleRate: SR, maxFrames: block, trampoline },
  );
  assert.equal(rack.size, 1, 'synth instance created');

  core.play();
  const bus = new Float32Array(block * 2);
  let energy = 0;
  const totalFrames = Math.round(1.6 * SR); // first ~3 notes
  for (let done = 0; done < totalFrames; done += block) {
    const n = Math.min(block, totalFrames - done);
    const pcm = core.render(n); // engine PCM (no audio items here -> ~silent)
    bus.set(pcm.subarray(0, n * 2));
    rack.handleMidi(core.pollMidiEvents());
    rack.render(bus, n);
    for (let i = 0; i < n * 2; i++) energy += Math.abs(bus[i]);
  }
  assert.ok(energy > 50, `audible synth mix from engine MIDI (energy=${energy})`);
  rack.destroy();
});

test('planRack computes instrument/effect routing and audio inputs', async () => {
  const { planRack } = await import('@iam/player');
  const project = {
    sections: [
      {
        id: 0, name: 'A', tracks: [
          { id: 0, name: 'lead', kind: 'instrument', instrument: 0, items: [], effects: [2] },
          { id: 1, name: 'pcm', items: [] },
        ],
      },
    ],
    pluginInstances: [
      { id: 0, pluginBankId: 0, params: [{ id: 1, value: 0.5 }] },
      { id: 2, pluginBankId: 1, params: [] },
      { id: 3, pluginBankId: 2, params: [] },
    ],
    masterEffects: [3],
    plugins: [],
  };
  const plan = planRack(project);
  assert.ok(plan);
  const byId = Object.fromEntries(plan.instances.map((i) => [i.instanceId, i]));
  assert.equal(byId[0].audioInputs, 0, 'instrument has no audio input');
  assert.equal(byId[2].audioInputs, 1, 'insert effect has an audio input');
  assert.equal(byId[3].audioInputs, 1, 'master effect has an audio input');
  assert.deepEqual(plan.routing.instruments, [{ instanceId: 0, effects: [2] }]);
  assert.deepEqual(plan.routing.masterEffects, [3]);
});
