/**
 * Typed messaging between the UI, the content script and the service worker.
 *
 * All cross-context traffic goes through these message shapes so that a single
 * router in the service worker owns validation and error mapping.
 */
import type { LangCode, ProviderId, Segment, TranslationResult } from './types';

export type RuntimeRequest =
  | { type: 'PING' }
  | { type: 'GET_SETTINGS' }
  | { type: 'SET_SETTINGS'; patch: Record<string, unknown> }
  | { type: 'TRANSLATE'; payload: TranslatePayload }
  | { type: 'DETECT_LANGUAGE'; text: string }
  | { type: 'TEST_PROVIDER'; provider: ProviderId; overrides?: { key?: string; model?: string; baseUrl?: string } }
  | { type: 'CACHE_STATS' }
  | { type: 'CACHE_CLEAR' }
  | { type: 'REQUEST_HOST_PERMISSION'; origin: string }
  | { type: 'OPEN_OPTIONS' }
  | { type: 'OPEN_PRINT'; payload: unknown }
  | { type: 'REPORT_STATE'; state: PageState };

export interface TranslatePayload {
  segments: Segment[];
  sourceLang: LangCode;
  targetLang: LangCode;
  pageTitle?: string;
  pageHost?: string;
  providerOverride?: ProviderId;
  /** Bypass the response cache (used by the "re-translate" action). */
  force?: boolean;
}

export interface TranslateResponse extends TranslationResult {
  cached: boolean;
  /** Set when the provider could only translate part of the batch. */
  failedCount?: number;
}

export type RuntimeResponse<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string; retryable?: boolean } };

/** Messages the service worker sends to a tab's content script. */
export type ContentCommand =
  | { type: 'TRANSLATE_PAGE'; sourceLang?: LangCode; targetLang?: LangCode }
  | { type: 'TOGGLE_ORIGINAL' }
  | { type: 'SAVE_PDF' }
  | { type: 'TRANSLATE_SELECTION' }
  | { type: 'STOP' }
  | { type: 'GET_STATE' };

export interface PageState {
  supported: boolean;
  phase: 'idle' | 'extracting' | 'translating' | 'done' | 'error' | 'stopped';
  total: number;
  done: number;
  failed: number;
  showingOriginal: boolean;
  sourceLang?: string;
  targetLang?: string;
  provider?: string;
  error?: string;
  /** Segmentation warnings: e.g. page still loading. */
  notice?: string;
}

/**
 * Chrome reports a missing receiver and a dead extension context with plain strings, and the
 * popup needs to tell them apart: the first is fixed by injecting the content script, the
 * second only by reloading the page.
 */
export function classifySendError(message: string): string {
  if (/Receiving end does not exist|Could not establish connection/i.test(message)) return 'no_receiver';
  if (/Extension context invalidated|message port closed/i.test(message)) return 'context_invalidated';
  return 'unknown';
}

export async function sendToBackground<T = unknown>(msg: RuntimeRequest): Promise<RuntimeResponse<T>> {
  try {
    return (await chrome.runtime.sendMessage(msg)) as RuntimeResponse<T>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: { code: classifySendError(message), message } };
  }
}

export async function sendToTab<T = unknown>(tabId: number, msg: ContentCommand): Promise<RuntimeResponse<T>> {
  try {
    return (await chrome.tabs.sendMessage(tabId, msg)) as RuntimeResponse<T>;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: { code: classifySendError(message), message } };
  }
}
