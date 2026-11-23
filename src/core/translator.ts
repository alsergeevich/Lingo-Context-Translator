/** Fetch git-lfs-free: the Tiny-parallel translate orchestrator used by the background worker. */

import type {
  ProviderConfig,
  ProviderId,
  Segment,
  TranslationResult,
} from '../shared/types';
import { TranslationError } from '../shared/types';
import type { Settings } from '../shared/settings';
import { providerPreset } from '../shared/providers';
import { adapterFor } from './providers/index';
import { mapPool } from './pool';
import { buildCacheKey, glossaryFingerprint } from './providers/types';
import { cacheGetMany, cachePutMany, type CacheEntry } from './cache';

export interface TranslateOptions {
  settings: Settings;
  config: ProviderConfig;
  segments: Segment[];
  sourceLang: string;
  targetLang: string;
  pageTitle?: string;
  pageHost?: string;
  force?: boolean;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

export interface TranslateOutcome extends TranslationResult {
  cached: number;
  failedCount: number;
}

/**
 * The single entry point used by the message router: consults the cache, translates the
 * misses through the selected provider and writes fresh entries back.
 */
export async function translateSegments(opts: TranslateOptions): Promise<TranslateOutcome> {
  const { settings, config, segments } = opts;
  const preset = providerPreset(config.id);
  const glossaryHash = glossaryFingerprint(settings, opts.pageHost);
  const keyFor = (text: string) =>
    buildCacheKey({
      provider: config.id,
      model: config.model,
      sourceLang: opts.sourceLang,
      targetLang: opts.targetLang,
      text,
      glossaryHash,
    });

  const cacheable = settings.cacheEnabled && opts.targetLang !== opts.sourceLang;
  let hits = new Map<string, string>();
  if (cacheable && !opts.force) {
    const keys = segments.map((s) => keyFor(s.text));
    hits = await cacheGetMany(keys, settings.cacheTtlDays).catch(() => new Map<string, string>());
  }

  const misses: Segment[] = [];
  const textsById = new Map<number, string>();
  for (const seg of segments) {
    const cached = hits.get(keyFor(seg.text));
    if (cached !== undefined) textsById.set(seg.id, cached);
    else misses.push(seg);
  }

  let usage: TranslationResult['usage'];
  let failedIds: number[] = [];

  if (misses.length > 0) {
    const adapter = adapterFor(config.id);
    const translated = await adapter.translate({
      segments: misses,
      sourceLang: opts.sourceLang,
      targetLang: opts.targetLang,
      pageTitle: opts.pageTitle,
      pageHost: opts.pageHost,
      settings,
      config,
      signal: opts.signal,
    });

    // Map results back onto the original segment ids by position.
    const byId = new Map<number, string>();
    misses.forEach((seg, i) => byId.set(seg.id, translated.texts[i] ?? seg.text));
    failedIds = translated.failedIds ?? [];
    usage = translated.usage;

    for (const [id, text] of byId) textsById.set(id, text);
    opts.onProgress?.(misses.length, misses.length);

    if (cacheable) {
      const now = Date.now();
      const entries: CacheEntry[] = [];
      misses.forEach((seg) => {
        if (failedIds.includes(seg.id)) return;
        const text = byId.get(seg.id);
        if (!text || text === seg.text) return;
        entries.push({
          key: keyFor(seg.text),
          translation: text,
          createdAt: now,
          provider: config.id,
          sourceLang: opts.sourceLang,
          targetLang: opts.targetLang,
        });
      });
      await cachePutMany(entries).catch(() => undefined);
    }

    opts.onProgress?.(cacheable ? misses.length : 0, misses.length);
  }

  const texts = segments.map((seg) => textsById.get(seg.id) ?? seg.text);
  return {
    texts,
    provider: config.id,
    model: preset.kind === 'mt' ? '' : config.model,
    usage,
    partial: failedIds.length > 0,
    failedIds,
    cached: hits.size,
    failedCount: failedIds.length,
  };
}

/** Build a provider config from settings for the selected provider. */
export function resolveConfig(settings: Settings, id: ProviderId, overrides?: Partial<ProviderConfig>): ProviderConfig {
  const preset = providerPreset(id);
  const stored = settings.providers[id];
  return {
    id,
    key: overrides?.key ?? stored?.key ?? '',
    model: overrides?.model ?? (stored?.model || preset.defaultModel),
    baseUrl: overrides?.baseUrl ?? (stored?.baseUrl || preset.baseUrl || ''),
    temperature: 0.2,
  };
}

export function assertProviderReady(settings: Settings, id: ProviderId): void {
  const preset = providerPreset(id);
  const config = resolveConfig(settings, id);
  if (preset.needsKey && !config.key.trim()) {
    throw new TranslationError('no_api_key', `${preset.label} requires an API key`, { provider: id });
  }
  if (preset.kind === 'llm' && !config.model.trim()) {
    throw new TranslationError('bad_response', `No model selected for ${preset.label}`, { provider: id });
  }
}

/** Ensure the extension may call this provider's host (optional permissions for custom URLs). */
export async function ensureHostPermission(url: string): Promise<boolean> {
  let origin: string;
  try {
    origin = new URL(url).origin + '/*';
  } catch {
    return false;
  }
  try {
    if (await chrome.permissions.contains({ origins: [origin] })) return true;
    return await chrome.permissions.request({ origins: [origin] });
  } catch {
    return false;
  }
}

export async function mapWithProgress<T, R>(
  items: T[],
  fn: (item: T, index: number) => Promise<R>,
  limit: number,
  signal?: AbortSignal,
  onProgress?: (done: number, total: number) => void,
): Promise<R[]> {
  return mapPool(items, fn, { limit, signal, onProgress });
}
