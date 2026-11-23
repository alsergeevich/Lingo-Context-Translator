import { describe, it, expect } from './helpers/framework';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { isBrokenLine, repairLine } from '../scripts/encoding-lib.ts';

/**
 * Guard against encoding regressions.
 *
 * Russian UI strings are the one thing a wrong console encoding silently destroys: the file
 * still parses, tests still pass, but the user sees "Perevesti" instead of
 * "Perevesti". The detector is shared with `scripts/check-encoding.mjs`, and it only reports
 * lines it can provably restore — so Ukrainian text and «guillemets» are never flagged.
 */
const root = path.resolve(import.meta.dirname, '..');
const SKIP = new Set(['node_modules', 'dist', '.tmp-e2e', '.npm-cache', '.tmp-tests', '.git', 'tools']);
const EXTENSIONS = /\.(ts|mjs|js|json|css|html|md)$/;

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, files);
    else if (EXTENSIONS.test(entry)) files.push(full);
  }
  return files;
}

describe('encoding', () => {
  it('recognises double-encoded Russian', () => {
    const broken = 'this.setState({ error: \'\u0420\u040e\u0420\u00b0\u0420\u2116\u0421\u201a\' });';
    expect(isBrokenLine(broken)).toBe(true);
    expect(repairLine(broken)).toContain('\u0421\u0430\u0439\u0442');
  });

  it('never flags correctly encoded Russian, Ukrainian or typography', () => {
    const healthy = [
      "'popup.savePdf': '\u0421\u043e\u0445\u0440\u0430\u043d\u0438\u0442\u044c \u0432 PDF',",
      "{ code: 'uk', label: '\u0423\u043a\u0440\u0430\u0457\u043d\u0441\u044c\u043a\u0430' },",
      "text: '\u041f\u043e\u043a\u0430\u0437\u044b\u0432\u0430\u0442\u044c \u043a\u043d\u043e\u043f\u043a\u0443 \u00ab\u041e\u0440\u0438\u0433\u0438\u043d\u0430\u043b\u00bb',",
      "// extract \u2192 request \u2192 apply",
    ];
    for (const line of healthy) expect(isBrokenLine(line)).toBe(false);
  });

  it('has no mojibake in any source file', () => {
    const problems: string[] = [];
    for (const file of walk(root)) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (isBrokenLine(line)) {
          problems.push(`${path.relative(root, file)}:${index + 1} ${JSON.stringify(line.trim().slice(0, 60))}`);
        }
      });
    }
    expect(problems).toEqual([]);
  });

  it('keeps Russian UI strings readable', () => {
    const i18n = readFileSync(path.join(root, 'src/shared/i18n.ts'), 'utf8');
    expect(i18n).toContain('\u041f\u0435\u0440\u0435\u0432\u0435\u0441\u0442\u0438 \u0441\u0442\u0440\u0430\u043d\u0438\u0446\u0443');
    expect(i18n).toContain('\u041e\u0440\u0438\u0433\u0438\u043d\u0430\u043b');
    expect(i18n).toContain('\u041d\u0430\u0441\u0442\u0440\u043e\u0439\u043a\u0438');
  });

  it('keeps the manifest localization readable', () => {
    const messages = JSON.parse(readFileSync(path.join(root, 'public/_locales/ru/messages.json'), 'utf8'));
    expect(messages.extName.message).toBe('\u041a\u043e\u043d\u0442\u0435\u043a\u0441\u0442\u043d\u044b\u0439 \u043f\u0435\u0440\u0435\u0432\u043e\u0434\u0447\u0438\u043a');
  });
});
