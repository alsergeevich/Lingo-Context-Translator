/** Concurrency-limited map with progress reporting and cooperative cancellation. */
import { TranslationError } from '../shared/types';

export interface PoolOptions {
  limit: number;
  signal?: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
}

/**
 * Run `fn` over every item with at most `limit` promises in flight.
 * Rejects on the first error (after in-flight work settles), preserving order.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  opts: PoolOptions,
): Promise<R[]> {
  const total = items.length;
  const results = new Array<R>(total);
  const limit = Math.max(1, Math.min(opts.limit, total || 1));
  let next = 0;
  let completed = 0;
  let failure: unknown = null;

  const worker = async () => {
    for (;;) {
      const index = next++;
      if (index >= total) return;
      if (opts.signal?.aborted) throw new TranslationError('aborted', 'Translation cancelled');
      if (failure) return;
      try {
        results[index] = await fn(items[index], index);
      } catch (err) {
        failure ??= err;
        return;
      }
      completed++;
      opts.onProgress?.(completed, total);
    }
  };

  await Promise.all(Array.from({ length: limit }, worker));
  if (failure) throw failure;
  return results;
}

/** Chunk an array into groups of at most `size`. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const size_ = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size_) out.push(items.slice(i, i + size_) as T[]);
  return out;
}

/**
 * Group segments into requests limited by both segment count and character budget,
 * so a single request never exceeds the model's context window.
 */
export function chunkByBudget<T extends { text: string }>(
  items: readonly T[],
  maxItems: number,
  maxChars: number,
): T[][] {
  const out: T[][] = [];
  let current: T[] = [];
  let chars = 0;
  for (const item of items) {
    const len = item.text.length + 20;
    if (current.length > 0 && (current.length >= maxItems || chars + len > maxChars)) {
      out.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += len;
  }
  if (current.length > 0) out.push(current);
  return out;
}
