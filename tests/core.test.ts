import { describe, it, expect } from './helpers/framework';
import { DEFAULT_SETTINGS, normalizeSettings, isHostAutoTranslated, isHostExcluded, providerSettings } from '../src/shared/settings';
import { buildCacheKey, glossaryFingerprint, hashString } from '../src/core/providers/types';
import { chunk, chunkByBudget, mapPool } from '../src/core/pool';
import { detectLanguageHeuristic } from '../src/core/lang-detect';
import { languageName, mtLanguageName, isSupportedLang, promptLangName } from '../src/shared/languages';
import { PROVIDERS, providerPreset } from '../src/shared/providers';
import { TranslationError } from '../src/shared/types';

describe('settings', () => {
  it('fills defaults from an empty object', () => {
    const settings = normalizeSettings({});
    expect(settings.targetLang).toBe('ru');
    expect(settings.sourceLang).toBe('auto');
    expect(settings.provider).toBe('deepseek');
    expect(settings.displayMode).toBe('replace');
  });

  it('rejects garbage instead of crashing', () => {
    expect(normalizeSettings(null).targetLang).toBe('ru');
    expect(normalizeSettings('nope').targetLang).toBe('ru');
    expect(normalizeSettings(42).targetLang).toBe('ru');
  });

  it('never allows "auto" as the target language', () => {
    expect(normalizeSettings({ targetLang: 'auto' }).targetLang).toBe('ru');
  });

  it('clamps numeric fields into their valid range', () => {
    const settings = normalizeSettings({ chunkSize: 5000, concurrency: -3, requestTimeoutSec: 1, cacheTtlDays: 9999 });
    expect(settings.chunkSize).toBe(80);
    expect(settings.concurrency).toBe(1);
    expect(settings.requestTimeoutSec).toBe(10);
    expect(settings.cacheTtlDays).toBe(365);
  });

  it('drops malformed glossary rows', () => {
    const settings = normalizeSettings({
      glossary: [
        { source: 'ok', target: 'хорошо' },
        { source: '', target: 'empty' },
        { nonsense: true },
        { source: '  ', target: '  ' },
      ],
    });
    expect(settings.glossary).toHaveLength(1);
    expect(settings.glossary[0].source).toBe('ok');
  });

  it('normalises host lists', () => {
    const settings = normalizeSettings({ autoTranslateHosts: [' Example.COM ', '', 'docs.test'] });
    expect(settings.autoTranslateHosts).toEqual(['example.com', 'docs.test']);
  });

  it('matches hosts and their subdomains', () => {
    const settings = normalizeSettings({ autoTranslateHosts: ['example.com'], excludedHosts: ['bank.test'] });
    expect(isHostAutoTranslated('example.com', settings)).toBe(true);
    expect(isHostAutoTranslated('docs.example.com', settings)).toBe(true);
    expect(isHostAutoTranslated('notexample.com', settings)).toBe(false);
    expect(isHostExcluded('secure.bank.test', settings)).toBe(true);
  });

  it('fills provider settings from the catalogue preset', () => {
    const settings = normalizeSettings({});
    const deepseek = providerSettings(settings, 'deepseek', providerPreset('deepseek'));
    expect(deepseek.model).toBe('deepseek-chat');
    expect(deepseek.baseUrl).toBe('https://api.deepseek.com');
    expect(deepseek.key).toBe('');
  });

  it('keeps stored provider values over preset defaults', () => {
    const settings = normalizeSettings({
      providers: { deepseek: { key: 'k', model: 'my-model', baseUrl: 'https://proxy.test' } },
    });
    const config = providerSettings(settings, 'deepseek', providerPreset('deepseek'));
    expect(config.model).toBe('my-model');
    expect(config.baseUrl).toBe('https://proxy.test');
    expect(config.key).toBe('k');
  });
});

describe('provider catalogue', () => {
  it('exposes every provider expected by the UI', () => {
    const ids = PROVIDERS.map((provider) => provider.id);
    for (const id of ['deepseek', 'openai', 'openrouter', 'groq', 'anthropic', 'gemini', 'ollama', 'google-free', 'mymemory', 'libretranslate', 'lingva', 'deepl-free']) {
      expect(ids).toContain(id);
    }
  });

  it('marks free services as key-less except DeepL', () => {
    expect(providerPreset('google-free').needsKey).toBe(false);
    expect(providerPreset('mymemory').needsKey).toBe(false);
    expect(providerPreset('deepl-free').needsKey).toBe(true);
    expect(providerPreset('deepseek').needsKey).toBe(true);
  });
});

describe('cache keys', () => {
  const base = {
    provider: 'deepseek',
    model: 'deepseek-chat',
    sourceLang: 'en',
    targetLang: 'ru',
    text: 'Hello',
    glossaryHash: 'abc',
  };

  it('is stable for identical input', () => {
    expect(buildCacheKey(base)).toBe(buildCacheKey({ ...base }));
  });

  it('changes with the model, languages, glossary or text', () => {
    const key = buildCacheKey(base);
    expect(buildCacheKey({ ...base, model: 'other' })).not.toBe(key);
    expect(buildCacheKey({ ...base, targetLang: 'de' })).not.toBe(key);
    expect(buildCacheKey({ ...base, glossaryHash: 'xyz' })).not.toBe(key);
    expect(buildCacheKey({ ...base, text: 'Hello!' })).not.toBe(key);
  });

  it('is invalidated by a skill version bump', () => {
    expect(buildCacheKey(base).startsWith('v')).toBe(true);
  });

  it('fingerprints glossary changes and ignores unrelated hosts', () => {
    const settings = normalizeSettings({
      glossary: [{ source: 'signal', target: 'сигнал', site: 'book.leptos.dev' }],
    });
    const onSite = glossaryFingerprint(settings, 'book.leptos.dev');
    const other = glossaryFingerprint(settings, 'other.dev');
    expect(onSite).not.toBe(other);
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashString('abc')).not.toBe(hashString('abd'));
  });
});

describe('pool', () => {
  it('chunks into fixed-size groups', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
  });

  it('respects both the item and character budget', () => {
    const items = [
      { id: 1, text: 'aaaa' },
      { id: 2, text: 'bbbb' },
      { id: 3, text: 'cccc' },
    ];
    const groups = chunkByBudget(items, 2, 10_000);
    expect(groups.length).toBe(2);
    expect(groups[0].length).toBe(2);
    const tight = chunkByBudget(items, 10, 30);
    expect(tight.length).toBeGreaterThan(1);
  });

  it('maps within the concurrency limit and reports progress', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const progress: number[] = [];
    const result = await mapPool(
      [1, 2, 3, 4, 5],
      async (value) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return value * 2;
      },
      { limit: 2, onProgress: (done) => progress.push(done) },
    );
    expect(result).toEqual([2, 4, 6, 8, 10]);
    expect(maxInFlight).toBe(2);
    expect(progress[progress.length - 1]).toBe(5);
  });

  it('stops on abort', async () => {
    const controller = new AbortController();
    controller.abort();
    let error: unknown = null;
    try {
      await mapPool([1, 2], async (v) => v, { limit: 1, signal: controller.signal });
    } catch (err) {
      error = err;
    }
    expect(error instanceof TranslationError).toBe(true);
  });
});

describe('language detection', () => {
  it('detects Russian by Cyrillic script', () => {
    const result = detectLanguageHeuristic('Это пример текста на русском языке, который нужно перевести.');
    expect(result.lang).toBe('ru');
  });

  it('detects Ukrainian by its distinctive letters', () => {
    const result = detectLanguageHeuristic('Це приклад тексту українською мовою, який треба перекласти.');
    expect(result.lang).toBe('uk');
  });

  it('detects English by stop words', () => {
    const result = detectLanguageHeuristic('This is an example of a text that is written in English and will be translated.');
    expect(result.lang).toBe('en');
  });

  it('detects German', () => {
    const result = detectLanguageHeuristic('Das ist ein Beispiel für einen Text, der auf Deutsch geschrieben ist und übersetzt wird.');
    expect(result.lang).toBe('de');
  });

  it('detects Japanese by kana', () => {
    const result = detectLanguageHeuristic('これは日本語のテキストの例です。翻訳する必要があります。');
    expect(result.lang).toBe('ja');
  });

  it('detects Chinese by Han-only text', () => {
    const result = detectLanguageHeuristic('这是一个中文文本的例子，需要翻译成其他语言。');
    expect(result.lang).toBe('zh');
  });

  it('falls back to English for empty input', () => {
    expect(detectLanguageHeuristic('').lang).toBe('en');
  });
});

describe('language helpers', () => {
  it('maps codes to human names', () => {
    expect(languageName('ru', 'ru')).toBe('русский');
    expect(languageName('de', 'en')).toBe('German');
    expect(mtLanguageName('de')).toBe('German');
    expect(mtLanguageName('auto')).toBe('auto');
  });

  it('validates supported codes and handles region tags', () => {
    expect(isSupportedLang('ru')).toBe(true);
    expect(isSupportedLang('auto')).toBe(true);
    expect(isSupportedLang('xx')).toBe(false);
    expect(languageName('pt-BR')?.length).toBeGreaterThan(0);
  });

  it('describes the target language for the prompt', () => {
    expect(promptLangName('ru')).toBe('Russian (русский)');
    expect(promptLangName('auto')).toBe('the source language');
  });
});
