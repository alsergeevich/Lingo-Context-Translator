#!/usr/bin/env node
/**
 * Package the built extension into a distributable zip.
 *
 * The archive contains the contents of `dist/` at its root, which is exactly what
 * "Load unpacked" and the Chrome Web Store expect. No external tools: a minimal ZIP writer
 * is included so packaging works without spawning `zip` or PowerShell's Compress-Archive.
 *
 * Usage: node scripts/package.mjs
 */
import { readdir, readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { deflateRawSync } from 'node:zlib';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');
const outDir = path.join(root, 'release');

/* -------------------------------- zip writer ------------------------------- */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let k = 0; k < 8; k++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i++) crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function dosDateTime(date) {
  const time = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() / 2) & 0x1f);
  const day = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0x0f) << 5) | (date.getDate() & 0x1f);
  return { time, day };
}

/**
 * @param {{ name: string, data: Buffer }[]} entries
 * @returns {Buffer}
 */
function createZip(entries) {
  const now = new Date();
  const { time, day } = dosDateTime(now);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const raw = entry.data;
    const deflated = deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const payload = useDeflate ? deflated : raw;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // made by: unix, 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(useDeflate ? 8 : 0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0x81a40000, 38); // external attrs: 0644
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + payload.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, centralBuffer, end]);
}

/* ---------------------------------- collect -------------------------------- */

async function walk(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full, base)));
    else out.push({ name: path.relative(base, full).replace(/\\/g, '/'), path: full });
  }
  return out;
}

async function main() {
  if (!existsSync(dist)) {
    console.error('[package] dist/ not found — run npm run build first');
    process.exit(1);
  }

  const manifest = JSON.parse(await readFile(path.join(dist, 'manifest.json'), 'utf8'));
  const files = await walk(dist);
  const entries = [];

  for (const file of files) {
    const info = await stat(file.path);
    entries.push({ name: file.name, data: await readFile(file.path), size: info.size });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  await mkdir(outDir, { recursive: true });
  const zipName = `lingo-context-${manifest.version}.zip`;
  const zipPath = path.join(outDir, zipName);
  const zip = createZip(entries.map(({ name, data }) => ({ name, data })));
  await writeFile(zipPath, zip);

  const total = entries.reduce((sum, entry) => sum + entry.size, 0);
  console.log(`[package] ${entries.length} files, ${(total / 1024).toFixed(1)} kB raw`);
  console.log(`[package] ${zipPath} (${(zip.length / 1024).toFixed(1)} kB)`);

  // Sanity: every referenced asset from the manifest must exist in the archive.
  const names = new Set(entries.map((entry) => entry.name));
  const required = new Set([
    manifest.background?.service_worker,
    manifest.action?.default_popup,
    manifest.options_ui?.page,
    ...(manifest.content_scripts ?? []).flatMap((script) => script.js ?? []),
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action?.default_icon ?? {}),
  ].filter(Boolean));

  const missing = [...required].filter((file) => !names.has(file));
  if (missing.length > 0) {
    console.error('[package] missing files referenced by the manifest:', missing);
    process.exit(1);
  }

  // The print page and locales are referenced from code, not from the manifest.
  for (const extra of ['print.html', 'print.js', 'print.css', '_locales/ru/messages.json', '_locales/en/messages.json']) {
    if (!names.has(extra)) {
      console.error(`[package] missing ${extra}`);
      process.exit(1);
    }
  }

  console.log('[package] manifest references verified');
}

main().catch((err) => {
  console.error('[package] failed:', err);
  process.exit(1);
});
