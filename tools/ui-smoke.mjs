/**
 * UI smoke test for the built popup and options pages.
 *
 * Chrome cannot be launched from the sandbox, so the real built bundles are executed in
 * jsdom with a `chrome` API mock. This catches runtime errors in the UI layer (bad DOM
 * helper usage, missing translations, crashes on empty state) that type-checking cannot see.
 *
 * Usage: node tools/ui-smoke.mjs
 */
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';

const root = path.resolve(import.meta.dirname, '..');
const dist = path.join(root, 'dist');

function chromeMock(store, options = {}) {
  const area = (bucket) => ({
    async get(keys) {
      if (keys === undefined || keys === null) return { ...bucket };
      const list = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys);
      const out = {};
      for (const key of list) if (key in bucket) out[key] = bucket[key];
      return out;
    },
    async set(patch) {
      Object.assign(bucket, patch);
    },
    async remove(key) {
      delete bucket[key];
    },
    async clear() {
      for (const key of Object.keys(bucket)) delete bucket[key];
    },
  });

  return {
    runtime: {
      getManifest: () => ({ version: '0.1.3', manifest_version: 3 }),
      getURL: (p) => `chrome-extension://mock/${p}`,
      openOptionsPage: async () => {
        store.calls.push('openOptionsPage');
      },
      sendMessage: async (message) => {
        store.calls.push(message.type);
        if (message.type === 'GET_SETTINGS') return { ok: true, data: store.settings };
        if (message.type === 'SET_SETTINGS') {
          store.settings = { ...store.settings, ...message.patch };
          return { ok: true, data: store.settings };
        }
        if (message.type === 'CACHE_STATS') return { ok: true, data: { count: 12, bytes: 4096 } };
        if (message.type === 'TEST_PROVIDER') return { ok: true, data: { model: 'mock', sample: 'Привет, мир!' } };
        return { ok: true, data: {} };
      },
      onMessage: { addListener: () => undefined },
      onInstalled: { addListener: () => undefined },
      onStartup: { addListener: () => undefined },
    },
    storage: {
      local: area(store.local),
      session: area(store.session),
      onChanged: { addListener: () => undefined },
    },
    tabs: {
      query: async () => [{ id: 1, url: store.tabUrl ?? 'https://book.leptos.dev/view/01_basic_component.html', title: 'A Basic Component' }],
      sendMessage: async (_id, message) => {
        // Simulate a tab that predates the extension: Chrome rejects with this exact string
        // and the popup used to ignore it, which made the button look dead.
        if (store.noReceiver && !store.injected) {
          store.calls.push('tab-fail:' + message.type);
          throw new Error('Could not establish connection. Receiving end does not exist.');
        }
        store.calls.push('tab:' + message.type);
        if (message.type === 'GET_STATE') {
          return {
            ok: true,
            data: {
              supported: true,
              phase: 'done',
              total: 42,
              done: 42,
              failed: 0,
              showingOriginal: false,
              sourceLang: 'en',
              targetLang: 'ru',
            },
          };
        }
        return { ok: true, data: {} };
      },
      create: async () => ({ id: 9 }),
    },
    contextMenus: { removeAll: (cb) => cb?.(), create: () => undefined, onClicked: { addListener: () => undefined } },
    commands: { onCommand: { addListener: () => undefined } },
    action: { onClicked: { addListener: () => undefined } },
    permissions: { contains: async () => true, request: async () => true },
    scripting: {
      executeScript: async () => {
        store.calls.push('INJECT');
        if (!options.allowInjection) throw new Error('Cannot access contents of the page.');
        store.injected = true;
      },
    },
  };
}

async function renderPage(htmlFile, jsFile, store) {
  const html = await readFile(path.join(dist, htmlFile), 'utf8');
  const script = await readFile(path.join(dist, jsFile), 'utf8');

  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (err) => errors.push(err.message));
  virtualConsole.on('error', (...args) => errors.push(args.join(' ')));

  const dom = new JSDOM(html, {
    url: `chrome-extension://mock/${htmlFile}`,
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole,
  });

  dom.window.chrome = chromeMock(store, store.options ?? {});
  dom.window.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);

  try {
    dom.window.eval(script);
  } catch (err) {
    errors.push(`eval failed: ${err.message}`);
  }

  await new Promise((resolve) => setTimeout(resolve, 250));
  return { window: dom.window, document: dom.window.document, errors };
}

/** Click a tab by its rendered label (labels come from the app, not from this test). */
function clickTab(document, window, matcher) {
  const tab = [...document.querySelectorAll('.tab')].find((node) => matcher(node.textContent ?? ''));
  tab?.dispatchEvent(new window.Event('click', { bubbles: true }));
  return !!tab;
}

async function main() {
  if (!existsSync(path.join(dist, 'popup.js'))) {
    console.error('[ui] dist not built — run npm run build first');
    process.exit(1);
  }

  const store = {
    local: {},
    session: {},
    calls: [],
    settings: {
      version: 3,
      sourceLang: 'auto',
      targetLang: 'ru',
      provider: 'deepseek',
      providers: { deepseek: { key: 'sk-test', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com' } },
      displayMode: 'replace',
      translateAttributes: true,
      translateCode: false,
      translateCodeComments: true,
      keepOriginal: true,
      autoTranslateHosts: [],
      excludedHosts: [],
      skipBoilerplate: true,
      customInstruction: '',
      useCustomSkill: false,
      glossary: [{ source: 'signal', target: 'сигнал' }],
      chunkSize: 20,
      concurrency: 3,
      requestTimeoutSec: 120,
      cacheEnabled: true,
      cacheTtlDays: 30,
      pdf: { includeOriginals: false, includeMeta: true, pageSize: 'A4', marginMm: 14 },
      uiLang: 'ru',
      theme: 'auto',
      skillVersion: 3,
    },
  };

  /* --------------------------------- popup -------------------------------- */

  const popup = await renderPage('popup.html', 'popup.js', store);
  const popupText = popup.document.body.textContent ?? '';
  const popupChecks = {
    hasHeader: !!popup.document.querySelector('.head'),
    hasSourceSelect: !!popup.document.querySelector('#source-lang'),
    hasTargetSelect: !!popup.document.querySelector('#target-lang'),
    hasProviderSelect: !!popup.document.querySelector('#provider'),
    hasTranslateButton: !!popup.document.querySelector('button.primary'),
    showsProgress: /42|Готово|переведено/i.test(popupText),
    providerCount: popup.document.querySelectorAll('#provider option').length,
    sourceLangValue: popup.document.querySelector('#source-lang')?.value,
    targetLangValue: popup.document.querySelector('#target-lang')?.value,
    noErrors: popup.errors.length === 0,
  };
  console.log('[ui] popup:', JSON.stringify(popupChecks));

  popup.document.querySelector('button.primary')?.dispatchEvent(new popup.window.Event('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 120));
  console.log('[ui] popup calls after click:', store.calls.join(', '));

  /* ------------------- popup when the content script is absent ------------------- */

  // Refused injection: the popup must explain itself instead of leaving a dead button.
  const refused = {
    local: {},
    session: {},
    calls: [],
    settings: store.settings,
    noReceiver: true,
    options: { allowInjection: false },
  };
  const refusedPopup = await renderPage('popup.html', 'popup.js', refused);
  const refusedText = refusedPopup.document.body.textContent ?? '';
  const refusedSaysWhy = /не видит эту вкладку|Обновите страницу|not running in this tab/i.test(refusedText);
  console.log('[ui] popup without content script:', JSON.stringify({
    calls: refused.calls.join(','),
    saysWhy: refusedSaysWhy,
    noErrors: refusedPopup.errors.length === 0,
  }));

  // Injection allowed: the popup injects and then shows the page state, so the first click works.
  const healed = {
    local: {},
    session: {},
    calls: [],
    settings: store.settings,
    noReceiver: true,
    options: { allowInjection: true },
  };
  const healedPopup = await renderPage('popup.html', 'popup.js', healed);
  const healedChecks = {
    injected: healed.calls.includes('INJECT'),
    recovered: /Готово|переведено|done/i.test(healedPopup.document.body.textContent ?? ''),
    noErrors: healedPopup.errors.length === 0,
  };
  console.log('[ui] popup after self-injection:', JSON.stringify(healedChecks));

  /* ------------- content script injected twice into the same page ------------- */

  // The popup injects content.js on demand, so a page can run it twice. Both copies used to
  // register a message listener, and the older, orphaned one answered first.
  const contentDom = new JSDOM('<!doctype html><html><body><p>Hello world, a paragraph to translate.</p></body></html>', {
    url: 'https://example.com/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const listeners = [];
  const pageStore = {};
  const pageArea = (bucket) => ({
    async get(keys) {
      if (keys === undefined || keys === null) return { ...bucket };
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const key of list) if (key in bucket) out[key] = bucket[key];
      return out;
    },
    async set(patch) {
      Object.assign(bucket, patch);
    },
  });
  contentDom.window.chrome = {
    runtime: {
      onMessage: {
        addListener: (fn) => listeners.push(fn),
        removeListener: (fn) => {
          const index = listeners.indexOf(fn);
          if (index >= 0) listeners.splice(index, 1);
        },
      },
      sendMessage: async () => ({ ok: true, data: {} }),
      getManifest: () => ({ version: '0.1.3' }),
    },
    storage: { local: pageArea(pageStore), session: pageArea(pageStore), onChanged: { addListener() {}, removeListener() {} } },
  };
  const contentCode = await readFile(path.join(dist, 'content.js'), 'utf8');
  contentDom.window.eval(contentCode);
  // First command builds the engine and records that the page has a translator at all.
  await new Promise((resolve) => listeners[0]?.({ type: 'GET_STATE' }, {}, resolve));
  const firstEngine = contentDom.window.__lingoEngine;
  // The popup injects again after an extension reload.
  contentDom.window.eval(contentCode);
  const secondReply = await new Promise((resolve) => listeners[0]?.({ type: 'GET_STATE' }, {}, resolve));
  const doubleInjection = {
    listeners: listeners.length,
    engineKept: !!firstEngine && contentDom.window.__lingoEngine === firstEngine,
    answers: secondReply?.ok === true,
  };
  console.log('[ui] content script injected twice:', JSON.stringify(doubleInjection));

  /* -------------------------------- options ------------------------------- */

  const options = await renderPage('options.html', 'options.js', store);
  const tabLabels = [...options.document.querySelectorAll('.tab')].map((tab) => tab.textContent ?? '');
  console.log('[ui] options tabs:', JSON.stringify(tabLabels));

  const tabResults = {};
  for (const label of tabLabels) {
    clickTab(options.document, options.window, (text) => text === label);
    await new Promise((resolve) => setTimeout(resolve, 70));
    const rootNode = options.document.getElementById('app');
    tabResults[label] = {
      length: (rootNode?.textContent ?? '').trim().length,
      hasSaveBar: !!options.document.querySelector('.savebar'),
    };
  }
  console.log('[ui] options tabs rendered:', JSON.stringify(tabResults));

  // The skill tab must show the built-in prompt preview.
  const foundSkillTab = clickTab(options.document, options.window, (text) => /навык/i.test(text));
  await new Promise((resolve) => setTimeout(resolve, 70));
  const preview = options.document.querySelector('pre.skill')?.textContent ?? '';
  const skillChecks = {
    foundSkillTab,
    hasPreview: preview.length > 500,
    mentionsCode: /NEVER TRANSLATE OR ALTER/.test(preview),
    mentionsContext: /CONTEXT AWARENESS/.test(preview),
    mentionsSlots: /\{\{0\}\}/.test(preview),
  };
  console.log('[ui] skill preview:', JSON.stringify(skillChecks));

  // Provider cards and their Test buttons.
  const foundProviderTab = clickTab(options.document, options.window, (text) => /переводчик/i.test(text));
  await new Promise((resolve) => setTimeout(resolve, 70));
  const providerCards = options.document.querySelectorAll('.provider').length;

  const testButton = [...options.document.querySelectorAll('.provider .btn')].find((button) => /проверить/i.test(button.textContent ?? ''));
  testButton?.dispatchEvent(new options.window.Event('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 200));
  const testResult = options.document.querySelector('.test-result')?.textContent ?? '';
  console.log('[ui] provider cards:', providerCards, '| test result:', JSON.stringify(testResult.slice(0, 60)));

  /* -------------------------------- verdict ------------------------------- */

  const passed =
    popupChecks.hasHeader &&
    popupChecks.hasSourceSelect &&
    popupChecks.hasTargetSelect &&
    popupChecks.hasProviderSelect &&
    popupChecks.hasTranslateButton &&
    popupChecks.providerCount >= 12 &&
    popupChecks.sourceLangValue === 'auto' &&
    popupChecks.targetLangValue === 'ru' &&
    popupChecks.noErrors &&
    store.calls.includes('tab:TRANSLATE_PAGE') &&
    tabLabels.length === 8 &&
    Object.values(tabResults).every((entry) => entry.length > 100 && entry.hasSaveBar) &&
    skillChecks.hasPreview &&
    skillChecks.mentionsCode &&
    skillChecks.mentionsContext &&
    skillChecks.mentionsSlots &&
    providerCards >= 12 &&
    /Работает/.test(testResult) &&
    refusedSaysWhy &&
    refusedPopup.errors.length === 0 &&
    healedChecks.injected &&
    healedChecks.recovered &&
    healedChecks.noErrors &&
    doubleInjection.listeners === 1 &&
    doubleInjection.engineKept &&
    doubleInjection.answers &&
    popup.errors.length === 0 &&
    options.errors.length === 0;

  if (popup.errors.length) console.log('[ui] popup errors:', popup.errors);
  if (options.errors.length) console.log('[ui] options errors:', options.errors);

  console.log('\n[ui] VERDICT:', passed ? 'PASS' : 'FAIL');
  process.exit(passed ? 0 : 2);
}

main().catch((err) => {
  console.error('[ui] failed:', err);
  process.exit(1);
});
