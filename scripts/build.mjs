#!/usr/bin/env node
/**
 * Zero-dependency bundler for the extension.
 *
 * The environment may forbid spawning child processes (sandboxed shells), which makes
 * esbuild/rollup unusable. This script bundles with the TypeScript compiler that is
 * already a dev dependency: each module is transpiled to CommonJS, then wired into a
 * tiny module registry emitted as a single classic script per entry point.
 * Only relative imports are supported — by design, the extension has no runtime deps.
 *
 * Usage: node scripts/build.mjs [--watch]
 */
import ts from 'typescript';
import { mkdir, readFile, readdir, rm, cp, stat, writeFile } from 'node:fs/promises';
import { existsSync, watch as fsWatch } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const watch = process.argv.slice(2).includes('--watch');

const ENTRIES = [
  ['src/background/index.ts', 'background.js'],
  ['src/content/index.ts', 'content.js'],
  ['src/popup/index.ts', 'popup.js'],
  ['src/options/index.ts', 'options.js'],
  ['src/print/index.ts', 'print.js'],
];

const EXTENSIONS = ['', '.ts', '.tsx', '.js', '.mjs', '/index.ts'];

const rel = (file) => path.relative(root, file).replace(/\\/g, '/');

/* ------------------------------- module graph ------------------------------ */

async function resolveModule(spec, from) {
  if (!spec.startsWith('.')) {
    throw new Error(`Only relative imports are supported, got "${spec}" in ${rel(from)}`);
  }
  const base = path.resolve(path.dirname(from), spec);
  for (const ext of EXTENSIONS) {
    const candidate = base + ext;
    if (existsSync(candidate) && (await stat(candidate)).isFile()) return candidate;
  }
  throw new Error(`Cannot resolve "${spec}" from ${rel(from)}`);
}

function transpile(file, source) {
  const result = ts.transpileModule(source, {
    fileName: file,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      useDefineForClassFields: true,
      esModuleInterop: true,
      removeComments: false,
    },
    reportDiagnostics: true,
  });
  const errors = (result.diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length) {
    for (const d of errors) {
      const pos = d.file && d.start != null ? d.file.getLineAndCharacterOfPosition(d.start) : null;
      const where = pos ? `${file}:${pos.line + 1}:${pos.character + 1}` : file;
      console.error(`${where} — ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
    }
    throw new Error(`Transpile failed: ${rel(file)}`);
  }
  return result.outputText;
}

const REQUIRE_RE = /\brequire\(\s*(["'])([^"']+)\1\s*\)/g;

async function collect(entryFile, modules = new Map()) {
  if (modules.has(entryFile)) return modules;
  const source = await readFile(entryFile, 'utf8');
  const code = transpile(rel(entryFile), source);
  const deps = new Map();
  modules.set(entryFile, { file: entryFile, code, deps });
  let m;
  REQUIRE_RE.lastIndex = 0;
  while ((m = REQUIRE_RE.exec(code))) {
    const spec = m[2];
    if (!spec.startsWith('.') || deps.has(spec)) continue;
    const resolved = await resolveModule(spec, entryFile);
    deps.set(spec, resolved);
    await collect(resolved, modules);
  }
  return modules;
}

/* --------------------------------- bundling -------------------------------- */

async function bundle(entry) {
  const entryFile = path.join(root, entry);
  const modules = await collect(entryFile);
  const defs = [];

  for (const { file, code, deps } of modules.values()) {
    const map = {};
    for (const [spec, resolved] of deps) map[spec] = rel(resolved);
    defs.push(
      `  ${JSON.stringify(rel(file))}: [function (module, exports, require) {\n${code}\n}, ${JSON.stringify(map)}]`,
    );
  }

  return `/* Lingo Context — built bundle. Source: ${rel(entryFile)} */
(function () {
'use strict';
var __defs = {
${defs.join(',\n')}
};
var __cache = Object.create(null);
function __load(id) {
  var cached = __cache[id];
  if (cached) return cached.exports;
  var def = __defs[id];
  if (!def) throw new Error('Module not found: ' + id);
  var module = { exports: {} };
  __cache[id] = module;
  var map = def[1];
  def[0].call(module.exports, module, module.exports, function (spec) {
    return __load(Object.prototype.hasOwnProperty.call(map, spec) ? map[spec] : spec);
  });
  return module.exports;
}
__load(${JSON.stringify(rel(entryFile))});
})();
`;
}

/* ---------------------------------- output --------------------------------- */

async function copyStatic() {
  await cp(path.join(root, 'public'), dist, { recursive: true });
  await cp(path.join(root, 'src/popup/popup.css'), path.join(dist, 'popup.css'));
  await cp(path.join(root, 'src/options/options.css'), path.join(dist, 'options.css'));
  await cp(path.join(root, 'src/print/print.css'), path.join(dist, 'print.css'));
}

async function ensureIcons() {
  const icons = path.join(root, 'public/icons');
  const present = existsSync(icons) && (await readdir(icons)).some((f) => f.endsWith('.png'));
  if (!present) await import('./icons.mjs');
}

async function buildOnce() {
  await rm(dist, { recursive: true, force: true });
  await mkdir(dist, { recursive: true });
  await ensureIcons();
  await copyStatic();
  const report = [];
  for (const [entry, out] of ENTRIES) {
    const code = await bundle(entry);
    await writeFile(path.join(dist, out), code, 'utf8');
    report.push(`${out.padEnd(14)} ${(Buffer.byteLength(code) / 1024).toFixed(1)} kB`);
  }
  console.log('[build] done:\n  ' + report.join('\n  '));
}

async function main() {
  await buildOnce();
  if (!watch) return;
  let timer = null;
  const onChange = (_event, file) => {
    if (file && !/\.(ts|css|json|html)$/.test(file)) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      buildOnce().catch((err) => console.error('[build] failed:', err.message));
    }, 150);
  };
  for (const dir of ['src', 'public']) fsWatch(path.join(root, dir), { recursive: true }, onChange);
  console.log('[build] watching src/ and public/ …');
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
