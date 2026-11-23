/** Popup: the primary control surface. Plain DOM via the shared `h` helper. */
import { loadSettings, loadTabState, patchSettings } from '../shared/storage';
import type { Settings } from '../shared/settings';
import { LANGUAGES } from '../shared/languages';
import { PROVIDERS, providerPreset } from '../shared/providers';
import type { PageState, RuntimeResponse } from '../shared/messaging';
import { sendToTab, type ContentCommand } from '../shared/messaging';
import { errorText, t, type UiLang } from '../shared/i18n';
import { h } from '../shared/dom';
import { injectContentScript } from '../shared/inject';
import type { ProviderId } from '../shared/types';

let settings: Settings;
let tab: chrome.tabs.Tab | null = null;
let pageState: PageState | null = null;
let busy = false;
let pollTimer: number | null = null;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

function lang(): UiLang {
  return settings?.uiLang ?? 'ru';
}

function isTranslatableTab(url: string | undefined): boolean {
  if (!url) return false;
  return /^(https?|file):/i.test(url);
}

/* --------------------------------------------------------------- rendering */

function render(): void {
  const root = $('app');
  const L = lang();
  const children = [header(L)];

  if (!tab || !isTranslatableTab(tab.url)) {
    children.push(
      h('main', { class: 'body' }, [
        h('div', { class: 'notice' }, [
          h('div', { class: 'notice-title', text: t(L, 'popup.unsupported') }),
          h('div', { class: 'notice-sub', text: t(L, 'popup.restricted') }),
        ]),
      ]),
    );
  } else {
    children.push(
      h('main', { class: 'body' }, [
        languageRow(L),
        providerRow(L),
        actionRow(L),
        busy || (pageState && pageState.phase !== 'idle') ? statusBlock(L) : h('div', { class: 'status' }),
      ]),
    );
  }

  children.push(footer(L));
  root.replaceChildren(...children);
}

function header(L: UiLang): HTMLElement {
  return h('header', { class: 'head' }, [
    h('div', { class: 'brand' }, [
      h('span', { class: 'logo' }),
      h('div', {}, [h('div', { class: 'name', text: t(L, 'app.name') }), h('div', { class: 'tagline', text: t(L, 'app.tagline') })]),
    ]),
    h('button', {
      class: 'icon-btn',
      title: t(L, 'popup.settings'),
      text: '⚙',
      onClick: () => chrome.runtime.openOptionsPage(),
    }),
  ]);
}

function languageRow(L: UiLang): HTMLElement {
  const sourceSelect = h(
    'select',
    { id: 'source-lang', class: 'select' },
    LANGUAGES.map((language) =>
      h('option', {
        value: language.code,
        text: language.code === 'auto' ? t(L, 'popup.autoDetect') : language.label,
      }),
    ),
  );
  sourceSelect.value = settings.sourceLang;
  sourceSelect.onchange = () => void save({ sourceLang: sourceSelect.value });

  const targetSelect = h(
    'select',
    { id: 'target-lang', class: 'select' },
    LANGUAGES.filter((language) => language.code !== 'auto').map((language) =>
      h('option', { value: language.code, text: language.label }),
    ),
  );
  targetSelect.value = settings.targetLang;
  targetSelect.onchange = () => void save({ targetLang: targetSelect.value });

  const swap = h('button', {
    class: 'swap',
    title: '⇄',
    text: '⇄',
    onClick: () => void swapLanguages(),
  });

  return h('div', { class: 'row' }, [
    field(L, 'popup.from', sourceSelect),
    swap,
    field(L, 'popup.to', targetSelect),
  ]);
}

function providerRow(L: UiLang): HTMLElement {
  const preset = providerPreset(settings.provider);
  const select = h('select', { id: 'provider', class: 'select full' });
  const llm = document.createElement('optgroup');
  llm.label = t(L, 'popup.llmService');
  const mt = document.createElement('optgroup');
  mt.label = t(L, 'popup.freeService');
  for (const provider of PROVIDERS) {
    const option = h('option', {
      value: provider.id,
      text: provider.needsKey ? provider.label : `${provider.label} · ${t(L, 'options.freeNote')}`,
    });
    (provider.kind === 'llm' ? llm : mt).append(option);
  }
  if (llm.children.length > 0) select.append(llm);
  select.append(mt);
  select.value = settings.provider;
  select.onchange = () => void save({ provider: select.value as ProviderId });

  const row = h('div', { class: 'row single' }, [field(L, 'popup.provider', select)]);

  if (preset.needsKey && !(settings.providers[preset.id]?.key ?? '').trim()) {
    row.append(
      h('div', { class: 'warn' }, [
        h('span', { text: t(L, 'popup.needKey') }),
        h('button', { class: 'link', text: t(L, 'popup.openKey'), onClick: () => chrome.runtime.openOptionsPage() }),
      ]),
    );
  }
  return row;
}

function actionRow(L: UiLang): HTMLElement {
  const translated = pageState?.phase === 'done' && (pageState.total ?? 0) > 0;

  const main = busy
    ? h('button', { class: 'primary danger', text: t(L, 'popup.stop'), onClick: () => void stopTranslation() })
    : h('button', {
        id: 'translate-btn',
        class: 'primary',
        text: translated ? t(L, 'popup.retranslate') : t(L, 'popup.translate'),
        onClick: () => void startTranslation(),
      });

  const secondary = h('div', { class: 'secondary' }, [
    h('button', {
      class: 'ghost',
      text: pageState?.showingOriginal ? t(L, 'popup.showTranslation') : t(L, 'popup.showOriginal'),
      disabled: !translated,
      onClick: () => void toggleOriginal(),
    }),
    h('button', {
      class: 'ghost',
      text: t(L, 'popup.savePdf'),
      disabled: !translated,
      onClick: () => void savePdf(),
    }),
    h('button', {
      class: 'ghost',
      text: t(L, 'popup.selection'),
      onClick: () => void translateSelection(),
    }),
  ]);

  return h('div', { class: 'actions' }, [main, secondary]);
}

function statusBlock(L: UiLang): HTMLElement {
  const box = h('div', { class: 'status', id: 'status' });
  if (!pageState) return box;

  if (pageState.error) {
    box.append(h('div', { class: 'error', text: pageState.error }));
    return box;
  }

  // A finished run with nothing to report otherwise looks like a no-op: say why.
  if (pageState.notice) {
    box.append(h('div', { class: 'muted', text: pageState.notice }));
  }

  if (settings.sourceLang === 'auto' && pageState.sourceLang) {
    box.append(h('div', { class: 'muted', text: `${t(L, 'popup.detected')}: ${pageState.sourceLang}` }));
  }

  if ((pageState.total ?? 0) > 0) {
    const pct = Math.round((pageState.done / pageState.total) * 100);
    box.append(
      h('div', { class: 'bar' }, [h('i', { style: `width:${pct}%` })]),
      h('div', {
        class: 'muted',
        text:
          pageState.phase === 'done'
            ? `${t(L, 'popup.done', { count: pageState.total })}${
                pageState.failed > 0 ? ` · ${t(L, 'panel.partial')} (${pageState.failed})` : ''
              }`
            : t(L, 'popup.progress', { done: pageState.done, total: pageState.total }),
      }),
    );
  }
  return box;
}

function field(L: UiLang, labelKey: string, control: HTMLElement): HTMLElement {
  return h('label', { class: 'field' }, [h('span', { class: 'label', text: t(L, labelKey) }), control]);
}

function footer(L: UiLang): HTMLElement {
  return h('footer', { class: 'foot' }, [
    h('button', { class: 'link', text: t(L, 'popup.settings'), onClick: () => chrome.runtime.openOptionsPage() }),
    h('span', { class: 'ver', text: 'v' + chrome.runtime.getManifest().version }),
  ]);
}

/* ----------------------------------------------------------------- actions */

async function save(patch: Partial<Settings>): Promise<void> {
  settings = await patchSettings(patch as Record<string, unknown>);
  render();
}

async function swapLanguages(): Promise<void> {
  const source = settings.sourceLang === 'auto' ? 'en' : settings.sourceLang;
  settings = await patchSettings({ sourceLang: settings.targetLang, targetLang: source });
  render();
}

async function activeTab(): Promise<chrome.tabs.Tab | null> {
  const [current] = await chrome.tabs.query({ active: true, currentWindow: true });
  return current ?? null;
}

async function refreshState(): Promise<RuntimeResponse<PageState> | null> {
  if (!tab?.id) return null;
  let response = await sendToTab<PageState>(tab.id, { type: 'GET_STATE' });
  if (!response.ok && response.error.code === 'no_receiver') {
    // The tab predates the extension: inject now so the first click already works.
    if (await injectContentScript(tab.id)) {
      response = await sendToTab<PageState>(tab.id, { type: 'GET_STATE' });
    }
  }
  pageState = response.ok ? response.data : null;
  busy = pageState?.phase === 'extracting' || pageState?.phase === 'translating';
  return response;
}

function startPolling(): void {
  if (pollTimer !== null) return;
  pollTimer = window.setInterval(async () => {
    const wasBusy = busy;
    await refreshState();
    if (wasBusy !== busy || busy) render();
    if (!busy && pageState?.phase !== 'translating') {
      window.clearInterval(pollTimer ?? 0);
      pollTimer = null;
    }
  }, 700);
}

/**
 * Send a command to the page, injecting the content script first when nothing is listening.
 *
 * A tab opened before the extension was installed or reloaded has no content script, and the
 * button used to fail silently. Retrying once after `executeScript` makes such tabs work.
 */
async function sendToPage<T = unknown>(msg: ContentCommand): Promise<RuntimeResponse<T>> {
  if (!tab?.id) {
    return { ok: false, error: { code: 'no_tab', message: t(lang(), 'popup.unsupported') } };
  }
  const first = await sendToTab<T>(tab.id, msg);
  if (first.ok || first.error.code !== 'no_receiver') return first;
  const injected = await injectContentScript(tab.id);
  if (!injected) {
    return { ok: false, error: { code: 'no_receiver', message: t(lang(), 'popup.unsupported') } };
  }
  return sendToTab<T>(tab.id, msg);
}

/** Show a failure in the popup instead of leaving the button looking broken. */
function showError(response: { ok: false; error: { code: string; message: string } }): void {
  pageState = {
    supported: true,
    phase: 'error',
    total: 0,
    done: 0,
    failed: 0,
    showingOriginal: false,
    error: errorText(lang(), response.error.code, response.error.message),
  };
  busy = false;
  stopPolling();
  render();
}

function stopPolling(): void {
  if (pollTimer === null) return;
  window.clearInterval(pollTimer);
  pollTimer = null;
}

async function startTranslation(): Promise<void> {
  busy = true;
  pageState = { supported: true, phase: 'extracting', total: 0, done: 0, failed: 0, showingOriginal: false };
  render();
  const response = await sendToPage({ type: 'TRANSLATE_PAGE' });
  if (!response.ok) {
    showError(response);
    return;
  }
  startPolling();
}

async function stopTranslation(): Promise<void> {
  const response = await sendToPage({ type: 'STOP' });
  if (!response.ok) {
    showError(response);
    return;
  }
  await refreshState();
  render();
}

async function toggleOriginal(): Promise<void> {
  const response = await sendToPage({ type: 'TOGGLE_ORIGINAL' });
  if (!response.ok) {
    showError(response);
    return;
  }
  await refreshState();
  render();
}

async function savePdf(): Promise<void> {
  const response = await sendToPage({ type: 'SAVE_PDF' });
  if (!response.ok) showError(response);
}

async function translateSelection(): Promise<void> {
  const response = await sendToPage({ type: 'TRANSLATE_SELECTION' });
  if (!response.ok) showError(response);
}

async function init(): Promise<void> {
  settings = await loadSettings();
  tab = await activeTab();
  const response = await refreshState();
  if (!pageState && tab?.id) {
    // The content script may not be reachable yet; show the last state the page reported
    // instead of an empty popup that looks like nothing happened.
    pageState = (await loadTabState(tab.id)) ?? null;
    busy = pageState?.phase === 'extracting' || pageState?.phase === 'translating';
  }
  if (!pageState && response && !response.ok) {
    // Nothing is listening and injection was refused (a browser page, the Web Store, a PDF):
    // say so now rather than leaving a button that silently does nothing.
    showError(response);
    return;
  }
  render();
  if (busy) startPolling();
}

void init();
