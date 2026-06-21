// Verifies the WCLAP host end-to-end against a real plugin bundle: load the
// .wclap (gunzip + untar + manifest), instantiate it through the CLAP ABI host,
// send a note, and confirm the synth renders non-silent audio. Also exercises an
// effect bundle in input->output mode.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { loadWclapBundle, buildTrampolineModule, WclapInstance } from '@iam/player';

const wclapDir = fileURLToPath(new URL('../wclap/', import.meta.url));
const trampoline = buildTrampolineModule();

async function bundle(name) {
  return loadWclapBundle(new Uint8Array(await readFile(wclapDir + name)));
}

function peak(buf) {
  let p = 0;
  for (let i = 0; i < buf.length; i++) p = Math.max(p, Math.abs(buf[i]));
  return p;
}

test('loads a real .wclap bundle (manifest + module)', async () => {
  const b = await bundle('z-audio-simple-synth.wclap.tar.gz');
  assert.equal(b.manifest.id, 'dev.zaudio.simple-synth');
  assert.ok(b.manifest.plugins?.length >= 1);
  assert.equal(b.moduleBytes[0], 0x00); // wasm magic \0asm
  assert.equal(b.moduleBytes[1], 0x61);
});

test('synth WCLAP renders audio on note-on', async () => {
  const b = await bundle('z-audio-simple-synth.wclap.tar.gz');
  const module = new WebAssembly.Module(b.moduleBytes);
  const inst = new WclapInstance(module, {
    sampleRate: 48000,
    maxFrames: 512,
    audioInputs: 0,
    trampoline,
  });
  // Silent before any note.
  const silent = inst.process(512);
  assert.equal(peak(silent.left), 0, 'silent before note-on');

  inst.noteOn(60, 0, 1.0, 0);
  let energy = 0;
  for (let i = 0; i < 20; i++) {
    const out = inst.process(512);
    energy += peak(out.left) + peak(out.right);
  }
  assert.ok(energy > 0.1, `synth produced audio (energy=${energy})`);

  inst.allNotesOff(0);
  // Let the envelope release over a few blocks, then expect it to quiet down.
  for (let i = 0; i < 200; i++) inst.process(512);
  const tail = inst.process(512);
  assert.ok(peak(tail.left) < 0.05, `quiet after note-off (peak=${peak(tail.left)})`);
});

test('effect WCLAP processes an input bus', async () => {
  // Use the limiter as a representative effect (input -> output).
  const path = wclapDir + 'z-audio-limiter.wclap.tar.gz';
  try {
    await access(path);
  } catch {
    return; // bundle not present; skip
  }
  const b = await bundle('z-audio-limiter.wclap.tar.gz');
  const module = new WebAssembly.Module(b.moduleBytes);
  const inst = new WclapInstance(module, {
    sampleRate: 48000,
    maxFrames: 512,
    audioInputs: 1,
    trampoline,
  });
  const inL = new Float32Array(512);
  const inR = new Float32Array(512);
  for (let i = 0; i < 512; i++) {
    inL[i] = Math.sin((2 * Math.PI * 220 * i) / 48000) * 0.9;
    inR[i] = inL[i];
  }
  let nonSilent = 0;
  for (let i = 0; i < 8; i++) {
    const out = inst.process(512, inL, inR);
    if (peak(out.left) > 0.01) nonSilent++;
  }
  assert.ok(nonSilent > 0, 'effect passed audio through');
});
