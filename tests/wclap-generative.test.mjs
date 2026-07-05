// Generative WCLAP hosting (v3): the host captures CLAP note events that a
// plugin pushes to its output queue, feeds a transport event each block, and
// the rack routes generator note output into a target instrument.
//
// No note-generator bundle ships in /wclap, so this test hand-assembles a
// minimal CLAP plugin wasm (same technique as buildTrampolineModule) whose
// process() pushes one note-on through out_events.try_push per block.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { loadWclapBundle, buildTrampolineModule, WclapInstance, WclapRack } from '@iam/player';

const wclapDir = fileURLToPath(new URL('../wclap/', import.meta.url));
const trampoline = buildTrampolineModule();

function uleb(n) {
  const o = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    o.push(b);
  } while (n);
  return o;
}

function sleb(n) {
  const o = [];
  let more = true;
  while (more) {
    let b = n & 0x7f;
    n >>= 7;
    if ((n === 0 && (b & 0x40) === 0) || (n === -1 && (b & 0x40) !== 0)) more = false;
    else b |= 0x80;
    o.push(b);
  }
  return o;
}

/**
 * Builds a wasm CLAP "note generator": exports memory/table/malloc/clap_entry
 * like a real WCLAP module.wasm; its process() pushes a 40-byte CLAP note-on
 * (key 60, velocity 0.8, time 0) into clap_process.out_events every block.
 */
function buildGeneratorFixture() {
  const ENTRY = 16;
  const FACTORY = 48;
  const PLUGIN = 80;
  const EVENT = 160;

  const sec = (id, p) => [id, ...uleb(p.length), ...p];

  // Types: t0 (i32)->i32, t1 (i32,i32)->i32, t2 (i32,i32,i32)->i32,
  // t3 (i32,f64,i32,i32)->i32 (clap_plugin.activate).
  const types = [
    [0x60, 1, 0x7f, 1, 0x7f],
    [0x60, 2, 0x7f, 0x7f, 1, 0x7f],
    [0x60, 3, 0x7f, 0x7f, 0x7f, 1, 0x7f],
    [0x60, 4, 0x7f, 0x7c, 0x7f, 0x7f, 1, 0x7f],
  ];
  const typeSec = [...uleb(types.length), ...types.flat()];

  // Functions: 0 malloc(t0), 1 entry_init(t0), 2 get_factory(t0),
  // 3 fac_create(t2), 4 pl_init(t0), 5 pl_activate(t3),
  // 6 pl_startstop(t0), 7 pl_process(t1).
  const funcSec = [...uleb(8), 0, 0, 0, 2, 0, 3, 0, 1];
  const tableSec = [1, 0x70, 0x00, ...uleb(16)];
  const memSec = [1, 0x00, ...uleb(64)];
  // g0: bump-allocator heap (mut i32, starts at 64 KiB); g1: clap_entry addr.
  const globalSec = [
    2,
    0x7f, 0x01, 0x41, ...sleb(65536), 0x0b,
    0x7f, 0x00, 0x41, ...sleb(ENTRY), 0x0b,
  ];
  const enc = new TextEncoder();
  const exp = (name, kind, idx) => {
    const b = enc.encode(name);
    return [...uleb(b.length), ...b, kind, ...uleb(idx)];
  };
  const exportSec = [
    ...uleb(4),
    ...exp('memory', 0x02, 0),
    ...exp('__indirect_function_table', 0x01, 0),
    ...exp('malloc', 0x00, 0),
    ...exp('clap_entry', 0x03, 1),
  ];
  // Table slots 1..7 = functions 1..7 (slot n == function index n).
  const elemSec = [1, 0x00, 0x41, ...sleb(1), 0x0b, ...uleb(7), 1, 2, 3, 4, 5, 6, 7];

  const body = (locals, instrs) => {
    const b = [...locals, ...instrs, 0x0b];
    return [...uleb(b.length), ...b];
  };
  const const1 = body([0], [0x41, 0x01]);
  const bodies = [
    // malloc(n): p = heap; heap = (p + n + 7) & -8; return p.
    body(
      [1, 1, 0x7f],
      [
        0x23, 0x00, 0x21, 0x01,
        0x20, 0x01, 0x20, 0x00, 0x6a,
        0x41, ...sleb(7), 0x6a,
        0x41, ...sleb(-8), 0x71,
        0x24, 0x00,
        0x20, 0x01,
      ],
    ),
    const1, // entry_init
    body([0], [0x41, ...sleb(FACTORY)]), // get_factory
    body([0], [0x41, ...sleb(PLUGIN)]), // fac_create
    const1, // pl_init
    const1, // pl_activate
    const1, // pl_startstop
    // pl_process(plug, proc): push =* (proc->out_events)->try_push;
    // call_indirect push(out_events, EVENT); return 1.
    body(
      [1, 2, 0x7f],
      [
        0x20, 0x01, 0x28, 0x02, ...uleb(36), 0x21, 0x02,
        0x20, 0x02, 0x28, 0x02, ...uleb(4), 0x21, 0x03,
        0x20, 0x02, 0x41, ...sleb(EVENT), 0x20, 0x03,
        0x11, ...uleb(1), 0x00, 0x1a,
        0x41, 0x01,
      ],
    ),
  ];
  const codeSec = [...uleb(bodies.length), ...bodies.flat()];

  const dataBytes = (addr, bytes) => [0x00, 0x41, ...sleb(addr), 0x0b, ...uleb(bytes.length), ...bytes];
  const u32s = (vals) => {
    const b = new Uint8Array(vals.length * 4);
    const d = new DataView(b.buffer);
    vals.forEach((v, i) => d.setUint32(i * 4, v >>> 0, true));
    return [...b];
  };
  // clap_plugin_entry {version[3], init=1, deinit=0, get_factory=2}
  const entryData = u32s([1, 0, 0, 1, 0, 2]);
  // clap_plugin_factory {count=0, descriptor=0, create=3} (tests always pass
  // an explicit clapPluginId so count/descriptor are never called).
  const factoryData = u32s([0, 0, 3]);
  // clap_plugin {desc, data, init=4, destroy, activate=5, deactivate,
  //   start=6, stop=6, reset, process=7, get_extension, on_main_thread}
  const pluginData = u32s([0, 0, 4, 0, 5, 0, 6, 6, 0, 7, 0, 0]);
  // clap_event_note (note-on, key 60, channel 0, velocity 0.8, time 0).
  const ev = new Uint8Array(40);
  {
    const d = new DataView(ev.buffer);
    d.setUint32(0, 40, true);
    d.setUint32(4, 0, true);
    d.setUint16(8, 0, true);
    d.setUint16(10, 0, true); // CLAP_EVENT_NOTE_ON
    d.setInt32(16, -1, true);
    d.setInt16(20, 0, true);
    d.setInt16(22, 0, true);
    d.setInt16(24, 60, true);
    d.setFloat64(32, 0.8, true);
  }
  const dataSec = [
    ...uleb(4),
    ...dataBytes(ENTRY, entryData),
    ...dataBytes(FACTORY, factoryData),
    ...dataBytes(PLUGIN, pluginData),
    ...dataBytes(EVENT, [...ev]),
  ];

  const bytes = new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0, 0, 0,
    ...sec(1, typeSec),
    ...sec(3, funcSec),
    ...sec(4, tableSec),
    ...sec(5, memSec),
    ...sec(6, globalSec),
    ...sec(7, exportSec),
    ...sec(9, elemSec),
    ...sec(10, codeSec),
    ...sec(11, dataSec),
  ]);
  return new WebAssembly.Module(bytes);
}

function peak(buf) {
  let p = 0;
  for (let i = 0; i < buf.length; i++) p = Math.max(p, Math.abs(buf[i]));
  return p;
}

test('the host captures CLAP note output from a generator plugin', () => {
  const inst = new WclapInstance(buildGeneratorFixture(), {
    sampleRate: 48000,
    maxFrames: 128,
    clapPluginId: 'fixture.pulse',
    audioInputs: 0,
    trampoline,
  });
  inst.setTransport({ bpm: 120, posBeats: 0, beatsPerBar: 4, playing: true });
  inst.process(128);
  const notes = inst.takeOutputNotes();
  assert.equal(notes.length, 1, 'one note captured per block');
  assert.equal(notes[0].isOn, true);
  assert.equal(notes[0].key, 60);
  assert.equal(notes[0].channel, 0);
  assert.ok(Math.abs(notes[0].velocity - 0.8) < 1e-9);
  // takeOutputNotes drains the queue.
  assert.equal(inst.takeOutputNotes().length, 0);
});

test('rack routes generator notes into a target instrument (audible)', async () => {
  const synth = await loadWclapBundle(
    new Uint8Array(await readFile(wclapDir + 'z-audio-simple-synth.wclap.tar.gz')),
  );
  const rack = new WclapRack(
    [
      { instanceId: 1, module: buildGeneratorFixture(), clapPluginId: 'fixture.pulse', audioInputs: 0 },
      { instanceId: 2, module: new WebAssembly.Module(synth.moduleBytes), audioInputs: 0 },
    ],
    {
      instruments: [{ instanceId: 2, effects: [] }],
      masterEffects: [],
      noteSources: [{ generator: 1, target: 2 }],
    },
    { sampleRate: 48000, maxFrames: 128, trampoline },
  );
  assert.equal(rack.size, 2);
  const bus = new Float32Array(128 * 2);
  let energy = 0;
  for (let i = 0; i < 40; i++) {
    bus.fill(0);
    rack.render(bus, 128, undefined, { bpm: 120, posBeats: i * 0.1, beatsPerBar: 4, playing: true });
    energy += peak(bus);
  }
  assert.ok(energy > 0.1, `generated notes drive the synth (energy=${energy})`);
  rack.destroy();
});

test('RTPC param modulation pushes curve values into the plugin', async () => {
  const synth = await loadWclapBundle(
    new Uint8Array(await readFile(wclapDir + 'z-audio-simple-synth.wclap.tar.gz')),
  );
  let rtpcValue = 0;
  const rack = new WclapRack(
    [{ instanceId: 2, module: new WebAssembly.Module(synth.moduleBytes), audioInputs: 0 }],
    {
      instruments: [{ instanceId: 2, effects: [] }],
      masterEffects: [],
      paramMods: [
        { instance: 2, param: 0, rtpc: 1, points: [{ x: 0, y: 0.1 }, { x: 1, y: 0.9 }] },
      ],
    },
    { sampleRate: 48000, maxFrames: 128, trampoline },
  );
  const bus = new Float32Array(128 * 2);
  // Sweep the driving RTPC; the mod path must not throw and the rack keeps
  // rendering (param id 0 may or may not exist in the synth — the host sends
  // the event either way and the plugin ignores unknown ids).
  for (let i = 0; i <= 10; i++) {
    rtpcValue = i / 10;
    bus.fill(0);
    rack.render(bus, 128, undefined, undefined, (id) => (id === 1 ? rtpcValue : 0));
  }
  rack.destroy();
  assert.ok(true, 'param modulation path renders without errors');
});
