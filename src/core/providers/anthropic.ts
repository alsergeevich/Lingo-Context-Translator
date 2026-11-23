/** Anthropic Messages API adapter. */
import type { ProviderConfig } from '../../shared/types';
import { TranslationError } from '../../shared/types';
import { providerPreset } from '../../shared/providers';
import { httpRequest, readJson, statusToError } from './http';
import type { ChatClient, ChatMessage } from './llm';
import { runLlmTranslation } from './llm';
import type { ProviderAdapter, TranslateArgs } from './types';
import { ensureKey } from './types';

const ANTHROPIC_VERSION = '2023-06-01';

interface MessagesResponse {
  content?: { type: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
  error?: { message?: string; type?: string };
}

export function anthropicClient(config: ProviderConfig): ChatClient {
  const preset = providerPreset('anthropic');
  const base = (config.baseUrl || preset.baseUrl || 'https://api.anthropic.com/v1').replace(/\/+$/, '');
  const url = `${base}/messages`;

  return {
    label: `${preset.label} · ${config.model}`,
    async request(messages: ChatMessage[], opts) {
      const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
      const rest = messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role, content: m.content }));

      const res = await httpRequest(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': config.key.trim(),
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: {
          model: config.model,
          system,
          messages: rest,
          max_tokens: opts.maxTokens ?? 4096,
          temperature: 0.1,
        },
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
        provider: 'anthropic',
      });
      if (!res.ok) {
        let message = res.text;
        try {
          message = (JSON.parse(res.text) as MessagesResponse).error?.message ?? message;
        } catch {
          /* keep raw */
        }
        throw statusToError(res.status, message, 'anthropic');
      }
      const data = await readJson<MessagesResponse>(res, 'anthropic');
      const text = (data.content ?? [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('');
      if (!text.trim()) {
        throw new TranslationError('bad_response', 'Anthropic returned an empty message', {
          provider: 'anthropic',
          retryable: true,
        });
      }
      return {
        text,
        usage: { input: data.usage?.input_tokens, output: data.usage?.output_tokens },
      };
    },
  };
}

export const anthropicAdapter: ProviderAdapter = {
  id: 'anthropic',
  async translate(args: TranslateArgs) {
    ensureKey(args.config, 'Anthropic');
    return runLlmTranslation({
      segments: args.segments,
      sourceLang: args.sourceLang,
      targetLang: args.targetLang,
      pageTitle: args.pageTitle,
      pageHost: args.pageHost,
      topicHint: args.topicHint,
      settings: args.settings,
      config: args.config,
      signal: args.signal,
      client: anthropicClient(args.config),
    });
  },
  async probe(config, signal) {
    ensureKey(config, 'Anthropic');
    const client = anthropicClient(config);
    const reply = await client.request(
      [{ role: 'user', content: 'Translate into Russian, answer with the translation only: Hello, world!' }],
      { signal, timeoutMs: 30_000, maxTokens: 64 },
    );
    return { model: config.model, sample: reply.text.trim().slice(0, 80) };
  },
};
