/**
 * Provider adapters.
 *
 * Every adapter takes a batch of segments and returns translations in the same order.
 * LLM adapters share the skill prompt and the "[id] text" protocol; machine-translation
 * adapters call their REST endpoints one segment at a time (or in small batches) because
 * those services have no notion of context.
 */
import type { ProviderConfig, Segment, TranslationResult } from '../../shared/types';
import { TranslationError } from '../../shared/types';
import { providerPreset } from '../../shared/providers';
import type { Settings } from '../../shared/settings';
import { SKILL_VERSION } from '../skill/version';

export interface TranslateArgs {
  segments: Segment[];
  sourceLang: string;
  targetLang: string;
  pageTitle?: string;
  pageHost?: string;
  topicHint?: string;
  settings: Settings;
  config: ProviderConfig;
  signal?: AbortSignal;
}

export interface ProviderAdapter {
  id: ProviderConfig['id'];
  /** Translate one batch, returning one string per segment. */
  translate(args: TranslateArgs): Promise<TranslationResult>;
  /** Cheap request used by the "Test" button in settings. */
  probe(config: ProviderConfig, signal?: AbortSignal): Promise<{ model: string; sample: string }>;
}

export function requestTimeout(settings: Settings): number {
  return settings.requestTimeoutSec * 1000;
}

export function ensureKey(config: ProviderConfig, providerLabel: string): string {
  const key = config.key.trim();
  if (!key) {
    throw new TranslationError('no_api_key', `No API key configured for ${providerLabel}`);
  }
  return key;
}

/** Cache key: identical inputs with a different skill version must not collide. */
export function buildCacheKey(parts: {
  provider: string;
  model: string;
  sourceLang: string;
  targetLang: string;
  text: string;
  glossaryHash: string;
  extra?: string;
}): string {
  return [
    'v' + SKILL_VERSION,
    parts.provider,
    parts.model,
    parts.sourceLang,
    parts.targetLang,
    parts.glossaryHash,
    parts.extra ?? '',
    parts.text,
  ].join('\u0001');
}

export function hashString(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = (h1 ^ c) * 0x01000193;
    h2 = (h2 + c * (i + 1)) ^ (h2 << 5);
  }
  return ((h1 >>> 0).toString(36) + (h2 >>> 0).toString(36)).slice(0, 16);
}

export function glossaryFingerprint(settings: Settings, host?: string): string {
  const entries = settings.glossary
    .filter((g) => !g.site || !host || host.includes(g.site))
    .map((g) => `${g.source}=${g.target}`)
    .join('|');
  return hashString(entries + '|' + (settings.customInstruction || '') + '|' + settings.translateCodeComments);
}

export function isMtProvider(id: ProviderConfig['id']): boolean {
  return providerPreset(id).kind === 'mt';
}
