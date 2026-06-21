// End-to-end tests for the v2 additions: WCLAP plugin bank, instrument (MIDI)
// tracks with engine-side sequencing, and bridge (横遷移) transitions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  encodePack,
  decodePack,
  buildIamWasm,
  EventType,
  MidiStatus,
} from '@iam/pack';
import { IamCore } from '@iam/player';

const engineWasm = new Uint8Array(
  await readFile(fileURLToPath(new URL('../runtime/engine.wasm', import.meta.url))),
);

const SR = 48000; // BPM 120 -> 24000 samples/beat.

function emptyAudioTrack(id, name) {
  return { id, name, volume: 1, pan: 0, muted: false, items: [] };
}

function instrumentTrack(id, name, instance, notes) {
  return {
    id,
    name,
    volume: 1,
    pan: 0,
    muted: false,
    kind: 'instrument',
    instrument: instance,
    items: [],
    notes,
    effects: [],
  };
}

function section(id, name, lengthBeats, tracks, loop = true) {
  return {
    id,
    name,
    bpm: 0,
    timeSignature: [0, 0],
    loopEnabled: loop,
    lengthBeats,
    loopStartBeats: 0,
    tracks,
    anchors: [],
  };
}

function baseProject(over = {}) {
  return {
    formatVersion: 1,
    name: 'V2 Test',
    bankSampleRate: SR,
    bpm: 120,
    timeSignature: [4, 4],
    startSectionId: 0,
    rtpcs: [],
    sections: [],
    cues: [],
    bindings: [],
    assets: [],
    plugins: [],
    pluginInstances: [],
    masterEffects: [],
    ...over,
  };
}

// A plugin referenced by URL only (no embedded bytes needed for engine tests).
const urlPlugin = {
  id: 0,
  name: 'Synth',
  clapPluginId: 'dev.test.synth',
  url: 'https://example.test/synth.wclap.tar.gz',
  embedded: false,
};

test('roundtrip preserves plugins, instances, instrument notes and bridge', () => {
  const project = baseProject({
    plugins: [
      { id: 0, name: 'Synth', clapPluginId: 'dev.test.synth', embedded: true },
      { ...urlPlugin, id: 1, name: 'Reverb' },
    ],
    pluginInstances: [
      { id: 0, pluginBankId: 0, clapPluginId: 'dev.test.synth', params: [{ id: 7, value: 0.42 }] },
      { id: 1, pluginBankId: 1, params: [] },
    ],
    masterEffects: [1],
    sections: [
      section(0, 'A', 4, [
        instrumentTrack(0, 'Lead', 0, [
          { startBeat: 0, lengthBeats: 1, key: 60, velocity: 0.8, channel: 0 },
          { startBeat: 2, lengthBeats: 1, key: 64, velocity: 0.6, channel: 0 },
        ]),
      ]),
    ],
    cues: [
      {
        id: 0,
        name: 'bridged',
        rules: [
          {
            condition: '',
            stopIfMatched: false,
            actions: [
              {
                type: 'goto',
                section: 0,
                anchor: null,
                timing: 'nextBar',
                transition: 'crossfade',
                fadeMs: 100,
                bridge: 0,
              },
            ],
          },
        ],
      },
    ],
  });
  // The embedded plugin (id 0) needs a binary supplied for encoding.
  const embeddedBin = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  const pack = encodePack(project, [], {}, [{ id: 0, name: 'Synth', data: embeddedBin }]);
  const dec = decodePack(pack);

  assert.equal(dec.plugins.length, 2);
  assert.equal(dec.plugins[0].embedded, true);
  assert.deepEqual([...(dec.plugins[0].data ?? [])], [...embeddedBin]);
  assert.equal(dec.plugins[1].embedded, false);
  assert.equal(dec.plugins[1].url, 'https://example.test/synth.wclap.tar.gz');

  assert.equal(dec.pluginInstances.length, 2);
  assert.equal(dec.pluginInstances[0].params[0].id, 7);
  assert.ok(Math.abs(dec.pluginInstances[0].params[0].value - 0.42) < 1e-6);
  assert.deepEqual(dec.masterEffects, [1]);

  // Instrument track + notes + bridge survive via the META project JSON.
  const lead = dec.project.sections[0].tracks[0];
  assert.equal(lead.kind, 'instrument');
  assert.equal(lead.instrument, 0);
  assert.equal(lead.notes.length, 2);
  assert.equal(lead.notes[1].key, 64);
  assert.equal(dec.project.cues[0].rules[0].actions[0].bridge, 0);
});

test('validation catches instrument/bridge/effect/note problems', () => {
  // Instrument track without a valid instance.
  const p1 = baseProject({
    plugins: [urlPlugin],
    pluginInstances: [{ id: 0, pluginBankId: 0, params: [] }],
    sections: [section(0, 'A', 4, [instrumentTrack(0, 'Lead', 99, [])])],
  });
  assert.throws(() => encodePack(p1, []), /instrument track must reference/);

  // goto referencing a missing bridge section.
  const p2 = baseProject({
    sections: [section(0, 'A', 4, [emptyAudioTrack(0, 'x')])],
    cues: [
      {
        id: 0,
        name: 'c',
        rules: [
          {
            condition: '',
            stopIfMatched: false,
            actions: [
              { type: 'goto', section: 0, anchor: null, timing: 'immediate', transition: 'cut', fadeMs: 0, bridge: 77 },
            ],
          },
        ],
      },
    ],
  });
  assert.throws(() => encodePack(p2, []), /section 77 does not exist/);

  // Dangling effect instance.
  const p3 = baseProject({
    sections: [section(0, 'A', 4, [{ ...emptyAudioTrack(0, 'x'), effects: [55] }])],
  });
  assert.throws(() => encodePack(p3, []), /effect instance 55 does not exist/);

  // Out-of-range note velocity.
  const p4 = baseProject({
    plugins: [urlPlugin],
    pluginInstances: [{ id: 0, pluginBankId: 0, params: [] }],
    sections: [
      section(0, 'A', 4, [
        instrumentTrack(0, 'Lead', 0, [{ startBeat: 0, lengthBeats: 1, key: 60, velocity: 2, channel: 0 }]),
      ]),
    ],
  });
  assert.throws(() => encodePack(p4, []), /velocity 2 out of range/);
});

async function coreFor(project, plugins = []) {
  const pack = encodePack(project, [], {}, plugins);
  const core = await IamCore.create(buildIamWasm(engineWasm, pack));
  core.init(SR, 2);
  return core;
}

// Render `seconds` and collect MIDI events tagged with their absolute frame.
function renderMidi(core, seconds, block = 256) {
  const frames = Math.round(seconds * SR);
  const out = [];
  for (let done = 0; done < frames; done += block) {
    const n = Math.min(block, frames - done);
    core.render(n);
    for (const m of core.pollMidiEvents()) {
      out.push({ ...m, absFrame: done + m.frameOffset });
    }
  }
  return out;
}

test('engine sequences instrument notes at sample-accurate positions', async () => {
  const project = baseProject({
    plugins: [urlPlugin],
    pluginInstances: [{ id: 5, pluginBankId: 0, params: [] }],
    sections: [
      section(
        0,
        'A',
        4,
        [
          instrumentTrack(0, 'Lead', 5, [
            { startBeat: 0, lengthBeats: 1, key: 60, velocity: 0.8, channel: 0 },
            { startBeat: 2, lengthBeats: 1, key: 64, velocity: 0.6, channel: 0 },
          ]),
        ],
        false,
      ),
    ],
  });
  const core = await coreFor(project);
  core.play();
  const midi = renderMidi(core, 1.6); // section is 2s; capture both notes + offs

  const ons = midi.filter((m) => m.status === MidiStatus.NoteOn);
  const offs = midi.filter((m) => m.status === MidiStatus.NoteOff);
  assert.equal(ons.length, 2, 'two note-ons');
  assert.equal(offs.length, 2, 'two note-offs');

  // All events route to the instrument's plugin instance (id 5).
  assert.ok(midi.every((m) => m.instanceId === 5));

  const near = (a, b) => Math.abs(a - b) <= 256;
  // beat0 on @0, beat1 off @24000, beat2 on @48000, beat3 off @72000.
  assert.equal(ons[0].key, 60);
  assert.ok(near(ons[0].absFrame, 0), `note-on@0 (got ${ons[0].absFrame})`);
  assert.ok(near(offs[0].absFrame, 24000), `note-off@24000 (got ${offs[0].absFrame})`);
  assert.equal(ons[1].key, 64);
  assert.ok(near(ons[1].absFrame, 48000), `note-on@48000 (got ${ons[1].absFrame})`);
  assert.ok(Math.abs(ons[1].velocity - 0.6) < 1e-6);
});

test('bridge transition routes source -> bridge -> destination', async () => {
  const project = baseProject({
    startSectionId: 0,
    sections: [
      section(0, 'A', 4, [emptyAudioTrack(0, 'x')], true), // loops
      section(1, 'Bridge', 1, [emptyAudioTrack(0, 'x')], false), // one-shot, 0.5s
      section(2, 'Dest', 4, [emptyAudioTrack(0, 'x')], true),
    ],
    cues: [
      {
        id: 0,
        name: 'to_dest',
        rules: [
          {
            condition: '',
            stopIfMatched: false,
            actions: [
              { type: 'goto', section: 2, anchor: null, timing: 'immediate', transition: 'cut', fadeMs: 0, bridge: 1 },
            ],
          },
        ],
      },
    ],
  });
  const core = await coreFor(project);
  core.play();
  assert.equal(core.currentSection, 'A');
  core.render(64); // get going
  core.pollEvents();

  core.triggerCue('to_dest');
  // First render fires the immediate goto into the Bridge.
  core.render(64);
  assert.equal(core.currentSection, 'Bridge');

  // Bridge is 1 beat = 0.5s; render past its end to reach Dest.
  const evs = [];
  const frames = Math.round(0.7 * SR);
  for (let done = 0; done < frames; done += 256) {
    core.render(Math.min(256, frames - done));
    evs.push(...core.pollEvents());
  }
  assert.equal(core.currentSection, 'Dest');
  const changes = evs
    .filter((e) => e.type === EventType.SectionChanged)
    .map((e) => e.b);
  assert.ok(changes.includes(2), 'reached Dest via SectionChanged');
});
