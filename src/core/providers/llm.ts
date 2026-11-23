/**
 * Shared LLM translation pipeline.
 *
 * All chat-based providers (OpenAI-compatible, Anthropic, Gemini) differ only in how a
 * chat completion is transported. Everything else — the skill prompt, the answer format,
 * validation, repair retries and partial-failure recovery — lives here, so the behaviour
 * of a "model translation" is identical everywhere.
 */
import type { ProviderConfig, Segment, TranslationResult } from '../../shared/types';
import { TranslationError } from '../../shared/types';
import type { Settings } from '../../shared/settings';
import {
  buildRepairPrompt,
  buildSystemPrompt,
  buildUserPrompt,
  detectDomain,
  type Domain,
} from '../skill/translation-skill';
import { checkIntegrity, checkSlots, parseAnswer, trimToBlocks } from '../skill/validate';
import { fewShotBlock, fewShotFor } from '../skill/examples';
import { backoff, hostOf } from './http';
import { requestTimeout } from './types';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatClient {
  label: string;
  request(messages: ChatMessage[], opts: { signal?: AbortSignal; timeoutMs: number; maxTokens?: number }): Promise<{
    text: string;
    usage?: { input?: number; output?: number };
  }>;
}

export interface LlmTranslateArgs {
  segments: Segment[];
  sourceLang: string;
  targetLang: string;
  pageTitle?: string;
  pageHost?: string;
  topicHint?: string;
  settings: Settings;
  config: ProviderConfig;
  signal?: AbortSignal;
  client: ChatClient;
  /** Number of repair attempts after the first failed validation. */
  maxRepairs?: number;
}

const MAX_REPAIRS = 2;

export async function runLlmTranslation(args: LlmTranslateArgs): Promise<TranslationResult> {
  const { client, config, settings } = args;
  if (args.segments.length === 0) {
    return { texts: [], provider: config.id, model: config.model };
  }

  const sample = args.segments
    .slice(0, 40)
    .map((s) => s.text)
    .join(' ')
    .slice(0, 4000);
  const domain: Domain = detectDomain(args.pageTitle, args.pageHost, sample);

  const system = buildSystemPrompt(settings, {
    pageTitle: args.pageTitle,
    pageHost: args.pageHost,
    domain,
    topicHint: args.topicHint,
  });

  const userPromptParts = [
    buildUserPrompt({
      segments: args.segments,
      sourceLang: args.sourceLang,
      targetLang: args.targetLang,
      pageTitle: args.pageTitle,
      pageHost: args.pageHost,
      topicHint: args.topicHint,
      domain,
    }),
  ];

  // Few-shot examples help small models keep the block format; big prompts already work without them.
  const fewShot = fewShotFor({ targetLang: args.targetLang });
  if (fewShot && args.segments.length <= 12) {
    userPromptParts.push('', fewShotBlock(fewShot));
  }

  const expectedIds = args.segments.map((s) => s.id);
  let messages: ChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: userPromptParts.join('\n') },
  ];

  const usage = { input: 0, output: 0 };
  const collected = new Map<number, string>();
  const maxRepairs = args.maxRepairs ?? MAX_REPAIRS;
  let lastProblem = '';

  for (let attempt = 0; attempt <= maxRepairs; attempt++) {
    const reply = await withRetry(
      () =>
        client.request(messages, {
          signal: args.signal,
          timeoutMs: requestTimeout(settings),
          maxTokens: settings.chunkSize > 20 ? 8192 : 4096,
        }),
      args.signal,
      config.id,
    );

    usage.input += reply.usage?.input ?? 0;
    usage.output += reply.usage?.output ?? 0;

    const parsed = parseAnswer(trimToBlocks(reply.text), expectedIds);
    for (const [id, text] of parsed.byId) {
      if (!collected.has(id)) collected.set(id, text);
    }

    const remaining = args.segments.filter((s) => !collected.has(s.id));
    if (remaining.length === 0) {
      const byId = new Map(args.segments.map((s) => [s.id, collected.get(s.id) ?? '']));
      const integrity = checkIntegrity(args.segments, {
        ...parsed,
        byId,
        missing: [],
        unexpected: [],
        duplicated: [],
        empty: false,
      });

      // A segment whose inline slots were dropped or unbalanced cannot be applied: the page
      // would lose its links. Fall back to the original text for those segments only.
      const safeIds = new Set<number>();
      for (const segment of args.segments) {
        const problems = checkSlots(segment.text, byId.get(segment.id) ?? '');
        if (problems.length === 0) safeIds.add(segment.id);
      }
      const unsafeIds = args.segments.filter((s) => !safeIds.has(s.id)).map((s) => s.id);

      return {
        texts: args.segments.map((s) => (safeIds.has(s.id) ? byId.get(s.id) ?? s.text : s.text)),
        provider: config.id,
        model: config.model,
        usage,
        partial: !integrity.ok,
        failedIds: integrity.ok ? undefined : unsafeIds.length > 0 ? unsafeIds : args.segments.map((s) => s.id),
      };
    }

    lastProblem = `missing ${remaining.length} of ${args.segments.length} segments (ids ${remaining
      .slice(0, 8)
      .map((s) => s.id)
      .join(', ')}${remaining.length > 8 ? ', …' : ''})`;

    messages = [
      { role: 'system', content: system },
      {
        role: 'user',
        content: buildUserPrompt({
          segments: remaining,
          sourceLang: args.sourceLang,
          targetLang: args.targetLang,
          pageTitle: args.pageTitle,
          pageHost: args.pageHost,
          topicHint: args.topicHint,
          domain,
        }),
      },
      { role: 'assistant', content: reply.text.slice(0, 4000) },
      { role: 'user', content: buildRepairPrompt(lastProblem, remaining.map((s) => s.id)) },
    ];
  }

  // Unrecoverable: translate what we have, keep the original for the rest.
  const failedIds = args.segments.filter((s) => !collected.has(s.id)).map((s) => s.id);
  return {
    texts: args.segments.map((s) => collected.get(s.id) ?? s.text),
    provider: config.id,
    model: config.model,
    usage,
    partial: failedIds.length > 0,
    failedIds,
    detectedSourceLang: undefined,
  };
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  signal: AbortSignal | undefined,
  provider: ProviderConfig['id'],
  attempts = 3,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const retryable = err instanceof TranslationError ? err.retryable : false;
      if (!retryable || attempt === attempts - 1) break;
      await backoff(attempt, signal);
    }
  }
  if (lastError instanceof TranslationError) throw lastError;
  if (lastError instanceof Error) {
    throw new TranslationError('unknown', `${provider}: ${lastError.message}`, { provider });
  }
  throw new TranslationError('unknown', `${provider}: unknown failure`, { provider });
}

/** Default probe: translate a single tiny string and report what came back. */
export async function probeWithClient(
  client: ChatClient,
  signal: AbortSignal | undefined,
  timeoutMs = 30_000,
): Promise<{ model: string; sample: string }> {
  const reply = await client.request(
    [
      { role: 'system', content: 'You translate. Reply with the translation only, no explanations.' },
      { role: 'user', content: 'Translate into Russian: Hello, world!' },
    ],
    { signal, timeoutMs, maxTokens: 64 },
  );
  return { model: '', sample: reply.text.trim().slice(0, 80) };
}

export function describeUrl(url: string): string {
  return hostOf(url);
}
