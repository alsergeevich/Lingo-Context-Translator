/**
 * Service worker: message router, context menu, commands and per-tab orchestration.
 *
 * Deliberately thin: the translation itself lives in `core/translator.ts`, and the
 * content script drives the DOM. The worker only routes, caches and grants hosts.
 */
import { loadSettings, patchSettings, saveTabState } from '../shared/storage';
import type { PageState, RuntimeRequest, RuntimeResponse } from '../shared/messaging';
import { providerPreset, DEFAULT_PROVIDER } from '../shared/providers';
import type { ProviderId } from '../shared/types';
import { TranslationError, isTranslationError } from '../shared/types';
import { adapterFor } from '../core/providers/index';
import { assertProviderReady, ensureHostPermission, resolveConfig, translateSegments } from '../core/translator';
import { cacheClear, cachePrune, cacheStats } from '../core/cache';
import { detectLanguage } from '../core/lang-detect';
import { sendToTab } from '../shared/messaging';

const MENU_TRANSLATE_PAGE = 'lingo-translate-page';
const MENU_TRANSLATE_SELECTION = 'lingo-translate-selection';
const MENU_SAVE_PDF = 'lingo-save-pdf';
const MENU_SHOW_ORIGINAL = 'lingo-show-original';

/* ------------------------------------------------------------------ helpers */

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function errorResponse(err: unknown): RuntimeResponse {
  if (isTranslationError(err)) {
    return { ok: false, error: { code: err.code, message: err.message, retryable: err.retryable } };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, error: { code: 'unknown', message } };
}

async function providerUrlFor(
  id: ProviderId,
  settings: Awaited<ReturnType<typeof loadSettings>>,
): Promise<string | undefined> {
  const preset = providerPreset(id);
  const config = resolveConfig(settings, id);
  if (preset.dialect === 'anthropic') return config.baseUrl || undefined;
  if (preset.dialect === 'gemini') return config.baseUrl || undefined;
  if (preset.dialect === 'openai') return (config.baseUrl || preset.baseUrl || '') + '/chat/completions';
  return config.baseUrl || preset.baseUrl || undefined;
}

/* ------------------------------------------------------------------- router */

async function handle(msg: RuntimeRequest, senderTabId?: number): Promise<RuntimeResponse> {
  switch (msg.type) {
    case 'PING':
      return { ok: true, data: { version: chrome.runtime.getManifest().version } };

    case 'GET_SETTINGS':
      return { ok: true, data: await loadSettings() };

    case 'SET_SETTINGS': {
      const settings = await patchSettings(msg.patch);
      return { ok: true, data: settings };
    }

    case 'DETECT_LANGUAGE': {
      const result = await detectLanguage(msg.text);
      return { ok: true, data: result };
    }

    case 'TRANSLATE': {
      const settings = await loadSettings();
      const providerId = msg.payload.providerOverride ?? settings.provider ?? DEFAULT_PROVIDER;
      const preset = providerPreset(providerId);
      assertProviderReady(settings, providerId);

      const config = resolveConfig(settings, providerId);
      const url = await providerUrlFor(providerId, settings);

      // Hosts declared in the manifest need no prompt. A custom base URL (or a proxy) does:
      // try to obtain it, but never block on the prompt — the popup asks for it with a real
      // user gesture, and a failed fetch below reports the real reason if it is still missing.
      if (url && !preset.hosts) {
        await ensureHostPermission(url).catch(() => false);
      }

      const result = await translateSegments({
        settings,
        config,
        segments: msg.payload.segments,
        sourceLang: msg.payload.sourceLang,
        targetLang: msg.payload.targetLang,
        pageTitle: msg.payload.pageTitle,
        pageHost: msg.payload.pageHost,
        force: msg.payload.force,
      });
      return { ok: true, data: result };
    }

    case 'TEST_PROVIDER': {
      const settings = await loadSettings();
      const preset = providerPreset(msg.provider);
      const config = resolveConfig(settings, msg.provider, msg.overrides);
      const url = await providerUrlFor(msg.provider, { ...settings, provider: msg.provider });
      if (url && !preset.hosts) {
        const granted = await ensureHostPermission(url).catch(() => false);
        if (!granted) {
          throw new TranslationError('no_host_permission', `Access to ${url} was not granted`, {
            provider: msg.provider,
          });
        }
      }
      const adapter = adapterFor(msg.provider);
      const probe = await adapter.probe(config);
      return { ok: true, data: probe };
    }

    case 'CACHE_STATS':
      return { ok: true, data: await cacheStats() };

    case 'CACHE_CLEAR':
      await cacheClear();
      return { ok: true, data: { cleared: true } };

    case 'REQUEST_HOST_PERMISSION': {
      const granted = await ensureHostPermission(msg.origin);
      return { ok: true, data: { granted } };
    }

    case 'OPEN_PRINT': {
      // The payload goes through session storage: print.html is an extension page, and
      // keeping it out of the URL avoids the length limits of message passing.
      await chrome.storage.session.set({ printPayload: msg.payload });
      const url = chrome.runtime.getURL('print.html');
      const tab = await chrome.tabs.create({ url, active: true });
      return { ok: true, data: { tabId: tab.id } };
    }

    case 'REPORT_STATE': {
      const tabId = senderTabId;
      if (tabId != null) await reportTabState(tabId, msg.state);
      return { ok: true, data: { received: true } };
    }

    case 'OPEN_OPTIONS':
      await chrome.runtime.openOptionsPage();
      return { ok: true, data: { opened: true } };

    default: {
      const exhaustive: never = msg;
      return { ok: false, error: { code: 'bad_request', message: `Unknown message: ${String(exhaustive)}` } };
    }
  }
}

chrome.runtime.onMessage.addListener((message: RuntimeRequest, sender, sendResponse) => {
  if (!message || typeof message !== 'object' || !('type' in message)) return false;
  handle(message, sender.tab?.id)
    .then(sendResponse)
    .catch((err) => sendResponse(errorResponse(err)));
  return true; // keep the channel open for the async answer
});

/* ------------------------------------------------------------ context menus */

function createMenus(): void {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_TRANSLATE_PAGE,
      title: 'Перевести страницу',
      contexts: ['page'],
    });
    chrome.contextMenus.create({
      id: MENU_TRANSLATE_SELECTION,
      title: 'Перевести выделенное',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: MENU_SHOW_ORIGINAL,
      title: 'Показать оригинал / перевод',
      contexts: ['page'],
    });
    chrome.contextMenus.create({
      id: MENU_SAVE_PDF,
      title: 'Сохранить перевод в PDF',
      contexts: ['page'],
    });
  });
}

chrome.runtime.onInstalled.addListener((details) => {
  createMenus();
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage().catch(() => undefined);
  }
  cachePrune(30).catch(() => undefined);
});

chrome.runtime.onStartup?.addListener(() => {
  createMenus();
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const tabId = tab?.id;
  if (tabId == null) return;
  try {
    switch (info.menuItemId) {
      case MENU_TRANSLATE_PAGE:
        await sendToTab(tabId, { type: 'TRANSLATE_PAGE' });
        break;
      case MENU_TRANSLATE_SELECTION:
        await sendToTab(tabId, { type: 'TRANSLATE_SELECTION' });
        break;
      case MENU_SHOW_ORIGINAL:
        await sendToTab(tabId, { type: 'TOGGLE_ORIGINAL' });
        break;
      case MENU_SAVE_PDF:
        await sendToTab(tabId, { type: 'SAVE_PDF' });
        break;
      default:
        break;
    }
  } catch {
    /* tab may be gone */
  }
});

/* --------------------------------------------------------------- commands */

chrome.commands?.onCommand.addListener(async (command) => {
  const tab = await activeTab();
  if (!tab?.id) return;
  try {
    if (command === 'translate-page') await sendToTab(tab.id, { type: 'TRANSLATE_PAGE' });
    if (command === 'toggle-original') await sendToTab(tab.id, { type: 'TOGGLE_ORIGINAL' });
    if (command === 'save-pdf') await sendToTab(tab.id, { type: 'SAVE_PDF' });
  } catch {
    /* ignore */
  }
});

/* -------------------------------------------------------- action shortcuts */

chrome.action.onClicked?.addListener(async (tab) => {
  if (!tab.id) return;
  await sendToTab(tab.id, { type: 'TRANSLATE_PAGE' }).catch(() => undefined);
});

/* --------------------------------------------------------------- tab state */

export async function reportTabState(tabId: number, state: PageState): Promise<void> {
  await saveTabState(tabId, state).catch(() => undefined);
}
