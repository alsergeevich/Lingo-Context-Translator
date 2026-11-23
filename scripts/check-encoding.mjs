/**
 * Detect and repair mojibake: UTF-8 Cyrillic text that was decoded as cp1251, producing
 * artifacts like "РџСЂРёРІРµС‚" instead of "Привет".
 *
 * The heavy lifting lives in `scripts/encoding-lib.mjs`, shared with the encoding test, so
 * the checker and the guard always agree on what counts as broken.
 *
 * Usage: node scripts/check-encoding.mjs [--fix]
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { repairLine } from './encoding-lib.ts';

const root = path.resolve(import.meta.dirname, '..');
const fix = process.argv.includes('--fix');
const SKIP = new Set(['node_modules', 'dist', '.tmp-e2e', '.npm-cache', '.tmp-tests', '.git']);

async function walk(dir, files = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, files);
    else if (/\.(ts|mjs|js|json|css|html|md)$/.test(entry.name)) files.push(full);
  }
  return files;
}

const report = [];
for (const file of await walk(root)) {
  const lines = (await readFile(file, 'utf8')).split('\n');
  const broken = [];
  lines.forEach((line, index) => {
    if (repairLine(line) !== null) broken.push(index);
  });
  if (broken.length === 0) continue;
  report.push({ file: path.relative(root, file), indexes: broken, sample: lines[broken[0]].trim().slice(0, 90) });
}

if (report.length === 0) {
  console.log('[encoding] OK — no mojibake found');
  process.exit(0);
}

const total = report.reduce((sum, entry) => sum + entry.indexes.length, 0);
console.log(`[encoding] ${total} broken lines in ${report.length} files:`);
for (const entry of report) console.log(`  ${entry.file}  x${entry.indexes.length}  e.g. ${JSON.stringify(entry.sample)}`);

if (!fix) {
  console.log('\nRun with --fix to repair.');
  process.exit(1);
}

for (const entry of report) {
  const full = path.join(root, entry.file);
  const lines = (await readFile(full, 'utf8')).split('\n');
  let changed = 0;
  for (const index of entry.indexes) {
    const repaired = repairLine(lines[index]);
    if (repaired === null) continue;
    lines[index] = repaired;
    changed++;
  }
  await writeFile(full, lines.join('\n'), 'utf8');
  console.log(`  вњ“ repaired ${entry.file} (${changed} lines)`);
}

console.log('\n[encoding] done');
process.exit(0);
