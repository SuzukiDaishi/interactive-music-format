// End-to-end test: encode an IAMP pack, embed it into the engine wasm,
// instantiate the result in Node and verify interactive behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  encodePack,
  decodePack,
  buildIamWasm,
  extractPack,
  isIamWasm,
  compileExpression,
  EventType,
  NONE_ID,
} from '@iam/pack';
import { IamCore } from '@iam/player';

const engineWasm = new Uint8Array(
  await readFile(fileURLToPath(new URL('../runtime/engine.wasm', import.meta.url))),
);

const SR = 48000;

function sineAsset(id, name, freq, seconds, gain = 0.5) {
  const frames = Math.round(SR * seconds);
  const data = new Int16Array(frames);
  for (let i = 0; i < frames; i++) {
    data[i] = Math.round(Math.sin((2 * Math.PI * freq * i) / SR) * gain * 32767);
  }
  return { id, name, channels: 1, sampleRate: SR, frames, format: 'pcm16', data };
}

// BPM 120 -> 24000 samples/beat, 4/4 -> 96000 samples/bar.
function makeProject() {
  return {
    formatVersion: 1,
    name: 'Test Project',
    bankSampleRate: SR,
    bpm: 120,
    timeSignature: [4, 4],
    startSectionId: 0,
    rtpcs: [
      { id: 0, name: 'intensity', type: 'f32', default: 0, min: 0, max: 1, smoothingMs: 0 },
    ],
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
            name: 'Tone',
            volume: 1,
            pan: 0,
            muted: false,
            items: [
              {
                id: 0,
                assetId: 0,
                startBeat: 0,
                lengthBeats: 4,
                offsetBeats: 0,
                gain: 1,
                fadeInBeats: 0,
                fadeOutBeats: 0,
              },
            ],
          },
        ],
        anchors: [
          { id: 0, name: 'Entry', beat: 0 },
          { id: 1, name: 'Mid', beat: 2 },
        ],
      },
      {
        id: 1,
        name: 'B',
        bpm: 0,
        timeSignature: [0, 0],
        loopEnabled: true,
        lengthBeats: 4,
        loopStartBeats: 0,
        tracks: [
          {
            id: 0,
            name: 'Tone',
            volume: 1,
            pan: 0,
            muted: false,
            items: [
              {
                id: 0,
                assetId: 1,
                startBeat: 0,
                lengthBeats: 4,
                offsetBeats: 0,
                gain: 1,
                fadeInBeats: 0,
                fadeOutBeats: 0,
              },
            ],
          },
        ],
        anchors: [{ id: 0, name: 'Entry', beat: 0 }],
      },
      {
        id: 2,
        name: 'Outro',
        bpm: 0,
        timeSignature: [0, 0],
        loopEnabled: false,
        lengthBeats: 2,
        loopStartBeats: 0,
        tracks: [
          {
            id: 0,
            name: 'Tone',
            volume: 1,
            pan: 0,
            muted: false,
            items: [
              {
                id: 0,
                assetId: 0,
                startBeat: 0,
                lengthBeats: 2,
                offsetBeats: 0,
                gain: 1,
                fadeInBeats: 0,
                fadeOutBeats: 1,
              },
            ],
          },
        ],
        anchors: [],
      },
    ],
    cues: [
      {
        id: 0,
        name: 'on_intensity',
        rules: [
          {
            condition: "intensity >= 0.7 && section != 'B'",
            stopIfMatched: true,
            actions: [
              {
                type: 'goto',
                section: 1,
                anchor: null,
                timing: 'nextBar',
                transition: 'crossfade',
                fadeMs: 50,
              },
            ],
          },
          {
            condition: "intensity < 0.7 && section != 'A'",
            stopIfMatched: true,
            actions: [
              {
                type: 'goto',
                section: 0,
                anchor: null,
                timing: 'nextBar',
                transition: 'crossfade',
                fadeMs: 50,
              },
            ],
          },
        ],
      },
      {
        id: 1,
        name: 'to_end',
        rules: [
          {
            condition: '',
            stopIfMatched: false,
            actions: [
              {
                type: 'goto',
                section: 2,
                anchor: null,
                timing: 'sectionEnd',
                transition: 'cut',
                fadeMs: 0,
              },
            ],
          },
        ],
      },
      {
        id: 2,
        name: 'mid_anchor_emit',
        rules: [
          { condition: '', stopIfMatched: false, actions: [{ type: 'emit', code: 42 }] },
        ],
      },
    ],
    bindings: [
      { trigger: { type: 'rtpcChanged', rtpc: 0 }, cue: 0 },
      { trigger: { type: 'anchorReached', section: 0, anchor: 1 }, cue: 2 },
    ],
    assets: [
      { id: 0, name: 'tone_a', channels: 1, sampleRate: SR, frames: SR * 2, },
      { id: 1, name: 'tone_b', channels: 1, sampleRate: SR, frames: SR * 2 },
    ],
  };
}

function makeAssets() {
  return [sineAsset(0, 'tone_a', 440, 2), sineAsset(1, 'tone_b', 880, 2)];
}

async function makeCore() {
  const pack = encodePack(makeProject(), makeAssets());
  const iamWasm = buildIamWasm(engineWasm, pack);
  const core = await IamCore.create(iamWasm);
  core.init(SR, 2);
  return core;
}

function rms(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

function renderSeconds(core, seconds, block = 480) {
  const frames = Math.round(seconds * SR);
  let peak = 0;
  let energy = 0;
  for (let done = 0; done < frames; done += block) {
    const n = Math.min(block, frames - done);
    const out = core.render(n);
    for (let i = 0; i < out.length; i++) {
      const a = Math.abs(out[i]);
      if (a > peak) peak = a;
      energy += out[i] * out[i];
    }
  }
  return { peak, rms: Math.sqrt(energy / (frames * 2)) };
}

test('pack roundtrip preserves structure and audio', () => {
  const pack = encodePack(makeProject(), makeAssets());
  const dec = decodePack(pack);
  assert.equal(dec.name, 'Test Project');
  assert.equal(dec.bankSampleRate, SR);
  assert.equal(dec.bpm, 120);
  assert.deepEqual(dec.timeSignature, [4, 4]);
  assert.equal(dec.startSectionId, 0);
  assert.deepEqual(
    dec.sections.map((s) => s.name),
    ['A', 'B', 'Outro'],
  );
  assert.equal(dec.sections[0].anchors.length, 2);
  assert.deepEqual(
    dec.rtpcs.map((r) => r.name),
    ['intensity'],
  );
  assert.deepEqual(
    dec.cues.map((c) => c.name),
    ['on_intensity', 'to_end', 'mid_anchor_emit'],
  );
  assert.equal(dec.assets.length, 2);
  assert.equal(dec.assets[0].frames, SR * 2);
  assert.ok(dec.project, 'META project JSON present');
  assert.equal(dec.project.cues[0].rules[0].condition, "intensity >= 0.7 && section != 'B'");
});

test('.iam.wasm container embed/extract', () => {
  const pack = encodePack(makeProject(), makeAssets());
  const iamWasm = buildIamWasm(engineWasm, pack);
  assert.ok(isIamWasm(iamWasm));
  assert.ok(!isIamWasm(engineWasm));
  const extracted = extractPack(iamWasm);
  assert.deepEqual(extracted, pack);
  // Repacking a .iam.wasm replaces the pack instead of appending.
  const repacked = buildIamWasm(iamWasm, pack);
  assert.equal(repacked.length, iamWasm.length);
});

test('expression compiler rejects unknown identifiers', () => {
  assert.throws(() => compileExpression('bogus > 1', makeProject()));
  assert.throws(() => compileExpression("section == 'Nope'", makeProject()));
  assert.equal(compileExpression('   ', makeProject()).length, 0);
});

test('plays start section and loops', async () => {
  const core = await makeCore();
  assert.equal(core.currentSection, null);
  core.play();
  assert.equal(core.currentSection, 'A');
  const { rms: level } = renderSeconds(core, 1.0);
  assert.ok(level > 0.05, `audible output (rms=${level})`);
  // Section A is 4 beats = 2s at 120bpm; render past the end to loop.
  renderSeconds(core, 1.5);
  const events = core.pollEvents();
  assert.ok(events.some((e) => e.type === EventType.Looped), 'looped event');
  assert.equal(core.currentSection, 'A');
  assert.ok(events.some((e) => e.type === EventType.Emit && e.a === 42), 'anchor cue emitted');
});

test('RTPC-driven crossfade transition on next bar', async () => {
  const core = await makeCore();
  core.play();
  renderSeconds(core, 0.5); // mid bar 1
  core.pollEvents();
  core.setRtpc('intensity', 0.9);
  const events1 = core.pollEvents();
  assert.ok(
    events1.some((e) => e.type === EventType.GotoScheduled),
    'goto scheduled on rtpc change',
  );
  assert.equal(core.currentSection, 'A', 'still in A before the bar line');
  // Bar 1 ends at 2.0s; render until 2.1s.
  renderSeconds(core, 1.7);
  assert.equal(core.currentSection, 'B');
  const events2 = core.pollEvents();
  assert.ok(events2.some((e) => e.type === EventType.SectionChanged && e.b === 1));
  // Drop back below the threshold -> return to A.
  core.setRtpc('intensity', 0.2);
  renderSeconds(core, 2.2);
  assert.equal(core.currentSection, 'A');
});

test('manual cue: leave the loop into a finite outro, then end', async () => {
  const core = await makeCore();
  core.play();
  renderSeconds(core, 0.3);
  core.triggerCue('to_end');
  // Section A ends at 2.0s. Outro is 1s and does not loop.
  renderSeconds(core, 2.0);
  assert.equal(core.currentSection, 'Outro');
  renderSeconds(core, 1.5);
  const events = core.pollEvents();
  assert.ok(events.some((e) => e.type === EventType.Ended), 'ended event');
  assert.equal(core.playing, false);
  const { peak } = renderSeconds(core, 0.2);
  assert.equal(peak, 0, 'silent after end');
});

test('stop with fade reaches silence and emits ended', async () => {
  const core = await makeCore();
  core.play();
  renderSeconds(core, 0.5);
  core.pollEvents();
  core.stop(200);
  const a = renderSeconds(core, 0.1);
  assert.ok(a.peak > 0, 'still audible at fade start');
  renderSeconds(core, 0.4);
  const b = renderSeconds(core, 0.2);
  assert.equal(b.peak, 0, 'silent after fade');
  assert.ok(core.pollEvents().some((e) => e.type === EventType.Ended));
});

test('playback rate including reverse', async () => {
  const core = await makeCore();
  core.play();
  renderSeconds(core, 1.0);
  const beatsAt1x = core.positionBeats;
  assert.ok(Math.abs(beatsAt1x - 2) < 0.05, `~2 beats after 1s (got ${beatsAt1x})`);

  core.setRate(0.5);
  renderSeconds(core, 1.0);
  assert.ok(Math.abs(core.positionBeats - 3) < 0.05, 'half speed advances 1 beat/s');

  core.setRate(-1);
  const { rms: revLevel } = renderSeconds(core, 0.5);
  assert.ok(revLevel > 0.05, 'reverse playback is audible');
  assert.ok(Math.abs(core.positionBeats - 2) < 0.05, 'position moved backwards');

  // Reverse across position 0 wraps within the looping section.
  renderSeconds(core, 1.5);
  assert.ok(core.positionBeats > 2.5, `wrapped to loop end (got ${core.positionBeats})`);
  assert.equal(core.currentSection, 'A');
});

test('seek and pause/resume', async () => {
  const core = await makeCore();
  core.play();
  core.seekBeats(3);
  assert.ok(Math.abs(core.positionBeats - 3) < 1e-3);
  core.pause();
  const { peak } = renderSeconds(core, 0.2);
  assert.equal(peak, 0, 'paused output is silent');
  assert.ok(Math.abs(core.positionBeats - 3) < 1e-3, 'position frozen while paused');
  core.resume();
  const { rms: level } = renderSeconds(core, 0.2);
  assert.ok(level > 0.05);
});

test('play_section with anchor and NONE start section', async () => {
  const core = await makeCore();
  core.playSection('A', 'Mid');
  assert.ok(Math.abs(core.positionBeats - 2) < 1e-3, 'starts at anchor beat 2');
  const { rms: level } = renderSeconds(core, 0.2);
  assert.ok(level > 0.05);
});

test('rejects corrupt pack', async () => {
  const pack = encodePack(makeProject(), makeAssets());
  pack[0] = 0x58; // break magic
  const iamWasm = buildIamWasm(engineWasm, pack);
  await assert.rejects(() => IamCore.create(iamWasm), /bad magic/);
});

test('validation catches broken references', () => {
  const project = makeProject();
  project.sections[0].tracks[0].items[0].assetId = 999;
  assert.throws(() => encodePack(project, makeAssets()), /missing asset 999/);
});
