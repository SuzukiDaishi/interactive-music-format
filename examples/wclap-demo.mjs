#!/usr/bin/env node
/**
 * Builds examples/out/wclap_demo.iam.wasm: a self-contained module that embeds a
 * real WCLAP synth (and limiter) and plays an instrument (MIDI) track, with a
 * bridge/transition section between two parts. Then renders it offline through
 * the engine + WclapRack to confirm it is audible.
 *
 *   node examples/wclap-demo.mjs [output.iam.wasm]
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { encodePack, buildIamWasm } from '@iam/pack';
import { IamCore, loadWclapBundle, buildTrampolineModule, WclapRack } from '@iam/player';

const root = fileURLToPath(new URL('..', import.meta.url));
const SR = 48000;
const engine = new Uint8Array(await readFile(path.join(root, 'runtime', 'engine.wasm')));
const synthTgz = new Uint8Array(
  await readFile(path.join(root, 'wclap', 'z-audio-simple-synth.wclap.tar.gz')),
);
const limiterTgz = new Uint8Array(
  await readFile(path.join(root, 'wclap', 'z-audio-limiter.wclap.tar.gz')),
);

// Two phrases over an instrument track, joined by a one-shot bridge section.
const scale = [60, 62, 64, 65, 67, 69, 71, 72];
const phrase = (offset) =>
  scale.map((k, i) => ({ startBeat: i * 0.5, lengthBeats: 0.5, key: k + offset, velocity: 0.9, channel: 0 }));

function instrTrack(notes) {
  return {
    id: 0, name: 'Lead', volume: 1, pan: 0, muted: false,
    kind: 'instrument', instrument: 0, items: [], notes, effects: [],
  };
}
function section(id, name, notes, loop) {
  return {
    id, name, bpm: 0, timeSignature: [0, 0], loopEnabled: loop,
    lengthBeats: 4, loopStartBeats: 0, tracks: [instrTrack(notes)], anchors: [],
  };
}

const project = {
  formatVersion: 1,
  name: 'WCLAP MIDI Demo',
  bankSampleRate: SR,
  bpm: 120,
  timeSignature: [4, 4],
  startSectionId: 0,
  rtpcs: [],
  plugins: [
    { id: 0, name: 'Z Audio Simple Synth', clapPluginId: 'dev.zaudio.simple-synth', embedded: true },
    { id: 1, name: 'Z Audio Limiter', embedded: true },
  ],
  pluginInstances: [
    { id: 0, pluginBankId: 0, params: [] }, // synth (instrument)
    { id: 1, pluginBankId: 1, params: [] }, // limiter (master effect)
  ],
  masterEffects: [1],
  sections: [
    section(0, 'PartA', phrase(0), true),
    section(1, 'Fill', phrase(7).slice(0, 4), false), // bridge: short fill, no loop
    section(2, 'PartB', phrase(5), true),
  ],
  cues: [
    {
      id: 0, name: 'to_partB',
      rules: [
        {
          condition: '', stopIfMatched: false,
          actions: [
            // 横遷移: route PartA -> Fill (bridge) -> PartB on the next bar.
            { type: 'goto', section: 2, anchor: null, timing: 'nextBar', transition: 'crossfade', fadeMs: 80, bridge: 1 },
          ],
        },
      ],
    },
  ],
  bindings: [],
  assets: [],
};

const pack = encodePack(project, [], {}, [
  { id: 0, name: 'Z Audio Simple Synth', data: synthTgz },
  { id: 1, name: 'Z Audio Limiter', data: limiterTgz },
]);
const iamWasm = buildIamWasm(engine, pack);

const outPath = process.argv[2] ?? path.join(root, 'examples', 'out', 'wclap_demo.iam.wasm');
await mkdir(path.dirname(outPath), { recursive: true });
await writeFile(outPath, iamWasm);
console.log(`wrote ${outPath} (${(iamWasm.length / 1024).toFixed(0)} KB, plugins embedded)`);

// --- offline render through the engine + WCLAP rack -------------------------
const core = await IamCore.create(iamWasm);
core.init(SR, 2);

const synth = await loadWclapBundle(synthTgz);
const limiter = await loadWclapBundle(limiterTgz);
const trampoline = buildTrampolineModule();
const block = 512;
const rack = new WclapRack(
  [
    { instanceId: 0, module: new WebAssembly.Module(synth.moduleBytes), audioInputs: 0 },
    { instanceId: 1, module: new WebAssembly.Module(limiter.moduleBytes), audioInputs: 1 },
  ],
  { instruments: [{ instanceId: 0, effects: [] }], masterEffects: [1] },
  { sampleRate: SR, maxFrames: block, trampoline },
);

core.play();
const bus = new Float32Array(block * 2);
let energy = 0;
let triggered = false;
const totalFrames = Math.round(6 * SR);
for (let done = 0; done < totalFrames; done += block) {
  const n = Math.min(block, totalFrames - done);
  const pcm = core.render(n);
  bus.set(pcm.subarray(0, n * 2));
  rack.handleMidi(core.pollMidiEvents());
  rack.render(bus, n);
  for (let i = 0; i < n * 2; i++) energy += Math.abs(bus[i]);
  if (!triggered && done > SR) {
    core.triggerCue('to_partB');
    triggered = true;
  }
}
console.log(`offline render: section=${core.currentSection} mix energy=${energy.toFixed(0)} (audible: ${energy > 100})`);
rack.destroy();
