// Guards the DAW/GUI-facing paths after the v2 changes: project defaults,
// migration of older projects, the AudioWorklet source string (which inlines the
// CLAP host and cannot be type-checked), and the exact encode call the DAW's
// preview/export uses.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  emptyProject,
  normalizeProject,
  encodePack,
  decodePack,
  buildIamWasm,
} from '@iam/pack';
import { IamCore, IAM_WORKLET_SOURCE } from '@iam/player';

const SR = 48000;
const engineWasm = new Uint8Array(
  await readFile(fileURLToPath(new URL('../runtime/engine.wasm', import.meta.url))),
);

test('emptyProject ships the v2 arrays so the DAW store is well-formed', () => {
  const p = emptyProject('New Project');
  assert.deepEqual(p.plugins, []);
  assert.deepEqual(p.pluginInstances, []);
  assert.deepEqual(p.masterEffects, []);
});

test('normalizeProject backfills missing fields from an older project', () => {
  // Shape of a pre-v2 META project (no plugin arrays, track without kind/notes).
  const old = {
    formatVersion: 1,
    name: 'Old',
    bankSampleRate: SR,
    bpm: 120,
    timeSignature: [4, 4],
    startSectionId: 0,
    rtpcs: [],
    sections: [{ id: 0, name: 'A', bpm: 0, timeSignature: [0, 0], loopEnabled: true, lengthBeats: 4, loopStartBeats: 0, tracks: [{ id: 0, name: 't', volume: 1, pan: 0, muted: false, items: [] }], anchors: [] }],
    cues: [],
    bindings: [],
    assets: [],
  };
  const n = normalizeProject(old);
  assert.deepEqual(n.plugins, []);
  assert.deepEqual(n.pluginInstances, []);
  assert.deepEqual(n.masterEffects, []);
  assert.equal(n.sections[0].tracks[0].kind, 'audio');
  // Encoding a normalized old project must not throw.
  assert.doesNotThrow(() => encodePack(n, []));
});

test('AudioWorklet source (with inlined CLAP host) parses and evaluates', () => {
  // The worklet runs as a string in an AudioWorkletGlobalScope; verify it is at
  // least syntactically valid and defines its processor without throwing.
  const g = globalThis;
  const prevAWP = g.AudioWorkletProcessor;
  const prevReg = g.registerProcessor;
  const prevSr = g.sampleRate;
  let registered = null;
  g.AudioWorkletProcessor = class {};
  g.registerProcessor = (name) => { registered = name; };
  g.sampleRate = SR;
  try {
    new Function(IAM_WORKLET_SOURCE)();
  } finally {
    g.AudioWorkletProcessor = prevAWP;
    g.registerProcessor = prevReg;
    g.sampleRate = prevSr;
  }
  assert.equal(registered, 'iam-player-processor');
});

// A project shaped like what the DAW produces, including an instrument track and
// a bridge transition, exported via the same call the preview uses.
function dawProject() {
  const p = emptyProject('DAW Project');
  p.bankSampleRate = SR;
  p.startSectionId = 0;
  p.plugins = [{ id: 0, name: 'Synth', clapPluginId: 'x', url: 'wclap/synth', embedded: false }];
  p.pluginInstances = [{ id: 0, pluginBankId: 0, params: [] }];
  p.sections = [
    {
      id: 0, name: 'A', bpm: 0, timeSignature: [0, 0], loopEnabled: true, lengthBeats: 4, loopStartBeats: 0,
      tracks: [
        { id: 0, name: 'Lead', volume: 1, pan: 0, muted: false, kind: 'instrument', instrument: 0, items: [], notes: [{ startBeat: 0, lengthBeats: 1, key: 60, velocity: 0.9, channel: 0 }], effects: [] },
      ],
      anchors: [],
    },
    { id: 1, name: 'Fill', bpm: 0, timeSignature: [0, 0], loopEnabled: false, lengthBeats: 1, loopStartBeats: 0, tracks: [], anchors: [] },
    { id: 2, name: 'B', bpm: 0, timeSignature: [0, 0], loopEnabled: true, lengthBeats: 4, loopStartBeats: 0, tracks: [], anchors: [] },
  ];
  p.cues = [
    { id: 0, name: 'to_b', rules: [{ condition: '', stopIfMatched: false, actions: [{ type: 'goto', section: 2, anchor: null, timing: 'nextBar', transition: 'crossfade', fadeMs: 80, bridge: 1 }] }] },
  ];
  return p;
}

test('DAW preview/export build (f32 + META) round-trips and plays', async () => {
  const project = dawProject();
  // Mirrors preview.buildModule: f32 assets, includeMeta true.
  const pack = encodePack(project, [], { includeMeta: true });
  const iamWasm = buildIamWasm(engineWasm, pack);

  // Re-import path (TopBar "Open .iam.wasm" -> importIamWasm -> loadProject).
  const dec = decodePack(pack);
  assert.ok(dec.project, 'META present for re-import');
  const lead = normalizeProject(dec.project).sections[0].tracks[0];
  assert.equal(lead.kind, 'instrument');
  assert.equal(lead.notes[0].key, 60);
  assert.equal(dec.project.cues[0].rules[0].actions[0].bridge, 1);

  // The engine loads and runs it (no audio items -> instrument MIDI only).
  const core = await IamCore.create(iamWasm);
  core.init(SR, 2);
  core.play();
  let midi = 0;
  for (let i = 0; i < 200; i++) {
    core.render(480);
    midi += core.pollMidiEvents().length;
  }
  assert.ok(midi > 0, 'engine emitted MIDI for the instrument track');
});
