import { describe, it, expect } from './helpers/framework';
import {
  checkIntegrity,
  checkSlots,
  extractProtectedTokens,
  lostTokens,
  parseAnswer,
  slotUsage,
  trimToBlocks,
} from '../src/core/skill/validate';
import type { Segment } from '../src/shared/types';

const segments = (texts: string[]): Segment[] => texts.map((text, index) => ({ id: index + 1, text }));

describe('parseAnswer', () => {
  it('parses one block per id, in order', () => {
    const parsed = parseAnswer('[1] Привет\n[2] Мир', [1, 2]);
    expect(parsed.byId.get(1)).toBe('Привет');
    expect(parsed.byId.get(2)).toBe('Мир');
    expect(parsed.missing).toEqual([]);
    expect(parsed.empty).toBe(false);
  });

  it('keeps multi-line translations inside one block', () => {
    const parsed = parseAnswer('[1] Первая строка\nвторая строка\n[2] Второй', [1, 2]);
    expect(parsed.byId.get(1)).toBe('Первая строка\nвторая строка');
    expect(parsed.byId.get(2)).toBe('Второй');
  });

  it('reports missing ids', () => {
    const parsed = parseAnswer('[1] Только один', [1, 2, 3]);
    expect(parsed.missing).toEqual([2, 3]);
  });

  it('reports duplicated and unexpected ids', () => {
    const parsed = parseAnswer('[1] a\n[1] b\n[9] c', [1]);
    expect(parsed.duplicated).toEqual([1]);
    expect(parsed.unexpected).toEqual([9]);
  });

  it('tolerates a surrounding code fence', () => {
    const parsed = parseAnswer('```\n[1] Привет\n```', [1]);
    expect(parsed.byId.get(1)).toBe('Привет');
  });

  it('flags an empty answer', () => {
    expect(parseAnswer('Извините, не могу перевести.', [1]).empty).toBe(true);
  });

  it('handles ids with surrounding whitespace', () => {
    const parsed = parseAnswer('  [42]   Значение  ', [42]);
    expect(parsed.byId.get(42)).toBe('Значение');
  });
});

describe('checkIntegrity', () => {
  it('accepts a clean answer', () => {
    const source = segments(['Use the `use_signal` hook.']);
    const parsed = parseAnswer('[1] Используйте хук `use_signal`.', [1]);
    const check = checkIntegrity(source, parsed);
    expect(check.ok).toBe(true);
    expect(check.problems).toEqual([]);
  });

  it('detects a dropped inline code token', () => {
    const source = segments(['Call `cargo build` first.']);
    const parsed = parseAnswer('[1] Сначала соберите проект.', [1]);
    const check = checkIntegrity(source, parsed);
    expect(check.ok).toBe(false);
    expect(check.problems.join(' ')).toContain('lost protected tokens');
  });

  it('detects a dropped URL', () => {
    const source = segments(['See https://example.com/docs for details.']);
    const parsed = parseAnswer('[1] Подробности в документации.', [1]);
    expect(checkIntegrity(source, parsed).ok).toBe(false);
  });

  it('detects missing ids', () => {
    const source = segments(['a', 'b']);
    const parsed = parseAnswer('[1] a', [1, 2]);
    expect(checkIntegrity(source, parsed).problems.join(' ')).toContain('missing ids');
  });

  it('detects an empty answer', () => {
    const check = checkIntegrity(segments(['x']), parseAnswer('', [1]));
    expect(check.ok).toBe(false);
    expect(check.problems[0]).toContain('no "[id] text" blocks');
  });
});

describe('protected tokens', () => {
  it('extracts code spans, URLs, placeholders and filenames', () => {
    const tokens = extractProtectedTokens(
      'Edit `src/main.rs`, open https://a.b/c?d=1, keep {{name}} and %s and file index.ts',
    );
    expect(tokens).toContain('`src/main.rs`');
    expect(tokens).toContain('https://a.b/c?d=1');
    expect(tokens).toContain('{{name}}');
    expect(tokens).toContain('%s');
    expect(tokens).toContain('index.ts');
  });

  it('finds tokens lost in translation', () => {
    expect(lostTokens('Use `foo()` now', 'Теперь используйте')).toEqual(['`foo()`']);
  });

  it('returns nothing when every token survived', () => {
    expect(lostTokens('Use `foo()` now', 'Теперь используйте `foo()`')).toEqual([]);
  });
});

describe('trimToBlocks', () => {
  it('drops a preamble before the first block', () => {
    const trimmed = trimToBlocks('Конечно! Вот перевод:\n[1] Привет\n[2] Мир');
    expect(trimmed.startsWith('[1]')).toBe(true);
  });

  it('drops a trailing note', () => {
    const trimmed = trimToBlocks('[1] Привет\nNote: I kept the code unchanged.');
    expect(trimmed).toBe('[1] Привет');
  });

  it('keeps continuation lines of the last block', () => {
    const trimmed = trimToBlocks('[1] Строка один\nстрока два');
    expect(trimmed).toContain('строка два');
  });
});

describe('inline slots', () => {
  it('reads slot usage from a segment', () => {
    const usage = slotUsage('Read {{0}}the guide{{/0}} and {{1}}/x{{/1}}.');
    expect([...usage.opened].sort()).toEqual([0, 1]);
    expect([...usage.closed].sort()).toEqual([0, 1]);
  });

  it('accepts an answer that keeps every slot balanced', () => {
    expect(checkSlots('Read {{0}}the guide{{/0}}.', 'Прочитайте {{0}}руководство{{/0}}.')).toEqual([]);
  });

  it('reports a dropped slot', () => {
    const problems = checkSlots('Read {{0}}the guide{{/0}}.', 'Прочитайте руководство.');
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain('dropped');
  });

  it('reports an unclosed slot', () => {
    const problems = checkSlots('Read {{0}}the guide{{/0}}.', 'Прочитайте {{0}}руководство.');
    expect(problems.join(' ')).toContain('not closed');
  });

  it('reports an invented slot', () => {
    const problems = checkSlots('Read the guide.', 'Прочитайте {{3}}руководство{{/3}}.');
    expect(problems.join(' ')).toContain('invented');
  });

  it('lets a model move a slot pair', () => {
    expect(checkSlots('The {{0}}guide{{/0}} is long.', '{{0}}Руководство{{/0}} длинное.')).toEqual([]);
  });

  it('fails the integrity check when a link slot is lost', () => {
    const source = segments(['Read {{0}}the guide{{/0}} before you start.']);
    const parsed = parseAnswer('[1] Прочитайте руководство перед началом.', [1]);
    const check = checkIntegrity(source, parsed);
    expect(check.ok).toBe(false);
    expect(check.problems.join(' ')).toContain('slot');
  });
});