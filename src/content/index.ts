/**
 * Content script entry point.
 *
 * Receives commands from the worker and the popup, keeps the engine in sync with settings,
 * injects the small stylesheet the original/translation switch needs, and answers state
 * queries. All heavy lifting lives in `engine.ts`.
 */
import type { ContentCommand, PageState, RuntimeResponse } from '../shared/messaging';
import { sendToBackground } from '../shared/messaging';
import type { Settings } from '../shared/settings';
import { loadSettings, onSettingsChanged } from '../shared/storage';
import { PAGE_STYLES } from './apply';
import { PageTranslator } from './engine';

let engine: PageTranslator | null = null;

/**
 * The popup injects this script on demand, so the same page can run it more than once:
 * a tab that predates the extension, and a tab whose previous copy was orphaned by an
 * extension reload. The previous copy's listeners are dead in the second case and merely
 * duplicated in the first, so its teardown is kept here and called before re-registering.
 * Without that, `chrome.runtime.onMessage` would end up with two handlers and the newer
 * copy would be shadowed by the older one for the popup's replies.
 */
const TEARDOWN_KEY = '__lingoContentTeardown';
const ENGINE_KEY = '__lingoEngine';
type ContentGlobal = typeof globalThis & {
  [TEARDOWN_KEY]?: () => void;
  [ENGINE_KEY]?: PageTranslator;
};
const contentGlobal = globalThis as ContentGlobal;

function injectStyles(): void {
  if (document.getElementById('lingo-page-styles')) return;
  const style = document.createElement('style');
  style.id = 'lingo-page-styles';
  style.textContent = PAGE_STYLES;
  (document.head ?? document.documentElement).appendChild(style);
}

async function getEngine(): Promise<PageTranslator> {
  if (engine) return engine;
  const settings = await loadSettings();
  injectStyles();
  // Reuse the previous copy's engine so a re-injection keeps the list of translated blocks:
  // otherwise "show original" and the PDF export would silently forget the page.
  engine = contentGlobal[ENGINE_KEY] ?? new PageTranslator(settings);
  contentGlobal[ENGINE_KEY] = engine;
  engine.updateSettings(settings);
  return engine;
}

const ok = <T>(data: T): RuntimeResponse<T> => ({ ok: true, data });
const fail = (code: string, message: string): RuntimeResponse => ({ ok: false, error: { code, message } });

async function handleCommand(command: ContentCommand): Promise<RuntimeResponse> {
  const translator = await getEngine();
  switch (command.type) {
    case 'TRANSLATE_PAGE':
      void translator.translatePage({ sourceLang: command.sourceLang, targetLang: command.targetLang });
      return ok({ started: true });
    case 'STOP':
      translator.stop();
      return ok({ stopped: true });
    case 'TOGGLE_ORIGINAL':
      translator.toggleOriginal();
      return ok<PageState>(translator.getState());
    case 'SAVE_PDF':
      void translator.exportPdf();
      return ok({ started: true });
    case 'TRANSLATE_SELECTION':
      void translator.translateSelection();
      return ok({ started: true });
    case 'GET_STATE':
      return ok<PageState>(translator.getState());
    default:
      return fail('bad_request', 'Unknown command');
  }
}

// Drop a previous copy: its listeners point at an extension context that may no longer exist.
try {
  contentGlobal[TEARDOWN_KEY]?.();
} catch {
  // An orphaned copy throws on every chrome.* call; nothing to clean up in that case.
}

const onMessage = (message: ContentCommand, _sender: chrome.runtime.MessageSender, sendResponse: (r: RuntimeResponse) => void) => {
  if (!message || typeof message !== 'object' || !('type' in message)) return false;
  handleCommand(message)
    .then(sendResponse)
    .catch((err) => sendResponse(fail('unknown', err instanceof Error ? err.message : String(err))));
  return true;
};
chrome.runtime.onMessage.addListener(onMessage);

const offSettings = onSettingsChanged((settings: Settings) => {
  engine?.updateSettings(settings);
});

/** Honour the auto-translate list on load. */
async function maybeAutoTranslate(): Promise<void> {
  const settings = await loadSettings();
  const host = location.hostname.toLowerCase();
  const matches = settings.autoTranslateHosts.some((entry) => host === entry || host.endsWith(`.${entry}`));
  if (!matches) return;
  if (document.readyState === 'loading') {
    await new Promise<void>((resolve) => document.addEventListener('DOMContentLoaded', () => resolve(), { once: true }));
  }
  void sendToBackground({ type: 'PING' }).catch(() => undefined);
  const translator = await getEngine();
  await translator.translatePage();
}

contentGlobal[TEARDOWN_KEY] = () => {
  chrome.runtime.onMessage.removeListener(onMessage);
  void offSettings.then((off) => off()).catch(() => undefined);
  // The engine itself survives in `ENGINE_KEY`; only this copy's wiring is dropped.
};

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void maybeAutoTranslate(), { once: true });
} else {
  void maybeAutoTranslate();
}
