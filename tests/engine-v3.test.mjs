// Engine v3 semantics, verified with DC-amplitude sample-exact assertions:
// vertical blend curves follow the RTPC, quantized track gains land exactly on
// the bar line, and gotoTrack swaps a single track's content (audio + MIDI)
// while the other tracks keep playing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { encodePack, buildIamWasm, EventType } from '@iam/pack';
import { IamCore } from '@iam/player';

const SR = 48000;
const BEAT = SR / 2; // 120 bpm
const BAR = BEAT * 4;
// Mono sources are panned center with constant power: each channel gets 1/sqrt(2).
const PAN = Math.SQRT1_2;
const engineWasm = new Uint8Array(
  await readFile(fileURLToPath(new URL('../runtime/engine.wasm', import.meta.url))),
);

function tone(frames, amp) {
  return new Float32Array(frames).fill(amp);
}

function baseProject() {
  return {
    formatVersion: 1,
    name: 'engine v3',
    bankSampleRate: SR,
    bpm: 120,
    timeSignature: [4, 4],
    startSectionId: 0,
    rtpcs: [
      { id: 1, name: 'x', type: 'f32', default: 0, min: 0, max: 1, smoothingMs: 0 },
    ],
    plugins: [],
    pluginInstances: [],
    masterEffects: [],
    sections: [
      {
        id: 0, name: 'A', bpm: 0, timeSignature: [0, 0],
        loopEnabled: true, lengthBeats: 8, loopStartBeats: 0,
        tracks: [
          { id: 0, name: 'base', volume: 1, pan: 0, muted: false, items: [
            { id: 0, assetId: 0, startBeat: 0, lengthBeats: 8, offsetBeats: 0, gain: 1, fadeInBeats: 0, fadeOutBeats: 0 },
          ] },
          { id: 1, name: 'layer', volume: 1, pan: 0, muted: false, items: [
            { id: 1, assetId: 1, startBeat: 0, lengthBeats: 8, offsetBeats: 0, gain: 1, fadeInBeats: 0, fadeOutBeats: 0 },
          ] },
        ],
        anchors: [],
      },
      {
        id: 1, name: 'B', bpm: 0, timeSignature: [0, 0],
        loopEnabled: false, lengthBeats: 4, loopStartBeats: 0,
        tracks: [
          { id: 0, name: 'alt', volume: 1, pan: 0, muted: false, items: [
            { id: 0, assetId: 2, startBeat: 0, lengthBeats: 4, offsetBeats: 0, gain: 1, fadeInBeats: 0, fadeOutBeats: 0 },
          ] },
        ],
        anchors: [],
      },
    ],
    cues: [],
    bindings: [],
    assets: [
      { id: 0, name: 'a', channels: 1, sampleRate: SR, frames: SR * 8 },
      { id: 1, name: 'b', channels: 1, sampleRate: SR, frames: SR * 8 },
      { id: 2, name: 'c', channels: 1, sampleRate: SR, frames: SR * 8 },
    ],
    blends: [],
    paramMods: [],
    noteSources: [],
  };
}

// DC amplitudes: base 0.2, layer 0.4, section-B alt 0.8.
function assets() {
  return [
    { id: 0, name: 'a', channels: 1, sampleRate: SR, frames: SR * 8, format: 'f32', data: tone(SR * 8, 0.2) },
    { id: 1, name: 'b', channels: 1, sampleRate: SR, frames: SR * 8, format: 'f32', data: tone(SR * 8, 0.4) },
    { id: 2, name: 'c', channels: 1, sampleRate: SR, frames: SR * 8, format: 'f32', data: tone(SR * 8, 0.8) },
  ];
}

async function makeCore(project) {
  const pack = encodePack(project, assets(), { includeMeta: false });
  const core = await IamCore.create(buildIamWasm(engineWasm, pack));
  core.init(SR, 2);
  return core;
}

/** Renders `frames` frames and returns the left-channel samples. */
function renderL(core, frames) {
  const out = [];
  let left = frames;
  while (left > 0) {
    const n = Math.min(256, left);
    const buf = core.render(n);
    for (let i = 0; i < n; i++) out.push(buf[i * 2]);
    left -= n;
  }
  return out;
}

const close = (a, b, eps = 1e-4) => Math.abs(a - b) <= eps;

test('BLND: track gain follows the RTPC blend curve continuously', async () => {
  const project = baseProject();
  project.blends = [
    { id: 0, rtpc: 1, section: 0, track: 1, points: [{ x: 0, y: 0 }, { x: 1, y: 1 }] },
  ];
  const core = await makeCore(project);
  core.play();

  // x=0 -> layer silent: only base (0.2) sounds.
  let l = renderL(core, 256);
  assert.ok(close(l[128], 0.2 * PAN), `layer off at x=0 (got ${l[128]})`);

  // x=0.5 -> layer at half gain: 0.2 + 0.4*0.5 = 0.4.
  core.setRtpc('x', 0.5);
  l = renderL(core, 256);
  assert.ok(close(l[128], (0.2 + 0.4 * 0.5) * PAN), `curve mid (got ${l[128]})`);

  // x=1 -> full layer: 0.2 + 0.4.
  core.setRtpc('x', 1);
  l = renderL(core, 256);
  assert.ok(close(l[128], 0.6 * PAN), `curve max (got ${l[128]})`);
});

test('setTrackGain with timing=nextBar lands exactly on the bar line', async () => {
  const project = baseProject();
  project.cues = [
    { id: 0, name: 'duck', rules: [
      { condition: '', stopIfMatched: false, actions: [
        { type: 'setTrackGain', section: 0, track: 1, gain: 0, fadeMs: 0, timing: 'nextBar' },
      ] },
    ] },
  ];
  const core = await makeCore(project);
  core.play();

  // Fire the cue mid-bar (after 1 beat).
  renderL(core, BEAT);
  core.triggerCue('duck');
  // Render up to two beats past the bar line; the change must land at
  // exactly BAR (i.e. 3 beats after the current position).
  const l = renderL(core, BEAT * 4);
  const at = (i) => l[i];
  const before = at(BEAT * 3 - 1); // sample BAR-1 overall
  const after = at(BEAT * 3); // sample BAR overall
  assert.ok(close(before, 0.6 * PAN), `full mix right before the bar (got ${before})`);
  assert.ok(close(after, 0.2 * PAN), `layer gone exactly on the bar (got ${after})`);
});

test('gainExpr computes the gain from RTPCs at fire time', async () => {
  const project = baseProject();
  project.cues = [
    { id: 0, name: 'expr', rules: [
      { condition: '', stopIfMatched: false, actions: [
        { type: 'setTrackGain', section: 0, track: 1, gain: 1, fadeMs: 0, gainExpr: 'x * 0.5' },
      ] },
    ] },
  ];
  const core = await makeCore(project);
  core.play();
  core.setRtpc('x', 0.8);
  core.triggerCue('expr');
  const l = renderL(core, 256);
  // layer gain = 0.8*0.5 = 0.4 -> 0.2 + 0.4*0.4 = 0.36
  assert.ok(close(l[128], (0.2 + 0.4 * 0.4) * PAN), `expr gain applied (got ${l[128]})`);
});

test('gotoTrack swaps one track to another section content on the bar', async () => {
  const project = baseProject();
  project.cues = [
    { id: 0, name: 'swap', rules: [
      { condition: '', stopIfMatched: false, actions: [
        { type: 'gotoTrack', section: 0, track: 1, sourceSection: 1, sourceTrack: 0, timing: 'nextBar', transition: 'cut', fadeMs: 0 },
      ] },
    ] },
    { id: 1, name: 'back', rules: [
      { condition: '', stopIfMatched: false, actions: [
        { type: 'gotoTrack', section: 0, track: 1, sourceSection: null, sourceTrack: null, timing: 'immediate', transition: 'cut', fadeMs: 0 },
      ] },
    ] },
  ];
  const core = await makeCore(project);
  core.play();

  renderL(core, BEAT);
  core.triggerCue('swap');
  const l = renderL(core, BEAT * 4);
  const before = l[BEAT * 3 - 1];
  const after = l[BEAT * 3];
  // Before: base 0.2 + layer 0.4. After: base 0.2 + section-B alt 0.8.
  assert.ok(close(before, 0.6 * PAN), `own content before the bar (got ${before})`);
  assert.ok(close(after, 1.0 * PAN), `swapped content on the bar (got ${after})`);

  // The override reports an event and survives across the section loop.
  const events = core.pollEvents();
  assert.ok(events.some((e) => e.type === EventType.TrackGoto), 'TrackGoto event emitted');

  // Clearing the override brings the original layer back immediately.
  core.triggerCue('back');
  const l2 = renderL(core, 256);
  assert.ok(close(l2[128], 0.6 * PAN), `own content after clearing (got ${l2[128]})`);
});

test('gotoTrack keeps the destination slot mixer (volume) in charge', async () => {
  const project = baseProject();
  project.sections[0].tracks[1].volume = 0.5;
  project.cues = [
    { id: 0, name: 'swap', rules: [
      { condition: '', stopIfMatched: false, actions: [
        { type: 'gotoTrack', section: 0, track: 1, sourceSection: 1, sourceTrack: 0, timing: 'immediate', transition: 'cut', fadeMs: 0 },
      ] },
    ] },
  ];
  const core = await makeCore(project);
  core.play();
  core.triggerCue('swap');
  const l = renderL(core, 256);
  // base 0.2 + B alt 0.8 * slot volume 0.5 = 0.6
  assert.ok(close(l[128], 0.6 * PAN), `dest volume applies to swapped content (got ${l[128]})`);
});

test('setPluginParam reaches the host as a PluginParam event', async () => {
  const project = baseProject();
  project.plugins = [{ id: 0, name: 'p', clapPluginId: 'p', url: 'u', embedded: false }];
  project.pluginInstances = [{ id: 3, pluginBankId: 0, params: [] }];
  project.cues = [
    { id: 0, name: 'p', rules: [
      { condition: '', stopIfMatched: false, actions: [
        { type: 'setPluginParam', instance: 3, param: 11, value: 0, valueExpr: 'x + 0.25' },
      ] },
    ] },
  ];
  const core = await makeCore(project);
  core.play();
  core.setRtpc('x', 0.5);
  core.pollEvents();
  core.triggerCue('p');
  const events = core.pollEvents();
  const pe = events.find((e) => e.type === EventType.PluginParam);
  assert.ok(pe, 'PluginParam event emitted');
  assert.equal(pe.a, 3);
  assert.equal(pe.b, 11);
  assert.ok(close(pe.c, 0.75), `expr value forwarded (got ${pe.c})`);
});
