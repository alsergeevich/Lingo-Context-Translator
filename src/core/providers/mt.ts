/**
 * Machine-translation adapters: Google (unofficial public endpoint), MyMemory,
 * LibreTranslate, Lingva and DeepL Free.
 *
 * They have no notion of context, so the skill does not apply here. To keep the page
 * readable we still protect inline code: a segment that is mostly an identifier is left
 * as-is, and protected tokens are restored after the service answers.
 */
import type { ProviderConfig, Segment, TranslationResult } from '../../shared/types';
import { TranslationError } from '../../shared/types';
import { providerPreset } from '../../shared/providers';
import { mtLanguageName } from '../../shared/languages';
import { httpRequest, readJson, statusToError } from './http';
import type { ProviderAdapter, TranslateArgs } from './types';
import { ensureKey, requestTimeout } from './types';
import { extractProtectedTokens } from '../skill/validate';

interface MtJob {
  segments: Segment[];
  sourceLang: string;
  targetLang: string;
  config: ProviderConfig;
  signal?: AbortSignal;
  timeoutMs: number;
}

/** Translate every segment with bounded parallelism, keeping order. */
async function runMt(
  job: MtJob,
  translateOne: (text: string, signal: AbortSignal | undefined) => Promise<string>,
  concurrency = 4,
): Promise<TranslationResult> {
  const results = new Array<string>(job.segments.length);
  const failedIds: number[] = [];
  let cursor = 0;

  const worker = async () => {
    for (;;) {
      const index = cursor++;
      if (index >= job.segments.length) return;
      if (job.signal?.aborted) throw new TranslationError('aborted', 'Translation cancelled');
      const segment = job.segments[index];
      try {
        results[index] = await translateOne(segment.text, job.signal);
      } catch (err) {
        if (err instanceof TranslationError && err.code === 'aborted') throw err;
        // A single failed segment must not kill the page: keep the original text.
        results[index] = segment.text;
        failedIds.push(segment.id);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, job.segments.length) }, worker));
  return {
    texts: results.map((text, i) => text ?? job.segments[i].text),
    provider: job.config.id,
    model: job.config.model,
    partial: failedIds.length > 0,
    failedIds,
  };
}

/** Marker for a protected token; matches the slot marker so both survive the service. */
const tokenMark = (index: number) => `\u27E6T${index}\u27E7`;
const TOKEN_GUARD = /\u27E6T(\d+)\u27E7/g;

/**
 * Inline code and identifiers must survive a context-free MT service.
 *
 * They used to be masked with `\u0001<index>\u0001`, which the service strips: `Call \u00010\u0001`
 * came back as `Вызовите 0`, the restore found nothing, and the identifier was silently lost
 * from the page. The brackets below were measured to come back untouched.
 */
function protectInline(text: string): { masked: string; tokens: string[] } {
  const tokens = extractProtectedTokens(text).sort((a, b) => b.length - a.length);
  let masked = text;
  tokens.forEach((token, i) => {
    masked = masked.split(token).join(tokenMark(i));
  });
  return { masked, tokens };
}

function restoreInline(masked: string, tokens: string[]): string | null {
  let out = masked;
  for (let i = 0; i < tokens.length; i++) {
    if (!out.includes(tokenMark(i))) return null;
    out = out.split(tokenMark(i)).join(tokens[i]);
  }
  // An unmasked marker means the service renumbered or duplicated one; refuse rather than
  // publish a page with `⟦T1⟧` in it.
  TOKEN_GUARD.lastIndex = 0;
  if (TOKEN_GUARD.test(out)) return null;
  return out;
}

/**
 * A context-free service mangles `{{0}}` markers — Google returns `{{0}}…{/0}}`, losing a brace,
 * and the literal marker then lands on the page. Shooting the whole segment through the
 * service and patching it afterwards cannot work, so the markers are swapped for plain text
 * that survives translation, and restored on the way back. `⟦0⟧`/`⟦/0⟧` were measured to come
 * back untouched from Google; if a marker is still missing, the segment is rejected and the
 * caller keeps the original instead of corrupting the page.
 */
const SLOT_OPEN = (index: number) => `\u27E6${index}\u27E7`;
const SLOT_CLOSE = (index: number) => `\u27E6/${index}\u27E7`;
const SLOT_GUARD = /\u27E6(\/?)(\d+)\u27E7/g;

export function maskSlots(text: string): string {
  return text.replace(/\{\{(\/?)(\d+)\}\}/g, (_all, closing: string, index: string) =>
    closing ? SLOT_CLOSE(Number(index)) : SLOT_OPEN(Number(index)),
  );
}

/** Put `{{n}}` markers back. Returns null when the service dropped or split one. */
export function unmaskSlots(translated: string, source: string): string | null {
  const expected = new Map<string, number>();
  for (const match of source.matchAll(/\{\{(\/?)(\d+)\}\}/g)) {
    const key = `${match[1]}${match[2]}`;
    expected.set(key, (expected.get(key) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  for (const match of translated.matchAll(SLOT_GUARD)) {
    const key = `${match[1]}${match[2]}`;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const [key, count] of expected) {
    if ((seen.get(key) ?? 0) < count) return null;
  }
  return translated.replace(SLOT_GUARD, (_all, closing: string, index: string) =>
    closing ? `{{/${index}}}` : `{{${index}}}`,
  );
}

async function translatePreservingCode(
  text: string,
  translate: (input: string) => Promise<string>,
): Promise<string> {
  const maskedSlots = maskSlots(text);
  const { masked, tokens } = protectInline(maskedSlots);
  const hasMarkers = /\{\{\/?\d+\}\}/.test(text);
  if (tokens.length === 0 && !hasMarkers) return translate(text);

  // The service is nondeterministic: a marker occasionally survives one request and not the
  // next, so it is worth one more attempt before giving up on the segment.
  let best = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    const translated = await translate(masked);
    // Inline code is masked with the same trick; both layers must survive, so mask slots
    // first and un-mask them last.
    best = translated;
    const restored = restoreInline(translated, tokens);
    if (restored === null) continue;
    const unmasked = unmaskSlots(restored, text);
    if (unmasked !== null) return unmasked;
  }
  throw new TranslationError('bad_response', `The service damaged inline markers in "${best.slice(0, 40)}…"`, {
    retryable: true,
  });
}

/* ------------------------------- Google (free) ------------------------------ */

export const googleFreeAdapter: ProviderAdapter = {
  id: 'google-free',
  async translate(args: TranslateArgs) {
    const target = args.targetLang.split('-')[0];
    const source = args.sourceLang === 'auto' ? 'auto' : args.sourceLang.split('-')[0];
    const timeoutMs = requestTimeout(args.settings);

    const result = await runMt({ ...args, segments: args.segments, timeoutMs }, async (text, signal) =>
      translatePreservingCode(text, async (input) => {
        const url =
          'https://translate.googleapis.com/translate_a/single?client=gtx&sl=' +
          encodeURIComponent(source) +
          '&tl=' +
          encodeURIComponent(target) +
          '&dt=t&q=' +
          encodeURIComponent(input);
        const res = await httpRequest(url, { method: 'GET', timeoutMs, signal, provider: 'google-free' });
        if (!res.ok) throw statusToError(res.status, res.text, 'google-free');
        let data: unknown;
        try {
          data = JSON.parse(res.text);
        } catch {
          throw new TranslationError('bad_response', 'Google returned malformed JSON', { provider: 'google-free' });
        }
        // Shape: [ [ ["translated","source",...], ... ], ... , "detectedLang", ... ]
        const chunks = Array.isArray(data) ? (data[0] as unknown[]) : undefined;
        const translated = Array.isArray(chunks)
          ? chunks
              .map((c) => (Array.isArray(c) && typeof c[0] === 'string' ? c[0] : ''))
              .join('')
          : '';
        if (!translated) {
          throw new TranslationError('bad_response', 'Google returned an empty translation', {
            provider: 'google-free',
          });
        }
        return translated;
      }),
    );

    return result;
  },
  async probe(_config, signal) {
    const url =
      'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ru&dt=t&q=' +
      encodeURIComponent('Hello, world!');
    const res = await httpRequest(url, { timeoutMs: 15_000, signal, provider: 'google-free' });
    if (!res.ok) throw statusToError(res.status, res.text, 'google-free');
    const data = JSON.parse(res.text) as unknown[];
    const text = Array.isArray(data[0]) ? (data[0] as string[][])[0]?.[0] ?? '' : '';
    return { model: 'google-free', sample: text };
  },
};

/* --------------------------------- MyMemory -------------------------------- */

export const myMemoryAdapter: ProviderAdapter = {
  id: 'mymemory',
  async translate(args: TranslateArgs) {
    const target = mtLanguageName(args.targetLang);
    const source = args.sourceLang === 'auto' ? 'en' : mtLanguageName(args.sourceLang);
    const timeoutMs = requestTimeout(args.settings);
    const key = args.config.key.trim();

    return runMt({ ...args, segments: args.segments, timeoutMs }, async (text, signal) =>
      translatePreservingCode(text, async (input) => {
        const params = new URLSearchParams({ q: input, langpair: `${source}|${target}` });
        if (key) params.set('key', key);
        const res = await httpRequest(`https://api.mymemory.translated.net/get?${params}`, {
          timeoutMs,
          signal,
          provider: 'mymemory',
        });
        const data = await readJson<{
          responseData?: { translatedText?: string };
          responseStatus?: number;
          responseDetails?: string;
        }>(res, 'mymemory');
        const translated = data.responseData?.translatedText ?? '';
        if (!translated) {
          throw new TranslationError('bad_response', data.responseDetails ?? 'MyMemory returned no text', {
            provider: 'mymemory',
          });
        }
        return translated;
      }), 2);
  },
  async probe(_config, signal) {
    const url = 'https://api.mymemory.translated.net/get?q=Hello%2C%20world!&langpair=en|ru';
    const res = await httpRequest(url, { timeoutMs: 15_000, signal, provider: 'mymemory' });
    const data = await readJson<{ responseData?: { translatedText?: string } }>(res, 'mymemory');
    return { model: 'mymemory', sample: data.responseData?.translatedText ?? '' };
  },
};

/* ------------------------------- LibreTranslate ---------------------------- */

export const libreAdapter: ProviderAdapter = {
  id: 'libretranslate',
  async translate(args: TranslateArgs) {
    const endpoint = (args.config.baseUrl || providerPreset('libretranslate').baseUrl || '').replace(/\/+$/, '');
    const url = endpoint.endsWith('/translate') ? endpoint : `${endpoint}/translate`;
    const timeoutMs = requestTimeout(args.settings);
    const key = args.config.key.trim();
    const target = args.targetLang.split('-')[0];
    const source = args.sourceLang === 'auto' ? 'auto' : args.sourceLang.split('-')[0];

    return runMt({ ...args, segments: args.segments, timeoutMs }, async (text, signal) =>
      translatePreservingCode(text, async (input) => {
        const res = await httpRequest(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: { q: input, source, target, format: 'text', ...(key ? { api_key: key } : {}) },
          timeoutMs,
          signal,
          provider: 'libretranslate',
        });
        const data = await readJson<{ translatedText?: string; error?: string }>(res, 'libretranslate');
        if (!data.translatedText) {
          throw new TranslationError('bad_response', data.error ?? 'LibreTranslate returned no text', {
            provider: 'libretranslate',
          });
        }
        return data.translatedText;
      }),
    );
  },
  async probe(_config, signal) {
    const res = await httpRequest('https://translate.terraprint.co/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { q: 'Hello, world!', source: 'en', target: 'ru', format: 'text' },
      timeoutMs: 15_000,
      signal,
      provider: 'libretranslate',
    });
    const data = await readJson<{ translatedText?: string }>(res, 'libretranslate');
    return { model: 'libretranslate', sample: data.translatedText ?? '' };
  },
};

/* ---------------------------------- Lingva --------------------------------- */

export const lingvaAdapter: ProviderAdapter = {
  id: 'lingva',
  async translate(args: TranslateArgs) {
    const base = (args.config.baseUrl || providerPreset('lingva').baseUrl || 'https://lingva.ml').replace(/\/+$/, '');
    const timeoutMs = requestTimeout(args.settings);
    const target = args.targetLang.split('-')[0];
    const source = args.sourceLang === 'auto' ? 'auto' : args.sourceLang.split('-')[0];

    return runMt({ ...args, segments: args.segments, timeoutMs }, async (text, signal) =>
      translatePreservingCode(text, async (input) => {
        const url = `${base}/api/v1/${encodeURIComponent(source)}/${encodeURIComponent(target)}/${encodeURIComponent(input)}`;
        const res = await httpRequest(url, { timeoutMs, signal, provider: 'lingva' });
        const data = await readJson<{ translation?: string; error?: string }>(res, 'lingva');
        if (!data.translation) {
          throw new TranslationError('bad_response', data.error ?? 'Lingva returned no text', { provider: 'lingva' });
        }
        return data.translation;
      }),
    );
  },
  async probe(_config, signal) {
    const res = await httpRequest('https://lingva.ml/api/v1/en/ru/Hello%20world', {
      timeoutMs: 15_000,
      signal,
      provider: 'lingva',
    });
    const data = await readJson<{ translation?: string }>(res, 'lingva');
    return { model: 'lingva', sample: data.translation ?? '' };
  },
};

/* -------------------------------- DeepL Free ------------------------------- */

export const deeplAdapter: ProviderAdapter = {
  id: 'deepl-free',
  async translate(args: TranslateArgs) {
    const key = ensureKey(args.config, 'DeepL');
    const host = key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
    const timeoutMs = requestTimeout(args.settings);
    const target = (args.targetLang.split('-')[0] || 'en').toUpperCase();
    const source = args.sourceLang === 'auto' ? undefined : args.sourceLang.split('-')[0].toUpperCase();

    return runMt({ ...args, segments: args.segments, timeoutMs }, async (text, signal) =>
      translatePreservingCode(text, async (input) => {
        const res = await httpRequest(`${host}/v2/translate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `DeepL-Auth-Key ${key}` },
          body: { text: [input], target_lang: target, ...(source ? { source_lang: source } : {}) },
          timeoutMs,
          signal,
          provider: 'deepl-free',
        });
        const data = await readJson<{ translations?: { text: string; detected_source_language?: string }[] }>(
          res,
          'deepl-free',
        );
        const translated = data.translations?.[0]?.text ?? '';
        if (!translated) {
          throw new TranslationError('bad_response', 'DeepL returned no text', { provider: 'deepl-free' });
        }
        return translated;
      }), 2);
  },
  async probe(config, signal) {
    const key = ensureKey(config, 'DeepL');
    const host = key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com';
    const res = await httpRequest(`${host}/v2/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `DeepL-Auth-Key ${key}` },
      body: { text: ['Hello, world!'], target_lang: 'RU' },
      timeoutMs: 15_000,
      signal,
      provider: 'deepl-free',
    });
    const data = await readJson<{ translations?: { text: string }[] }>(res, 'deepl-free');
    return { model: 'deepl-free', sample: data.translations?.[0]?.text ?? '' };
  },
};
