import { describe, it, expect } from './helpers/framework';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * License checks.
 *
 * A public repository without a license file is legally "all rights reserved": nobody may
 * reuse or fork the code, even though it sits in the open. Stores also ask for the license
 * during review. These tests keep the file and the `package.json` field from drifting apart.
 */
const root = path.resolve(import.meta.dirname, '..');
const licensePath = path.join(root, 'LICENSE');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  license?: string;
  private?: boolean;
};

describe('license', () => {
  it('ships an MIT license file naming the copyright holder', () => {
    expect(existsSync(licensePath)).toBe(true);
    const text = readFileSync(licensePath, 'utf8');
    expect(text.startsWith('MIT License')).toBe(true);
    expect(text).toContain('Copyright (c) 2026 alsergeevich');
    // The two clauses that make MIT MIT, not a custom permissive text.
    expect(text).toContain('THE SOFTWARE IS PROVIDED "AS IS"');
    expect(text).toContain('The above copyright notice and this permission notice shall be included');
  });

  it('declares the same license in package.json', () => {
    expect(pkg.license).toBe('MIT');
  });
});
