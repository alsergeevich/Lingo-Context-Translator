/** Translate the user's text selection in place, in a small floating bubble. */
import type { PageState, RuntimeResponse, TranslateResponse } from '../shared/messaging';
import { sendToBackground } from '../shared/messaging';
import type { Settings } from '../shared/settings';
import { t } from '../shared/i18n';
import type { Segment } from '../shared/types';

const BUBBLE_ID = 'lingo-selection-bubble';
const STYLE_ID = 'lingo-selection-styles';

function ensureStyles(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .lingo-bubble {
      position: absolute; z-index: 2147483645; max-width: 460px; min-width: 220px;
      background: #171a26; color: #e8eaf6; border: 1px solid rgba(255,255,255,.1);
      border-radius: 12px; box-shadow: 0 10px 34px rgba(0,0,0,.45);
      font: 13px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
      padding: 10px 12px;
    }
    .lingo-bubble .lb-head { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
    .lingo-bubble .lb-title { font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #8f97b2; flex: 1; }
    .lingo-bubble button {
      border: 0; background: rgba(255,255,255,.08); color: #dfe3f0; border-radius: 6px;
      cursor: pointer; font: inherit; font-size: 11px; padding: 3px 7px;
    }
    .lingo-bubble button:hover { background: rgba(255,255,255,.16); }
    .lingo-bubble .lb-body { max-height: 260px; overflow: auto; white-space: pre-wrap; }
    .lingo-bubble .lb-status { color: #8f97b2; font-size: 11.5px; margin-top: 5px; }
    .lingo-bubble .lb-status.err { color: #ff9b9b; }
  `;
  (document.head ?? document.documentElement).appendChild(style);
}

function positionNear(host: HTMLElement, rect: DOMRect): void {
  const maxLeft = Math.max(8, window.innerWidth - 480);
  host.style.top = `${window.scrollY + rect.bottom + 8}px`;
  host.style.left = `${Math.min(window.scrollX + rect.left, window.scrollX + maxLeft)}px`;
}

export async function translateSelection(
  settings: Settings,
  onState: (patch: Partial<PageState>) => void,
): Promise<void> {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) {
    onState({ phase: 'done', notice: t(settings.uiLang, 'popup.noSelection') });
    return;
  }
  const range = selection.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  const text = selection.toString().trim();
  if (!text) return;

  ensureStyles();
  document.getElementById(BUBBLE_ID)?.remove();

  const host = document.createElement('div');
  host.id = BUBBLE_ID;
  host.className = 'lingo-bubble';
  host.setAttribute('data-lingo-ignore', '1');
  host.innerHTML = `
    <div class="lb-head">
      <span class="lb-title"></span>
      <button class="lb-copy" title="Copy">⧉</button>
      <button class="lb-close" title="Close">×</button>
    </div>
    <div class="lb-body"></div>
    <div class="lb-status"></div>
  `;
  (document.body ?? document.documentElement).appendChild(host);
  positionNear(host, rect);

  const body = host.querySelector('.lb-body') as HTMLElement;
  const status = host.querySelector('.lb-status') as HTMLElement;
  const title = host.querySelector('.lb-title') as HTMLElement;
  const copy = host.querySelector('.lb-copy') as HTMLButtonElement;
  const close = host.querySelector('.lb-close') as HTMLButtonElement;

  title.textContent = `${settings.sourceLang} → ${settings.targetLang}`;
  close.addEventListener('click', () => host.remove());
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(body.textContent ?? '');
      copy.textContent = '✓';
    } catch {
      /* clipboard can be blocked by policy */
    }
  });

  status.textContent = '…';

  const segments: Segment[] = [{ id: 1, text, context: document.title }];

  const response: RuntimeResponse<TranslateResponse> = await sendToBackground<TranslateResponse>({
    type: 'TRANSLATE',
    payload: {
      segments,
      sourceLang: settings.sourceLang,
      targetLang: settings.targetLang,
      pageTitle: document.title,
      pageHost: location.hostname,
    },
  });

  if (!response.ok) {
    status.textContent = response.error.message;
    status.className = 'lb-status err';
    return;
  }

  body.textContent = response.data.texts[0] ?? '';
  const meta = [response.data.model || response.data.provider, response.data.cached ? 'cached' : '']
    .filter(Boolean)
    .join(' · ');
  status.textContent = meta;
  status.className = response.data.failedCount ? 'lb-status err' : 'lb-status';
}
