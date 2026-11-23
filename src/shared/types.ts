/** Core domain types shared by background, content script and UI. */

export type LangCode = string; // ISO-639-1 subset, or 'auto'

export type ProviderKind = 'llm' | 'mt';

export type ProviderId =
  | 'deepseek'
  | 'openai'
  | 'openrouter'
  | 'groq'
  | 'anthropic'
  | 'gemini'
  | 'ollama'
  | 'openai-compatible'
  | 'google-free'
  | 'mymemory'
  | 'libretranslate'
  | 'lingva'
  | 'deepl-free';

/** A segment of page text that will be translated. */
export interface Segment {
  /** Stable id inside one translation job. */
  id: number;
  /** Text to translate (already trimmed, HTML-free). */
  text: string;
  /** Surrounding context (heading of the section, tag name) — used by the model. */
  context?: string;
  /** True when the segment looks like it contains inline code / identifiers. */
  hasMarkup?: boolean;
}

export interface GlossaryEntry {
  source: string;
  target: string;
  /** Empty = applies to every site. */
  site?: string;
  caseSensitive?: boolean;
}

export interface TranslationRequest {
  segments: Segment[];
  sourceLang: LangCode;
  targetLang: LangCode;
  /** Page title, used to infer the domain of the document. */
  pageTitle?: string;
  /** Hostname, used for glossary scoping and context. */
  pageHost?: string;
  /** Optional short summary of the page topic typed by the user. */
  topicHint?: string;
}

export interface TranslationResult {
  /** Same length as the request's segments. */
  texts: string[];
  detectedSourceLang?: string;
  provider: ProviderId;
  model?: string;
  /** Tokens reported by the provider, when available. */
  usage?: { input?: number; output?: number };
  /** True when the provider degraded (e.g. a free endpoint truncated the text). */
  partial?: boolean;
  /** Segment ids that could not be translated; their text is repeated unchanged. */
  failedIds?: number[];
}

export interface ProviderRequestOptions {
  signal?: AbortSignal;
  /** Called with 0..1 to report chunk-level progress. */
  onProgress?: (fraction: number) => void;
}

/** Everything a provider adapter needs to know. */
export interface ProviderConfig {
  id: ProviderId;
  key: string;
  model: string;
  baseUrl?: string;
  /** Free services ignore the key. */
  temperature?: number;
  maxOutputTokens?: number;
}

export type ErrorCode =
  | 'no_api_key'
  | 'no_host_permission'
  | 'rate_limited'
  | 'quota_exceeded'
  | 'auth_failed'
  | 'network'
  | 'timeout'
  | 'bad_response'
  | 'aborted'
  | 'unsupported_language'
  | 'unknown';

export class TranslationError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly provider?: ProviderId;

  constructor(code: ErrorCode, message: string, opts: { retryable?: boolean; provider?: ProviderId } = {}) {
    super(message);
    this.name = 'TranslationError';
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.provider = opts.provider;
  }
}

export function isTranslationError(e: unknown): e is TranslationError {
  return e instanceof TranslationError;
}
