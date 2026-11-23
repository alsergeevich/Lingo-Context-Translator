/**
 * Validation of the model's answer: one "[id] text" block per requested segment.
 *
 * Anything that fails here is never applied to the page — the caller retries with a
 * repair instruction or falls back to the original text, so a malformed answer can
 * never corrupt the DOM.
 */
import type { Segment } from '../../shared/types';

export interface ParsedAnswer {
  /** Id -> translated text. */
  byId: Map<number, string>;
  missing: number[];
  unexpected: number[];
  duplicated: number[];
  /** True when nothing usable was found. */
  empty: boolean;
}

const BLOCK_START = /^\s*\[(\d+)\]\s?/;

export function parseAnswer(raw: string, expectedIds: number[]): ParsedAnswer {
  const expected = new Set(expectedIds);
  const byId = new Map<number, string>();
  const duplicated: number[] = [];
  const unexpected: number[] = [];

  const text = stripFence(raw);
  const lines = text.split(/\r?\n/);
  let currentId: number | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (currentId === null) return;
    const body = buffer.join('\n').replace(/^\s+|\s+$/g, '');
    if (!expected.has(currentId)) {
      unexpected.push(currentId);
    } else if (byId.has(currentId)) {
      duplicated.push(currentId);
    } else {
      byId.set(currentId, body);
    }
    buffer = [];
  };

  for (const line of lines) {
    const m = BLOCK_START.exec(line);
    if (m) {
      flush();
      currentId = Number(m[1]);
      buffer = [line.slice(m[0].length)];
      continue;
    }
    if (currentId !== null) buffer.push(line);
  }
  flush();

  const missing = expectedIds.filter((id) => !byId.has(id));
  return {
    byId,
    missing,
    unexpected,
    duplicated,
    empty: byId.size === 0,
  };
}

function stripFence(raw: string): string {
  const trimmed = raw.trim();
  const fence = /^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n?```$/.exec(trimmed);
  if (fence) return fence[1];
  return trimmed;
}

export interface AlignmentCheck {
  ok: boolean;
  problems: string[];
}

/**
 * Structural checks beyond the id match: the model must not swallow inline code,
 * URLs or placeholders, and must not invent extra blocks.
 */
export function checkIntegrity(source: Segment[], parsed: ParsedAnswer): AlignmentCheck {
  const problems: string[] = [];
  if (parsed.empty) problems.push('answer contains no "[id] text" blocks');
  if (parsed.missing.length) problems.push(`missing ids: ${parsed.missing.join(', ')}`);
  if (parsed.unexpected.length) problems.push(`unexpected ids: ${parsed.unexpected.join(', ')}`);
  if (parsed.duplicated.length) problems.push(`duplicated ids: ${parsed.duplicated.join(', ')}`);

  for (const seg of source) {
    const out = parsed.byId.get(seg.id);
    if (!out) continue;
    for (const problem of checkSlots(seg.text, out)) {
      problems.push(`segment ${seg.id}: ${problem}`);
    }
    const lost = lostTokens(seg.text.replace(/\{\{\/?\d+\}\}/g, ' '), out);
    if (lost.length > 0) {
      problems.push(`segment ${seg.id} lost protected tokens: ${lost.slice(0, 4).join(', ')}`);
    }
  }

  return { ok: problems.length === 0, problems };
}

const PROTECTED_PATTERNS: RegExp[] = [
  /```[\s\S]*?```/g,
  /`[^`\n]+`/g,
  /https?:\/\/[^\s<>"')]+/g,
  /\{\{[^}]+\}\}/g,
  /\{[0-9]+\}/g,
  /%[sdif]/g,
  /[$€£]\d[\d\s.,]*/g,
  /\b[A-Z][A-Z0-9_]{2,}\b/g, // CONSTANTS and acronyms
  /\b\w+\.(?:js|ts|tsx|py|rs|go|java|c|cpp|cs|rb|php|sh|json|ya?ml|toml|md|css|html)\b/g,
];

const SLOT_RE = /\{\{\/?(\d+)\}\}/g;

/** Slot indices used by a string, with their opening/closing balance. */
export function slotUsage(text: string): { opened: Set<number>; closed: Set<number> } {
  const opened = new Set<number>();
  const closed = new Set<number>();
  SLOT_RE.lastIndex = 0;
  for (const match of text.matchAll(SLOT_RE)) {
    const index = Number(match[1]);
    if (match[0].startsWith('{{/')) closed.add(index);
    else opened.add(index);
  }
  return { opened, closed };
}

/**
 * Slot check: every slot the source opened must be opened (and balanced) in the answer.
 * A model that drops a link or unbalances a pair would corrupt the page, so this is a hard
 * failure — the caller retries with a repair prompt.
 */
export function checkSlots(sourceText: string, translation: string): string[] {
  const source = slotUsage(sourceText);
  const target = slotUsage(translation);
  const problems: string[] = [];

  for (const index of source.opened) {
    if (!target.opened.has(index)) problems.push(`slot {{${index}}} was dropped`);
    else if (!target.closed.has(index)) problems.push(`slot {{${index}}} was not closed`);
  }
  for (const index of target.opened) {
    if (!source.opened.has(index)) problems.push(`slot {{${index}}} was invented`);
  }
  return problems;
}

/** Tokens that must survive translation verbatim. */
export function extractProtectedTokens(text: string): string[] {
  const found = new Set<string>();
  for (const pattern of PROTECTED_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      // A URL regex happily eats the sentence's trailing punctuation; do not require
      // the translation to keep a comma that was never part of the address.
      const token = match[0].replace(/[.,;:!?]+$/, '');
      if (token.trim().length >= 2) found.add(token);
    }
  }
  return [...found];
}

export function lostTokens(source: string, translation: string): string[] {
  const tokens = extractProtectedTokens(source);
  return tokens.filter((token) => !translation.includes(token));
}

/**
 * Split a long answer that the model wrapped in prose: take everything between the
 * first and the last id block, dropping commentary before and after.
 */
export function trimToBlocks(raw: string): string {
  const lines = raw.split(/\r?\n/);
  const firstIdx = lines.findIndex((l) => BLOCK_START.test(l));
  if (firstIdx < 0) return raw;
  let lastIdx = firstIdx;
  for (let i = lines.length - 1; i >= firstIdx; i--) {
    if (BLOCK_START.test(lines[i])) {
      lastIdx = i;
      break;
    }
  }
  // include trailing continuation lines of the last block, but stop at a "Note:" style tail
  let end = lastIdx;
  for (let i = lastIdx + 1; i < lines.length; i++) {
    if (/^\s*(note|примечание|explanation|объяснение)\s*[:：]/i.test(lines[i])) break;
    end = i;
  }
  return lines.slice(firstIdx, end + 1).join('\n');
}
