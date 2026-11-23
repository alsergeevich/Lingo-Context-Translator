/**
 * The in-page panel: progress, stop, "show original", PDF.
 * Rendered inside a closed shadow root so page CSS cannot break it and our CSS cannot
 * leak into the page.
 */
import type { PageState } from '../shared/messaging';
import { t, type UiLang } from '../shared/i18n';

export interface PanelHandlers {
  onStop: () => void;
  onToggleOriginal: () => void;
  onPdf: () => void;
  onRetry: () => void;
  onClose: () => void;
}

const PANEL_STYLES = `
:host { all: initial; }
.wrap {
  position: fixed; z-index: 2147483646; right: 18px; bottom: 18px;
  font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: #e8eaf6;
  background: linear-gradient(160deg, #1f2437, #171a26);
  border: 1px solid rgba(255,255,255,.09);
  border-radius: 14px; box-shadow: 0 12px 40px rgba(0,0,0,.45);
  width: 320px; overflow: hidden; user-select: none;
  animation: in .18s ease-out;
}
@keyframes in { from { opacity: 0; transform: translateY(8px); } }
.head { display: flex; align-items: center; gap: 8px; padding: 11px 12px 8px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: #6b7cff; box-shadow: 0 0 0 3px rgba(107,124,255,.18); flex: none; }
.dot.busy { animation: pulse 1.1s infinite; }
.dot.done { background: #35d07f; box-shadow: 0 0 0 3px rgba(53,208,127,.16); }
.dot.error { background: #ff6b6b; box-shadow: 0 0 0 3px rgba(255,107,107,.16); }
@keyframes pulse { 50% { opacity: .35; } }
.title { font-weight: 600; font-size: 13px; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.close { border: 0; background: transparent; color: #9aa3bd; cursor: pointer; font-size: 16px; line-height: 1; padding: 2px 4px; border-radius: 6px; }
.close:hover { color: #fff; background: rgba(255,255,255,.08); }
.body { padding: 0 12px 10px; }
.meta { color: #9aa3bd; font-size: 11.5px; margin-bottom: 8px; display: flex; gap: 6px; flex-wrap: wrap; }
.chip { background: rgba(255,255,255,.06); border-radius: 999px; padding: 1px 7px; }
.bar { height: 4px; border-radius: 3px; background: rgba(255,255,255,.09); overflow: hidden; }
.bar > i { display: block; height: 100%; width: 0%; background: linear-gradient(90deg, #6b7cff, #35d07f); transition: width .25s ease; }
.status { margin-top: 7px; font-size: 11.5px; color: #b9c0d4; min-height: 16px; }
.status.err { color: #ff9b9b; }
.actions { display: flex; gap: 6px; padding: 0 12px 12px; flex-wrap: wrap; }
button.act {
  flex: 1 1 auto; min-width: 74px; padding: 6px 10px; border-radius: 8px; cursor: pointer;
  border: 1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.05);
  color: #dfe3f0; font: inherit; font-size: 12px; transition: background .12s;
}
button.act:hover { background: rgba(255,255,255,.12); }
button.act.primary { background: rgba(107,124,255,.22); border-color: rgba(107,124,255,.5); }
button.act:disabled { opacity: .45; cursor: default; }
.hidden { display: none !important; }
`;

export class TranslationPanel {
  private host: HTMLElement;
  private root: ShadowRoot;
  private el: {
    dot: HTMLElement;
    title: HTMLElement;
    meta: HTMLElement;
    bar: HTMLElement;
    status: HTMLElement;
    stop: HTMLButtonElement;
    toggle: HTMLButtonElement;
    pdf: HTMLButtonElement;
    retry: HTMLButtonElement;
  };
  private lang: UiLang;
  private handlers: PanelHandlers;

  constructor(lang: UiLang, handlers: PanelHandlers) {
    this.lang = lang;
    this.handlers = handlers;
    this.host = document.createElement('div');
    this.host.className = 'lingo-panel';
    this.host.setAttribute('data-lingo-ignore', '1');
    this.root = this.host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = PANEL_STYLES;

    const wrap = document.createElement('div');
    wrap.className = 'wrap';
    wrap.innerHTML = `
      <div class="head">
        <span class="dot"></span>
        <span class="title"></span>
        <button class="close" title="${t(lang, 'panel.close')}">×</button>
      </div>
      <div class="body">
        <div class="meta"></div>
        <div class="bar"><i></i></div>
        <div class="status"></div>
      </div>
      <div class="actions">
        <button class="act primary stop"></button>
        <button class="act toggle"></button>
        <button class="act pdf"></button>
        <button class="act retry hidden"></button>
      </div>
    `;

    const q = <T extends HTMLElement>(sel: string) => wrap.querySelector(sel) as T;
    this.el = {
      dot: q('.dot'),
      title: q('.title'),
      meta: q('.meta'),
      bar: q('.bar > i'),
      status: q('.status'),
      stop: q('.stop'),
      toggle: q('.toggle'),
      pdf: q('.pdf'),
      retry: q('.retry'),
    };

    wrap.querySelector('.close')?.addEventListener('click', () => this.handlers.onClose());
    this.el.stop.addEventListener('click', () => this.handlers.onStop());
    this.el.toggle.addEventListener('click', () => this.handlers.onToggleOriginal());
    this.el.pdf.addEventListener('click', () => this.handlers.onPdf());
    this.el.retry.addEventListener('click', () => this.handlers.onRetry());

    this.root.append(style, wrap);
    (document.body ?? document.documentElement).appendChild(this.host);
    this.render({
      supported: true,
      phase: 'extracting',
      total: 0,
      done: 0,
      failed: 0,
      showingOriginal: false,
    });
  }

  setLang(lang: UiLang): void {
    this.lang = lang;
    this.el.stop.textContent = t(lang, 'popup.stop');
    this.el.toggle.textContent = t(lang, 'popup.showOriginal');
    this.el.pdf.textContent = 'PDF';
    this.el.retry.textContent = t(lang, 'panel.retry');
  }

  render(state: PageState): void {
    const lang = this.lang;
    const busy = state.phase === 'extracting' || state.phase === 'translating';
    const dotClass = busy ? 'dot busy' : state.phase === 'error' ? 'dot error' : state.phase === 'done' ? 'dot done' : 'dot';
    this.el.dot.className = dotClass;

    const title =
      state.phase === 'error'
        ? t(lang, 'panel.error')
        : state.notice
          ? t(lang, 'app.name')
          : state.phase === 'done'
            ? t(lang, 'panel.done')
            : t(lang, 'panel.translating');
    this.el.title.textContent = title;

    const chips: string[] = [];
    if (state.provider) chips.push(`<span class="chip">${escapeHtml(state.provider)}</span>`);
    if (state.targetLang) chips.push(`<span class="chip">→ ${escapeHtml(state.targetLang)}</span>`);
    if (state.total > 0) chips.push(`<span class="chip">${state.done}/${state.total}</span>`);
    this.el.meta.innerHTML = chips.join(' ');

    const pct = state.total > 0 ? Math.round((state.done / state.total) * 100) : busy ? 8 : 100;
    this.el.bar.style.width = `${Math.min(100, pct)}%`;

    if (state.error) {
      this.el.status.textContent = state.error;
      this.el.status.className = 'status err';
    } else if (state.notice) {
      // "No text on this page", "site excluded": without this the panel said
      // "Done: 0 segments" and looked like a failure.
      this.el.status.textContent = state.notice;
      this.el.status.className = 'status';
    } else if (state.failed > 0) {
      this.el.status.textContent = `${t(lang, 'panel.partial')} (${state.failed})`;
      this.el.status.className = 'status';
    } else if (busy) {
      this.el.status.textContent = state.total > 0 ? t(lang, 'popup.progress', { done: state.done, total: state.total }) : '…';
      this.el.status.className = 'status';
    } else {
      this.el.status.textContent = t(lang, 'popup.done', { count: state.total });
      this.el.status.className = 'status';
    }

    this.el.stop.disabled = !busy;
    this.el.stop.textContent = t(lang, 'popup.stop');
    this.el.toggle.textContent = state.showingOriginal ? t(lang, 'popup.showTranslation') : t(lang, 'popup.showOriginal');
    this.el.toggle.disabled = state.phase !== 'done';
    this.el.pdf.disabled = state.phase !== 'done';
    this.el.retry.classList.toggle('hidden', state.phase !== 'error');
  }

  /** True while the panel is still attached; a wiped document drops it. */
  isConnected(): boolean {
    return this.host.isConnected;
  }

  /** Everything the panel currently shows. The root is closed, so tests read it through here. */
  snapshotText(): string {
    return this.root.textContent ?? '';
  }

  destroy(): void {
    this.host.remove();
  }
}

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}
