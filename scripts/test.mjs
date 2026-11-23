#!/usr/bin/env node
/**
 * Test runner for the extension.
 *
 * Test files import the in-repo framework (`tests/helpers/framework.ts`) whose registry is
 * shared across files, so one process loads every file and then runs the collected tests.
 * TypeScript is executed by Node itself (type stripping, Node >= 22.6); a resolve hook adds
 * the `.ts` extension to extensionless relative imports, which the bundler also accepts.
 *
 * Usage: node scripts/test.mjs [filter]
 */
import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'node:module';

const root = path.resolve(import.meta.dirname, '..');
const testsDir = path.join(root, 'tests');
const filter = process.argv[2] ?? null;

/* ----------------------------- resolve extensionless ---------------------- */

const EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.js'];

register('./test-resolve-hook.mjs', import.meta.url);

/* ---------------------------------- runner -------------------------------- */

async function findTests(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await findTests(full)));
    else if (/\.test\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

function supportsTypeStripping() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return major > 22 || (major === 22 && minor >= 6);
}

async function main() {
  if (!supportsTypeStripping()) {
    console.error(`Node ${process.versions.node} cannot run TypeScript directly; Node >= 22.6 is required.`);
    process.exit(1);
  }

  let files = await findTests(testsDir);
  if (filter) files = files.filter((file) => path.relative(root, file).includes(filter));
  if (files.length === 0) {
    console.error('No test files found' + (filter ? ` matching "${filter}"` : ''));
    process.exit(1);
  }

  const framework = await import(pathToFileURL(path.join(testsDir, 'helpers', 'framework.ts')).href);
  const registry = framework.registry;

  for (const file of files) {
    try {
      await import(pathToFileURL(file).href);
    } catch (err) {
      const label = path.relative(root, file);
      console.error(`\n✗ failed to load ${label}\n${err instanceof Error ? (err.stack ?? err.message) : err}`);
      registry.push({ suite: ['<load>'], name: label, fn: () => { throw err; } });
    }
  }

  let passed = 0;
  let failed = 0;
  const failures = [];

  for (const testCase of registry) {
    const label = [...testCase.suite, testCase.name].filter(Boolean).join(' > ');
    try {
      await testCase.fn();
      passed++;
      process.stdout.write(`  \x1b[32m✓\x1b[0m ${label}\n`);
    } catch (err) {
      failed++;
      failures.push({ label, err });
      process.stdout.write(`  \x1b[31m✗\x1b[0m ${label}\n`);
    }
  }

  if (failures.length > 0) {
    process.stdout.write('\nFailures:\n');
    for (const { label, err } of failures) {
      const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
      process.stdout.write(`\n  ${label}\n    ${message.split('\n').join(' > ')}\n`);
    }
  }

  const colour = failed > 0 ? '\x1b[31m' : '\x1b[32m';
  process.stdout.write(`\n${colour}${passed} passed, ${failed} failed, ${registry.length} total\x1b[0m\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
