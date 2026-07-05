// Script-graph compiler: graphs flatten into generated cues/bindings, value
// subgraphs become expressions, and an exported module driven by a graph
// behaves correctly end-to-end on the engine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  compileGraphs,
  checkGraphs,
  projectWithCompiledGraphs,
  GRAPH_CUE_ID_BASE,
  encodePack,
  decodePack,
  buildIamWasm,
} from '@iam/pack';
import { IamCore } from '@iam/player';

const SR = 48000;
const engineWasm = new Uint8Array(
  await readFile(fileURLToPath(new URL('../runtime/engine.wasm', import.meta.url))),
);

function baseProject() {
  return {
    formatVersion: 1,
    name: 'graph test',
    bankSampleRate: SR,
    bpm: 120,
    timeSignature: [4, 4],
    startSectionId: 0,
    rtpcs: [
      { id: 1, name: 'intensity', type: 'f32', default: 0, min: 0, max: 1, smoothingMs: 0 },
    ],
    plugins: [],
    pluginInstances: [],
    masterEffects: [],
    sections: [
      {
        id: 0, name: 'Calm', bpm: 0, timeSignature: [0, 0],
        loopEnabled: true, lengthBeats: 4, loopStartBeats: 0,
        tracks: [
          { id: 0, name: 't', volume: 1, pan: 0, muted: false, items: [
            { id: 0, assetId: 0, startBeat: 0, lengthBeats: 4, offsetBeats: 0, gain: 1, fadeInBeats: 0, fadeOutBeats: 0 },
          ] },
        ],
        anchors: [],
      },
      {
        id: 1, name: 'Battle', bpm: 0, timeSignature: [0, 0],
        loopEnabled: true, lengthBeats: 4, loopStartBeats: 0,
        tracks: [
          { id: 0, name: 't', volume: 1, pan: 0, muted: false, items: [
            { id: 0, assetId: 1, startBeat: 0, lengthBeats: 4, offsetBeats: 0, gain: 1, fadeInBeats: 0, fadeOutBeats: 0 },
          ] },
        ],
        anchors: [],
      },
    ],
    cues: [],
    bindings: [],
    assets: [
      { id: 0, name: 'a', channels: 1, sampleRate: SR, frames: SR },
      { id: 1, name: 'b', channels: 1, sampleRate: SR, frames: SR },
    ],
    blends: [], paramMods: [], noteSources: [],
    graphs: [],
  };
}

function assets() {
  const tone = (amp) => {
    const d = new Float32Array(SR);
    d.fill(amp);
    return d;
  };
  return [
    { id: 0, name: 'a', channels: 1, sampleRate: SR, frames: SR, format: 'f32', data: tone(0.25) },
    { id: 1, name: 'b', channels: 1, sampleRate: SR, frames: SR, format: 'f32', data: tone(0.5) },
  ];
}

/** onRtpcChanged(intensity) -> branch(intensity >= 0.5) -> then: goto Battle,
 *  else: goto Calm. */
function battleGraph() {
  return {
    id: 1,
    name: 'battle switch',
    nodes: [
      { id: 'trig', kind: 'onRtpcChanged', x: 0, y: 0, data: { rtpc: 1 } },
      { id: 'val', kind: 'rtpcValue', x: 0, y: 100, data: { rtpc: 1 } },
      { id: 'half', kind: 'constant', x: 0, y: 200, data: { value: 0.5 } },
      { id: 'cmp', kind: 'compare', x: 100, y: 150, data: { op: '>=' } },
      { id: 'br', kind: 'branch', x: 200, y: 0, data: {} },
      { id: 'toB', kind: 'goto', x: 300, y: 0, data: { section: 1, anchor: null, timing: 'immediate', transition: 'cut', fadeMs: 0 } },
      { id: 'toC', kind: 'goto', x: 300, y: 100, data: { section: 0, anchor: null, timing: 'immediate', transition: 'cut', fadeMs: 0 } },
    ],
    edges: [
      { from: 'trig', fromPort: 'out', to: 'br', toPort: 'in' },
      { from: 'val', fromPort: 'value', to: 'cmp', toPort: 'a' },
      { from: 'half', fromPort: 'value', to: 'cmp', toPort: 'b' },
      { from: 'cmp', fromPort: 'value', to: 'br', toPort: 'cond' },
      { from: 'br', fromPort: 'then', to: 'toB', toPort: 'in' },
      { from: 'br', fromPort: 'else', to: 'toC', toPort: 'in' },
    ],
  };
}

test('compileGraphs produces a cue + binding with branch conditions', () => {
  const project = baseProject();
  project.graphs = [battleGraph()];
  const { cues, bindings } = compileGraphs(project);
  assert.equal(cues.length, 1);
  assert.equal(bindings.length, 1);
  assert.equal(cues[0].id, GRAPH_CUE_ID_BASE);
  assert.deepEqual(bindings[0], { trigger: { type: 'rtpcChanged', rtpc: 1 }, cue: GRAPH_CUE_ID_BASE });
  assert.equal(cues[0].rules.length, 2);
  assert.equal(cues[0].rules[0].condition, '(intensity >= 0.5)');
  assert.equal(cues[0].rules[0].actions[0].type, 'goto');
  assert.equal(cues[0].rules[0].actions[0].section, 1);
  assert.equal(cues[0].rules[1].condition, '!(intensity >= 0.5)');
  assert.equal(cues[0].rules[1].actions[0].section, 0);
  assert.deepEqual(checkGraphs(project), []);
});

test('a chained action sequence lands in one rule; manual cue keeps its name', () => {
  const project = baseProject();
  project.graphs = [{
    id: 2,
    name: 'seq',
    nodes: [
      { id: 't', kind: 'onManualCue', x: 0, y: 0, data: { name: 'do_things' } },
      { id: 'a1', kind: 'emit', x: 1, y: 0, data: { code: 7 } },
      { id: 'a2', kind: 'setRtpc', x: 2, y: 0, data: { rtpc: 1, value: 0.25 } },
    ],
    edges: [
      { from: 't', fromPort: 'out', to: 'a1', toPort: 'in' },
      { from: 'a1', fromPort: 'out', to: 'a2', toPort: 'in' },
    ],
  }];
  const { cues, bindings } = compileGraphs(project);
  assert.equal(cues.length, 1);
  assert.equal(cues[0].name, 'do_things');
  assert.equal(bindings.length, 0, 'manual cues have no binding');
  assert.equal(cues[0].rules.length, 1);
  assert.deepEqual(cues[0].rules[0].actions.map((a) => a.type), ['emit', 'setRtpc']);
});

test('value input on an action becomes a dynamic expression slot', () => {
  const project = baseProject();
  project.graphs = [{
    id: 3,
    name: 'dyn',
    nodes: [
      { id: 't', kind: 'onManualCue', x: 0, y: 0, data: { name: 'duck' } },
      { id: 'v', kind: 'rtpcValue', x: 0, y: 1, data: { rtpc: 1 } },
      { id: 'h', kind: 'constant', x: 0, y: 2, data: { value: 0.5 } },
      { id: 'm', kind: 'math', x: 0, y: 3, data: { op: '*' } },
      { id: 'g', kind: 'setTrackGain', x: 1, y: 0, data: { section: 0, track: 0, gain: 1, fadeMs: 0, timing: 'immediate' } },
    ],
    edges: [
      { from: 't', fromPort: 'out', to: 'g', toPort: 'in' },
      { from: 'v', fromPort: 'value', to: 'm', toPort: 'a' },
      { from: 'h', fromPort: 'value', to: 'm', toPort: 'b' },
      { from: 'm', fromPort: 'value', to: 'g', toPort: 'gain' },
    ],
  }];
  const { cues } = compileGraphs(project);
  assert.equal(cues[0].rules[0].actions[0].gainExpr, '(intensity * 0.5)');
});

test('graph-driven module behaves correctly on the engine (end to end)', async () => {
  const project = baseProject();
  project.graphs = [battleGraph()];
  const pack = encodePack(project, assets(), { includeMeta: true });

  // META keeps the authoring model: graphs, no generated cues.
  const dec = decodePack(pack);
  assert.equal(dec.project.graphs.length, 1);
  assert.equal(dec.project.cues.length, 0);
  // The binary CUES chunk carries the generated cue.
  assert.equal(dec.cues.length, 1);

  const core = await IamCore.create(buildIamWasm(engineWasm, pack));
  core.init(SR, 2);
  core.play();
  core.render(256);
  assert.equal(core.currentSection, 'Calm');
  core.setRtpc('intensity', 0.9);
  core.render(256);
  assert.equal(core.currentSection, 'Battle', 'graph goto fired via RTPC');
  core.setRtpc('intensity', 0.1);
  core.render(256);
  assert.equal(core.currentSection, 'Calm', 'else path returns to Calm');
});

test('checkGraphs reports structural problems with node context', () => {
  const project = baseProject();
  project.graphs = [{
    id: 9,
    name: 'broken',
    nodes: [
      { id: 't', kind: 'onManualCue', x: 0, y: 0, data: { name: 'x' } },
      { id: 'br', kind: 'branch', x: 1, y: 0, data: {} },
      { id: 'a', kind: 'emit', x: 2, y: 0, data: { code: 1 } },
    ],
    edges: [
      { from: 't', fromPort: 'out', to: 'br', toPort: 'in' },
      { from: 'br', fromPort: 'then', to: 'a', toPort: 'in' },
    ],
  }];
  const issues = checkGraphs(project);
  assert.equal(issues.length, 1);
  assert.match(issues[0], /branch.*cond/);
  assert.throws(() => projectWithCompiledGraphs(project));
});
