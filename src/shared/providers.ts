/**
 * Provider catalogue: presets, defaults and UI metadata.
 *
 * A single adapter (`openai-compatible`) covers every OpenAI-style chat endpoint
 * (DeepSeek, OpenAI, OpenRouter, Groq, Ollama, LM Studio, …) — presets only differ in
 * base URL, default model and auth quirks.
 */
import type { ProviderId } from './types';

export type ProviderAuth = 'bearer' | 'x-api-key' | 'query' | 'none';

export interface ProviderPreset {
  id: ProviderId;
  kind: 'llm' | 'mt';
  /** Human name shown in the UI. */
  label: string;
  /** One-line note for the settings page. */
  note: string;
  /** Requires the user to paste an API key. */
  needsKey: boolean;
  /** Where the user gets a key. */
  keyUrl?: string;
  defaultModel: string;
  /** Model presets shown as options in settings. */
  models?: string[];
  /** OpenAI-compatible endpoint, without the trailing /chat/completions. */
  baseUrl?: string;
  /** Chat API dialect. */
  dialect?: 'openai' | 'anthropic' | 'gemini' | 'none';
  auth?: ProviderAuth;
  /** Providers whose host needs an optional permission before the first call. */
  hosts?: string[];
  /** Machine translation services ignore models. */
  supportsAutoDetect?: boolean;
  /** Max characters accepted per request, when the service documents a limit. */
  maxChunkChars?: number;
}

export const PROVIDERS: ProviderPreset[] = [
  {
    id: 'deepseek',
    kind: 'llm',
    label: 'DeepSeek',
    note: 'Недорогая модель с сильным русским. Рекомендуется.',
    needsKey: true,
    keyUrl: 'https://platform.deepseek.com/api_keys',
    baseUrl: 'https://api.deepseek.com',
    dialect: 'openai',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    supportsAutoDetect: true,
    hosts: ['https://api.deepseek.com/*'],
  },
  {
    id: 'openai',
    kind: 'llm',
    label: 'OpenAI',
    note: 'GPT-модели, эталонное качество перевода.',
    needsKey: true,
    keyUrl: 'https://platform.openai.com/api-keys',
    baseUrl: 'https://api.openai.com/v1',
    dialect: 'openai',
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'o4-mini'],
    supportsAutoDetect: true,
    hosts: ['https://api.openai.com/*'],
  },
  {
    id: 'openrouter',
    kind: 'llm',
    label: 'OpenRouter',
    note: 'Один ключ — сотни моделей, включая бесплатные.',
    needsKey: true,
    keyUrl: 'https://openrouter.ai/keys',
    baseUrl: 'https://openrouter.ai/api/v1',
    dialect: 'openai',
    defaultModel: 'google/gemini-2.0-flash-001',
    models: [
      'google/gemini-2.0-flash-001',
      'anthropic/claude-3.5-haiku',
      'deepseek/deepseek-chat',
      'meta-llama/llama-3.3-70b-instruct',
      'qwen/qwen-2.5-72b-instruct',
    ],
    supportsAutoDetect: true,
    hosts: ['https://openrouter.ai/*'],
  },
  {
    id: 'groq',
    kind: 'llm',
    label: 'Groq',
    note: 'Очень быстрый инференс открытых моделей.',
    needsKey: true,
    keyUrl: 'https://console.groq.com/keys',
    baseUrl: 'https://api.groq.com/openai/v1',
    dialect: 'openai',
    defaultModel: 'llama-3.3-70b-versatile',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'gemma2-9b-it'],
    supportsAutoDetect: true,
    hosts: ['https://api.groq.com/*'],
  },
  {
    id: 'anthropic',
    kind: 'llm',
    label: 'Anthropic Claude',
    note: 'Аккуратный перевод, хорошо держит разметку.',
    needsKey: true,
    keyUrl: 'https://console.anthropic.com/settings/keys',
    baseUrl: 'https://api.anthropic.com/v1',
    dialect: 'anthropic',
    defaultModel: 'claude-3-5-haiku-latest',
    models: ['claude-3-5-haiku-latest', 'claude-3-5-sonnet-latest', 'claude-3-7-sonnet-latest'],
    supportsAutoDetect: true,
    hosts: ['https://api.anthropic.com/*'],
  },
  {
    id: 'gemini',
    kind: 'llm',
    label: 'Google Gemini',
    note: 'Есть бесплатный тариф в AI Studio.',
    needsKey: true,
    keyUrl: 'https://aistudio.google.com/apikey',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    dialect: 'gemini',
    defaultModel: 'gemini-2.0-flash',
    models: ['gemini-2.0-flash', 'gemini-2.0-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-pro'],
    supportsAutoDetect: true,
    hosts: ['https://generativelanguage.googleapis.com/*'],
  },
  {
    id: 'ollama',
    kind: 'llm',
    label: 'Ollama / LM Studio (локально)',
    note: 'Без ключа и без интернета: модель работает на вашем компьютере.',
    needsKey: false,
    baseUrl: 'http://localhost:11434/v1',
    dialect: 'openai',
    defaultModel: 'qwen2.5:7b',
    models: ['qwen2.5:7b', 'llama3.1:8b', 'gemma2:9b', 'aya-expanse:8b'],
    supportsAutoDetect: true,
    hosts: ['http://localhost/*', 'http://127.0.0.1/*'],
  },
  {
    id: 'openai-compatible',
    kind: 'llm',
    label: 'Свой OpenAI-совместимый API',
    note: 'Любой прокси или шлюз с эндпоинтом /chat/completions.',
    needsKey: true,
    baseUrl: 'https://example.com/v1',
    dialect: 'openai',
    defaultModel: 'gpt-4o-mini',
    supportsAutoDetect: true,
  },
  {
    id: 'google-free',
    kind: 'mt',
    label: 'Google Translate (без ключа)',
    note: 'Быстро и бесплатно. Неофициальный публичный эндпоинт — может ограничивать частоту.',
    needsKey: false,
    defaultModel: '',
    supportsAutoDetect: true,
    maxChunkChars: 4000,
    hosts: ['https://translate.googleapis.com/*'],
  },
  {
    id: 'mymemory',
    kind: 'mt',
    label: 'MyMemory',
    note: 'Бесплатно, есть дневной лимит слов без ключа.',
    needsKey: false,
    defaultModel: '',
    supportsAutoDetect: true,
    maxChunkChars: 500,
    hosts: ['https://api.mymemory.translated.net/*'],
  },
  {
    id: 'libretranslate',
    kind: 'mt',
    label: 'LibreTranslate',
    note: 'Открытый движок, публичные зеркала без ключа.',
    needsKey: false,
    defaultModel: '',
    baseUrl: 'https://translate.terraprint.co/translate',
    supportsAutoDetect: true,
    maxChunkChars: 4000,
    hosts: ['https://translate.terraprint.co/*', 'https://libretranslate.com/*', 'https://translate.plausibility.cloud/*'],
  },
  {
    id: 'lingva',
    kind: 'mt',
    label: 'Lingva Translate',
    note: 'Прокси-фронтенд Google Translate, без ключа.',
    needsKey: false,
    defaultModel: '',
    baseUrl: 'https://lingva.ml',
    supportsAutoDetect: true,
    maxChunkChars: 4000,
    hosts: ['https://lingva.ml/*'],
  },
  {
    id: 'deepl-free',
    kind: 'mt',
    label: 'DeepL Free',
    note: 'Лучший машинный перевод для европейских языков. Нужен ключ Free.',
    needsKey: true,
    keyUrl: 'https://www.deepl.com/pro-api',
    defaultModel: '',
    supportsAutoDetect: true,
    maxChunkChars: 4000,
    hosts: ['https://api-free.deepl.com/*'],
  },
];

export const PROVIDER_BY_ID = new Map(PROVIDERS.map((p) => [p.id, p]));

export function providerPreset(id: ProviderId): ProviderPreset {
  const preset = PROVIDER_BY_ID.get(id);
  if (!preset) throw new Error(`Unknown provider: ${id}`);
  return preset;
}

export function isLlmProvider(id: ProviderId): boolean {
  return providerPreset(id).kind === 'llm';
}

export const DEFAULT_PROVIDER: ProviderId = 'deepseek';
