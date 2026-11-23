/**
 * Shared mojibake detection, imported by both the CLI checker and the encoding test.
 *
 * The criterion is proof rather than pattern matching: text counts as broken only when the
 * cp1251 → bytes → UTF-8 round trip yields valid, cleaner text. Ukrainian letters, the
 * guillemets and long dashes do not survive that round trip, so they are never flagged;
 * a UTF-8 Russian word that was read as cp1251 always is, because its cp1251 bytes happen to
 * be valid UTF-8 again.
 */

const CYRILLIC = /[\u0400-\u04FF]/gu;
const REPLACEMENT = /\uFFFD/u;
const C1 = /[\u0080-\u009F]/u;

export function countCyrillic(text: string): number {
  return (text.match(CYRILLIC) ?? []).length;
}

/** cp1251 character → byte, taken from the platform decoder so the table cannot drift. */
const CP1251_TO_BYTE = ((): Map<string, number> => {
  const decoder = new TextDecoder('windows-1251');
  const map = new Map<string, number>();
  for (let byte = 0x80; byte <= 0xff; byte++) {
    const char = decoder.decode(Uint8Array.of(byte));
    if (char && char.length === 1 && !map.has(char)) map.set(char, byte);
  }
  return map;
})();

/**
 * Attempt to restore one line. Returns the repaired text, or null when the transformation
 * cannot be proven safe — in which case the line is left exactly as it is.
 */
export function repairLine(line: string): string | null {
  if (!line || REPLACEMENT.test(line)) return null;

  const bytes: number[] = [];
  for (const char of line) {
    const byte = CP1251_TO_BYTE.get(char);
    if (byte !== undefined) {
      bytes.push(byte);
      continue;
    }
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x80) {
      bytes.push(code);
      continue;
    }
    return null; // outside cp1251: not a plain double-encode
  }

  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return null;
  }
  if (decoded.includes('\uFFFD') || C1.test(decoded)) return null;
  if (decoded === line) return null;
  if (countCyrillic(decoded) < countCyrillic(line) / 2) return null;
  return decoded;
}

/** True when a line is provably double-encoded. */
export function isBrokenLine(line: string): boolean {
  return repairLine(line) !== null;
}
