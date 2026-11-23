/** Provider registry: maps a provider id to its adapter. */
import type { ProviderId } from '../../shared/types';
import type { ProviderAdapter } from './types';
import { makeOpenAiAdapter, openAiCompatibleAdapter } from './openai';
import { anthropicAdapter } from './anthropic';
import { geminiAdapter } from './gemini';
import { googleFreeAdapter, myMemoryAdapter, libreAdapter, lingvaAdapter, deeplAdapter } from './mt';

const openai = makeOpenAiAdapter('openai');
const deepseek = makeOpenAiAdapter('deepseek');
const openrouter = makeOpenAiAdapter('openrouter');
const groq = makeOpenAiAdapter('groq');
const ollama = makeOpenAiAdapter('ollama');

const ADAPTERS: Record<ProviderId, ProviderAdapter> = {
  deepseek,
  openai,
  openrouter,
  groq,
  anthropic: anthropicAdapter,
  gemini: geminiAdapter,
  ollama,
  'openai-compatible': openAiCompatibleAdapter,
  'google-free': googleFreeAdapter,
  mymemory: myMemoryAdapter,
  libretranslate: libreAdapter,
  lingva: lingvaAdapter,
  'deepl-free': deeplAdapter,
};

export function adapterFor(id: ProviderId): ProviderAdapter {
  const adapter = ADAPTERS[id];
  if (!adapter) throw new Error(`No adapter for provider: ${id}`);
  return adapter;
}

export { ADAPTERS };
