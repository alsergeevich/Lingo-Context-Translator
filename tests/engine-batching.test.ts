import { describe, it, expect } from './helpers/framework';
import { chunk, chunkByBudget } from '../src/core/pool';
import { PROVIDERS } from '../src/shared/providers';

/**
 * Ordinary pages used to fail while book pages worked, because requests were batched by
 * segment count only: a handful of long paragraphs blew past the service's character limit
 * (MyMemory: 500) and the service's error text was applied to the page as a translation.
 */
describe('batching by provider budget', () => {
  const segments = Array.from({ length: 60 }, (_, i) => ({ id: i, text: 'x'.repeat(150) }));

  it('keeps every request inside a small character budget', () => {
    const batches = chunkByBudget(segments, 20, 500);
    for (const batch of batches) {
      const chars = batch.reduce((sum, s) => sum + s.text.length, 0);
      expect(chars).toBeLessThanOrEqual(500 + 20 * batch.length);
    }
    expect(batches.flat()).toHaveLength(segments.length);
  });

  it('still honours the segment count limit', () => {
    const batches = chunkByBudget(segments, 5, 1_000_000);
    for (const batch of batches) expect(batch.length).toBeLessThanOrEqual(5);
  });

  it('never loses or reorders a segment', () => {
    const batches = chunkByBudget(segments, 7, 900);
    expect(batches.flat().map((s) => s.id)).toEqual(segments.map((s) => s.id));
  });

  it('declares a budget for every machine-translation provider', () => {
    for (const provider of PROVIDERS) {
      if (provider.kind !== 'mt') continue;
      expect(typeof provider.maxChunkChars).toBe('number');
      expect(provider.maxChunkChars).toBeGreaterThan(0);
    }
  });

  it('falls back to plain chunking for providers without a limit', () => {
    const llm = PROVIDERS.find((p) => p.kind === 'llm');
    expect(llm?.maxChunkChars).toBe(undefined);
    expect(chunk(segments, 20)).toHaveLength(3);
  });
});
