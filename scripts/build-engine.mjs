#!/usr/bin/env node
// Cross-platform engine build: cargo build + copy into runtime/.
// (Replaces `cd engine && cargo build && cp …`, which breaks on Windows.)
import { execSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(new URL('.', import.meta.url)));
const engineDir = path.join(root, 'engine');

execSync('cargo build --target wasm32-unknown-unknown --release', {
  cwd: engineDir,
  stdio: 'inherit',
});

const src = path.join(
  engineDir,
  'target',
  'wasm32-unknown-unknown',
  'release',
  'iam_engine.wasm',
);
const dst = path.join(root, 'runtime', 'engine.wasm');
mkdirSync(path.dirname(dst), { recursive: true });
copyFileSync(src, dst);
console.log(`copied ${path.relative(root, src)} -> runtime/engine.wasm`);
