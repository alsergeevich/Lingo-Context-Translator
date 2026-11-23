/**
 * OpenAI-compatible chat adapter.
 *
 * Covers DeepSeek, OpenAI, OpenRouter, Groq, Ollama/LM Studio and any custom gateway:
 * the only differences are the base URL, the model id and a couple of optional headers.
 */
import type { ProviderConfig } from '../../shared/types';
import { TranslationError } from '../../shared/types';
import { providerPreset } from '../../shared/providers';
import { httpRequest, readJson, statusToError, hostOf } from './http';
import type { ChatClient, ChatMessage } from './llm';
import { runLlmTranslation, type LlmTranslateArgs } from './llm';
import type { ProviderAdapter, TranslateArgs } from './types';
import { ensureKey } from './types';

interface ChatCompletion {
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string; type?: string };
}

export function openAiClient(config: ProviderConfig, signalHint?: AbortSignal): ChatClient {
  const preset = providerPreset(config.id);
  const base = (config.baseUrl || preset.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new TranslationError('bad_response', 'Base URL is not configured', { provider: config.id });
  const url = `${base}/chat/completions`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const key = config.key.trim();
  if (key) headers.Authorization = `Bearer ${key}`;
  if (config.id === 'openrouter') {
    headers['HTTP-Referer'] = 'https://github.com/lingo-context';
    headers['X-Title'] = 'Lingo Context';
  }

  return {
    label: `${preset.label} · ${config.model}`,
    async request(messages: ChatMessage[], opts) {
      const body = {
        model: config.model,
        messages,
        temperature: preset.kind === 'llm' ? 0.2 : 0,
        stream: false,
        max_tokens: opts.maxTokens ?? 4096,
      };
      const res = await httpRequest(url, {
        method: 'POST',
        headers,
        body,
        timeoutMs: opts.timeoutMs,
        signal: opts.signal ?? signalHint,
        provider: config.id,
      });
      if (!res.ok) {
        let message = res.text;
        try {
          const parsed = JSON.parse(res.text) as ChatCompletion;
          message = parsed.error?.message ?? message;
        } catch {
          /* keep raw text */
        }
        throw statusToError(res.status, message, config.id);
      }
      const data = await readJson<ChatCompletion>(res, config.id);
      const text = data.choices?.[0]?.message?.content ?? '';
      if (!text.trim()) {
        throw new TranslationError('bad_response', `${hostOf(url)} returned an empty message`, {
          provider: config.id,
          retryable: true,
        });
      }
      return {
        text,
        usage: {
          input: data.usage?.prompt_tokens,
          output: data.usage?.completion_tokens,
        },
      };
    },
  };
}

export const openAiCompatibleAdapter: ProviderAdapter = {
  id: 'openai-compatible',
  async translate(args: TranslateArgs) {
    return runLlm(args);
  },
  async probe(config, signal) {
    const client = openAiClient(config, signal);
    const reply = await client.request(
      [
        { role: 'system', content: 'You translate. Reply with the translation only.' },
        { role: 'user', content: 'Translate into Russian: Hello, world!' },
      ],
      { signal, timeoutMs: 30_000, maxTokens: 64 },
    );
    return { model: config.model, sample: reply.text.trim().slice(0, 80) };
  },
};

export function makeOpenAiAdapter(id: ProviderConfig['id']): ProviderAdapter {
  return {
    id,
    async translate(args: TranslateArgs) {
      if (providerPreset(id).needsKey) ensureKey(args.config, providerPreset(id).label);
      return runLlm(args);
    },
    probe: openAiCompatibleAdapter.probe.bind(null),
  };
}

async function runLlm(args: TranslateArgs) {
  if (providerPreset(args.config.id).needsKey) {
    ensureKey(args.config, providerPreset(args.config.id).label);
  }
  const llmArgs: LlmTranslateArgs = {
    segments: args.segments,
    sourceLang: args.sourceLang,
    targetLang: args.targetLang,
    pageTitle: args.pageTitle,
    pageHost: args.pageHost,
    topicHint: args.topicHint,
    settings: args.settings,
    config: args.config,
    signal: args.signal,
    client: openAiClient(args.config, args.signal),
  };
  return runLlmTranslation(llmArgs);
}
