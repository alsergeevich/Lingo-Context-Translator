/** HTTP helpers shared by all provider adapters: timeouts, error mapping, JSON reads. */
import { TranslationError, type ProviderId } from '../../shared/types';

export interface HttpOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
  provider?: ProviderId;
}

export interface HttpResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  text: string;
}

function linkAbort(outer: AbortSignal | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  outer?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    aborted: () => controller.signal.aborted && !timedOut,
    cleanup: () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onAbort);
    },
  };
}

export function statusToError(status: number, body: string, provider?: ProviderId): TranslationError {
  const snippet = body.slice(0, 400);
  const detail = `${status}: ${snippet}`;
  if (status === 401 || status === 403) {
    return new TranslationError('auth_failed', detail, { retryable: false, provider });
  }
  if (status === 402) return new TranslationError('quota_exceeded', detail, { retryable: false, provider });
  if (status === 429) return new TranslationError('rate_limited', detail, { retryable: true, provider });
  if (status === 404) return new TranslationError('bad_response', `Endpoint not found (${detail})`, { provider });
  if (status === 400 || status === 422) return new TranslationError('bad_response', detail, { provider });
  if (status >= 500) return new TranslationError('network', `Server error ${detail}`, { retryable: true, provider });
  return new TranslationError('unknown', `HTTP ${detail}`, { provider });
}

export async function httpRequest(url: string, opts: HttpOptions = {}): Promise<HttpResponse> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const link = linkAbort(opts.signal, timeoutMs);
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let body: string | undefined;
  if (opts.body !== undefined) {
    if (typeof opts.body === 'string') {
      body = opts.body;
    } else {
      body = JSON.stringify(opts.body);
      headers['Content-Type'] ??= 'application/json';
    }
  }

  try {
    const res = await fetch(url, {
      method: opts.method ?? (body ? 'POST' : 'GET'),
      headers,
      body,
      signal: link.signal,
      redirect: 'follow',
      credentials: 'omit',
      cache: 'no-store',
    });
    const text = await res.text();
    return { status: res.status, ok: res.ok, headers: res.headers, text };
  } catch (err) {
    if (link.timedOut()) {
      throw new TranslationError('timeout', `Request to ${hostOf(url)} timed out after ${timeoutMs} ms`, {
        retryable: true,
        provider: opts.provider,
      });
    }
    if (link.aborted() || (err instanceof DOMException && err.name === 'AbortError')) {
      throw new TranslationError('aborted', 'Request aborted', { provider: opts.provider });
    }
    const message = err instanceof Error ? err.message : String(err);
    const cause = (err as { cause?: { code?: string; message?: string } } | undefined)?.cause;
    const causeText = cause ? `${cause.code ?? ''} ${cause.message ?? ''}` : '';
    const combined = `${message} ${causeText}`;
    if (/Failed to fetch|NetworkError|load failed|fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|UND_ERR/i.test(combined)) {
      throw new TranslationError(
        'network',
        `Cannot reach ${hostOf(url)}. Check your connection, the CORS policy or VPN.`,
        { retryable: true, provider: opts.provider },
      );
    }
    throw new TranslationError('unknown', message, { provider: opts.provider });
  } finally {
    link.cleanup();
  }
}

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export async function readJson<T>(res: HttpResponse, provider?: ProviderId): Promise<T> {
  if (!res.ok) throw statusToError(res.status, res.text, provider);
  try {
    return JSON.parse(res.text) as T;
  } catch {
    throw new TranslationError('bad_response', `Expected JSON, got: ${res.text.slice(0, 200)}`, { provider });
  }
}

/** Exponential backoff with jitter; used for retryable provider failures. */
export async function backoff(attempt: number, signal?: AbortSignal): Promise<void> {
  const base = Math.min(8000, 500 * 2 ** attempt);
  const jitter = Math.random() * 250;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, base + jitter);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new TranslationError('aborted', 'Request aborted'));
      },
      { once: true },
    );
  });
}
