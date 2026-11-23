// @ts-check
/**
 * Full verification pipeline: typecheck → tests → build → bundle integration → DOM e2e.
 *
 * `npm run verify` runs everything a change must pass before it is considered done.
 * Chrome itself cannot be launched from the sandboxed shell, so the browser-level checks are
 * performed by `tools/bundle-e2e.mjs` (the real bundle in Node with a chrome API mock) and
 * `tools/dom-e2e.mjs` (the real page in jsdom).
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

const steps = [
  { name: 'typecheck', cmd: process.execPath, args: ['node_modules/typescript/bin/tsc', '--noEmit'] },
  { name: 'unit tests', cmd: process.execPath, args: ['scripts/test.mjs'] },
  { name: 'build', cmd: process.execPath, args: ['scripts/build.mjs'] },
  { name: 'bundle e2e', cmd: process.execPath, args: ['tools/bundle-e2e.mjs'] },
  { name: 'dom e2e', cmd: process.execPath, args: ['tools/dom-e2e.mjs'] },
  { name: 'ui smoke', cmd: process.execPath, args: ['tools/ui-smoke.mjs'] },
  { name: 'encoding', cmd: process.execPath, args: ['scripts/check-encoding.mjs'] },
  { name: 'package', cmd: process.execPath, args: ['scripts/package.mjs'] },
];

let failed = 0;
for (const step of steps) {
  process.stdout.write(`\n=== ${step.name} ===\n`);
  const result = spawnSync(step.cmd, step.args, { cwd: root, stdio: 'inherit', encoding: 'utf8' });
  if (result.status !== 0) {
    failed++;
    process.stdout.write(`\n=== ${step.name} FAILED (exit ${result.status}) ===\n`);
    break;
  }
}

process.stdout.write(failed === 0 ? '\nALL CHECKS PASSED\n' : '\nCHECKS FAILED\n');
process.exit(failed === 0 ? 0 : 1);
