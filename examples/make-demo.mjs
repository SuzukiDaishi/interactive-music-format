#!/usr/bin/env node
/**
 * Builds examples/out/adventure_demo.iam.wasm from the synthesized demo
 * project, then sanity-checks it by rendering a few seconds offline.
 *
 *   node examples/make-demo.mjs [output.iam.wasm]
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { encodePack, buildIamWasm } from '@iam/pack';
import { IamCore } from '@iam/player';
import { makeDemo } from './demo-project.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const outPath =
  process.argv[2] ?? path.join(root, 'examples', 'out', 'adventure_demo.iam.wasm');

const engine = new Uint8Array(await readFile(path.join(root, 'runtime', 'engine.wasm')));
const { project, assets } = makeDemo();

// Supply the embedded WCLAP bundle bytes for each bank plugin.
const BUNDLE_FILES = {
  'dev.zaudio.simple-synth': 'z-audio-simple-synth.wclap.tar.gz',
  'dev.zaudio.limiter': 'z-audio-limiter.wclap.tar.gz',
  'dev.zaudio.vcsl-piano': 'z-audio-vcsl-piano.wclap.tar.gz',
};
const plugins = [];
for (const p of project.plugins ?? []) {
  const file = p.embedded ? BUNDLE_FILES[p.clapPluginId] : undefined;
  const data = file ? new Uint8Array(await readFile(path.join(root, 'wclap', file))) : undefined;
  plugins.push({ id: p.id, name: p.name, clapPluginId: p.clapPluginId, url: p.url, data });
}

const pack = encodePack(project, assets, {}, plugins);
const iamWasm = buildIamWasm(engine, pack);

await mkdir(path.dirname(outPath), { recursive: true });
await writeFile(outPath, iamWasm);
console.log(`wrote ${outPath} (${(iamWasm.length / 1024 / 1024).toFixed(2)} MB)`);
console.log(`  engine: ${(engine.length / 1024).toFixed(0)} KB, pack: ${(pack.length / 1024 / 1024).toFixed(2)} MB`);

// --- offline sanity check ---------------------------------------------------
const core = await IamCore.create(iamWasm);
core.init(48000, 2);
core.setSeed(42);
core.play();

const render = (sec) => {
  for (let i = 0; i < sec * 100; i++) core.render(480);
};

render(2);
console.log(`t=2s   section=${core.currentSection} beats=${core.positionBeats.toFixed(2)}`);
core.setRtpc('is_battle', true);
render(3);
console.log(`battle section=${core.currentSection}`);
core.setRtpc('intensity', 0.9);
render(5);
console.log(`high   section=${core.currentSection}`);
core.setRtpc('intensity', 0.2);
render(3); // let the nextBar transition back to Battle_Low land
core.pollEvents(); // drain (the queue caps at 256)
// v3 track transition: swap only the Drums slot of Battle_Low (graph cue).
core.triggerCue('swap_drums');
render(3);
const trackGoto = core.pollEvents().filter((e) => e.type === 10);
console.log(`swap   section=${core.currentSection} trackGotoEvents=${trackGoto.length}`);
core.triggerCue('restore_drums');
render(3);
core.triggerCue('to_ending');
render(12);
console.log(`ending section=${core.currentSection} playing=${core.playing}`);
const events = core.pollEvents();
console.log(`events drained: ${events.length}`);
