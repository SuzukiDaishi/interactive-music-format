// Guards the AudioWorklet's inlined WCLAP host (IAM_WORKLET_SOURCE) against
// regressions that the node-side host (host.ts) can't catch — most notably the
// CLAP note on/off event-type mapping. A swapped mapping turns every note-on
// into a note-off, so the synth stays silent in the browser even though the
// integration test (which uses host.ts) passes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { IAM_WORKLET_SOURCE, loadWclapBundle } from '@iam/player';

const SR = 48000;
const wclapDir = fileURLToPath(new URL('../wclap/', import.meta.url));

/**
 * Pulls makeInstance/buildTrampoline out of the worklet source string.
 * TextEncoder/TextDecoder are shadowed to undefined because Chrome's
 * AudioWorkletGlobalScope has no Encoding API — the worklet source must never
 * rely on them (a real-browser silent-instruments bug Node globals would hide).
 */
function extractWorkletHost() {
  const factory = new Function(
    'registerProcessor',
    'AudioWorkletProcessor',
    'sampleRate',
    'TextEncoder',
    'TextDecoder',
    `${IAM_WORKLET_SOURCE}\nreturn { makeInstance, buildTrampoline };`,
  );
  return factory(() => {}, class {}, SR, undefined, undefined);
}

test('worklet synth host renders audio for note-on (correct CLAP note mapping)', async () => {
  const { makeInstance, buildTrampoline } = extractWorkletHost();
  const { moduleBytes } = await loadWclapBundle(
    new Uint8Array(await readFile(wclapDir + 'z-audio-simple-synth.wclap.tar.gz')),
  );
  const module = new WebAssembly.Module(moduleBytes);
  const trampoline = buildTrampoline();
  const block = 256;
  const inst = makeInstance(module, {
    sampleRate: SR,
    maxFrames: block,
    clapPluginId: 'dev.zaudio.simple-synth',
    params: [],
    audioInputs: 0,
    trampoline,
  });

  inst.noteOn(60, 0, 1.0, 0);
  let energy = 0;
  // ~0.25s while the note is held.
  for (let done = 0; done < SR * 0.25; done += block) {
    const out = inst.process(block);
    for (let i = 0; i < block; i++) energy += Math.abs(out.left[i]) + Math.abs(out.right[i]);
  }
  assert.ok(energy > 1, `held note-on must be audible (energy=${energy})`);
});
