/** Google Gemini (AI Studio) adapter. */
import type { ProviderConfig } from '../../shared/types';
import { TranslationError } from '../../shared/types';
import { providerPreset } from '../../shared/providers';
import { httpRequest, readJson, statusToError } from './http';
import type { ChatClient, ChatMessage } from './llm';
import { runLlmTranslation } from './llm';
import type { ProviderAdapter, TranslateArgs } from './types';
import { ensureKey } from './types';

interface GeminiResponse {
  candidates?: {
    content?: { parts?: { text?: string }[] };
    finishReason?: string;
  }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { message?: string; status?: string };
}

export function geminiClient(config: ProviderConfig): ChatClient {
  const preset = providerPreset('gemini');
  const base = (config.baseUrl || preset.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(
    /\/+$/,
    '',
  );
  const model = config.model.replace(/^models\//, '');
  const url = `${base}/models/${encodeURIComponent(model)}:generateContent`;

  return {
    label: `${preset.label} · ${config.model}`,
    async request(messages: ChatMessage[], opts) {
      const system = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
      const contents = messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        }));

      const res = await httpRequest(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': config.key.trim(),
        },
        body: {
          systemInstruction: system ? { parts: [{ text: system }] } : undefined,
          contents,
          generationConfig: {
            temperature: 0.15,
            maxOutputTokens: opts.maxTokens ?? 4096,
          },
          safetySettings: [],
        },
        timeoutMs: opts.timeoutMs,
        signal: opts.signal,
        provider: 'gemini',
      });
      if (!res.ok) {
        let message = res.text;
        try {
          message = (JSON.parse(res.text) as GeminiResponse).error?.message ?? message;
        } catch {
          /* raw */
        }
        throw statusToError(res.status, message, 'gemini');
      }
      const data = await readJson<GeminiResponse>(res, 'gemini');
      const blocked = data.candidates?.[0]?.finishReason;
      const text = (data.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('');
      if (!text.trim()) {
        throw new TranslationError(
          'bad_response',
          blocked === 'SAFETY'
            ? 'Gemini blocked the response by its safety filter'
            : 'Gemini returned an empty message',
          { provider: 'gemini', retryable: blocked !== 'SAFETY' },
        );
      }
      return {
        text,
        usage: {
          input: data.usageMetadata?.promptTokenCount,
          output: data.usageMetadata?.candidatesTokenCount,
        },
      };
    },
  };
}

export const geminiAdapter: ProviderAdapter = {
  id: 'gemini',
  async translate(args: TranslateArgs) {
    ensureKey(args.config, 'Google Gemini');
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
      client: geminiClient(args.config),
    });
  },
  async probe(config, signal) {
    ensureKey(config, 'Google Gemini');
    const client = geminiClient(config);
    const reply = await client.request(
      [{ role: 'user', content: 'Translate into Russian, answer with the translation only: Hello, world!' }],
      { signal, timeoutMs: 30_000, maxTokens: 64 },
    );
    return { model: config.model, sample: reply.text.trim().slice(0, 80) };
  },
};
