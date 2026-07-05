// Cue -> graph migration: migrated projects compile back to the same runtime
// behavior (the DAW now presents cues as node graphs only).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { migrateCuesToGraphs, compileGraphs, encodePack, buildIamWasm } from '@iam/pack';
import { IamCore } from '@iam/player';
import { makeDemo } from '../examples/demo-project.mjs';

const engineWasm = new Uint8Array(
  await readFile(fileURLToPath(new URL('../runtime/engine.wasm', import.meta.url))),
);

test('migrating the demo cues yields graphs that compile cleanly', () => {
  const { project } = makeDemo();
  const cueCount = project.cues.length;
  const graphCount = project.graphs?.length ?? 0;
  migrateCuesToGraphs(project);
  assert.equal(project.cues.length, 0);
  assert.equal(project.bindings.length, 0);
  assert.equal(project.graphs.length, graphCount + cueCount);
  const { cues, bindings } = compileGraphs(project);
  assert.ok(cues.length >= cueCount, 'every migrated cue compiles to a generated cue');
  assert.ok(bindings.length >= 4, 'bound triggers survive migration');
  // Manual cues keep their names so triggerCue('to_ending') still works.
  assert.ok(cues.some((c) => c.name === 'to_ending'));
  assert.ok(cues.some((c) => c.name === 'swap_drums'));
});

test('a migrated module behaves like the original (battle switch)', async () => {
  const { project, assets } = makeDemo();
  migrateCuesToGraphs(project);
  // No bundle bytes in this test: reference plugins by URL (engine skips WCLP).
  for (const p of project.plugins) {
    p.embedded = false;
    p.url = 'https://example.invalid/bundle.tar.gz';
  }
  const pack = encodePack(project, assets, { includeMeta: false });
  const core = await IamCore.create(buildIamWasm(engineWasm, pack));
  core.init(48000, 2);
  core.setSeed(7);
  core.play();
  for (let i = 0; i < 100; i++) core.render(480);
  assert.equal(core.currentSection, 'Explore');
  core.setRtpc('is_battle', true);
  for (let i = 0; i < 300; i++) core.render(480);
  assert.equal(core.currentSection, 'Battle_Low', 'rtpc-bound migrated graph transitions');
  core.setRtpc('intensity', 0.9);
  for (let i = 0; i < 500; i++) core.render(480);
  assert.equal(core.currentSection, 'Battle_High', 'stop-if-matched cascade preserved');
  core.triggerCue('to_ending');
  for (let i = 0; i < 3000; i++) core.render(480);
  assert.equal(core.playing, false, 'manual migrated cue ends the music');
});
