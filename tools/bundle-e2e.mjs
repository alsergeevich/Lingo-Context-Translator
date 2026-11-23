/**
 * Integration check of the *built* service worker.
 *
 * Chrome cannot be launched from the sandboxed shell, so the bundle is executed in Node
 * with a minimal but faithful `chrome` API mock. This validates what unit tests cannot:
 * the custom bundler output, the message router, host-permission logic and a real HTTP
 * round trip to the DeepSeek-compatible mock.
 *
 * Usage: node tools/bundle-e2e.mjs
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { startMockServer } from './mock-api.mjs';

const mock = await startMockServer();
console.log('[bundle] mock API:', mock.url);

const root = path.resolve(import.meta.dirname, '..');

/* ------------------------------- chrome mock ------------------------------ */

const store = { local: {}, session: {} };
const listeners = { message: [], installed: [], menu: [], command: [] };

function area(name) {
  return {
    async get(keys) {
      const bucket = store[name];
      if (keys === undefined || keys === null) return { ...bucket };
      const list = Array.isArray(keys) ? keys : typeof keys === 'string' ? [keys] : Object.keys(keys);
      const out = {};
      for (const key of list) if (key in bucket) out[key] = bucket[key];
      return out;
    },
    async set(patch) {
      Object.assign(store[name], patch);
    },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      for (const key of list) delete store[name][key];
    },
    async clear() {
      store[name] = {};
    },
  };
}

const chrome = {
  runtime: {
    getManifest: () => ({ version: '0.1.3', manifest_version: 3 }),
    getURL: (p) => `chrome-extension://mock/${p}`,
    openOptionsPage: async () => undefined,
    sendMessage: async () => ({ ok: true }),
    onInstalled: { addListener: (fn) => listeners.installed.push(fn) },
    onStartup: { addListener: () => undefined },
    onMessage: { addListener: (fn) => listeners.message.push(fn) },
  },
  storage: {
    local: area('local'),
    session: area('session'),
    onChanged: { addListener: () => undefined },
  },
  tabs: {
    query: async () => [{ id: 1, url: 'https://book.leptos.dev/view/01_basic_component.html' }],
    sendMessage: async () => ({ ok: true }),
    create: async () => ({ id: 2 }),
  },
  contextMenus: {
    removeAll: (cb) => cb?.(),
    create: () => undefined,
    onClicked: { addListener: (fn) => listeners.menu.push(fn) },
  },
  commands: { onCommand: { addListener: (fn) => listeners.command.push(fn) } },
  action: { onClicked: { addListener: () => undefined } },
  permissions: {
    contains: async () => true,
    request: async () => true,
  },
};

/* --------------------------------- run ------------------------------------ */

async function main() {
  globalThis.chrome = chrome;

  const bundle = await readFile(path.join(root, 'dist', 'background.js'), 'utf8');

  // The bundle is an IIFE that registers listeners on `chrome`; run it in this realm so the
  // mocked globals are visible.
  // eslint-disable-next-line no-new-func
  new Function(bundle)();
  console.log('[bundle] service worker executed, listeners:', listeners.message.length);

  if (listeners.message.length === 0) throw new Error('message listener was not registered');
  listeners.installed.forEach((fn) => fn({ reason: 'install' }));

  const send = (message) =>
    new Promise((resolve) => {
      let settled = false;
      const sendResponse = (value) => {
        settled = true;
        resolve(value);
      };
      const keepAlive = listeners.message[0](message, { tab: { id: 1 } }, sendResponse);
      if (keepAlive !== true && !settled) {
        throw new Error('listener must return true to answer asynchronously');
      }
    });

  /* 1. settings */
  const defaults = await send({ type: 'GET_SETTINGS' });
  console.log('[bundle] settings loaded:', defaults.ok, defaults.data?.targetLang);

  const patched = await send({
    type: 'SET_SETTINGS',
    patch: {
      provider: 'deepseek',
      targetLang: 'ru',
      sourceLang: 'auto',
      chunkSize: 5,
      cacheEnabled: false,
      providers: { deepseek: { key: 'sk-mock', model: 'deepseek-chat', baseUrl: mock.url } },
    },
  });
  console.log('[bundle] settings patched:', patched.ok, patched.data?.providers?.deepseek?.baseUrl);

  /* 2. language detection */
  const detected = await send({ type: 'DETECT_LANGUAGE', text: 'This is an English sentence about components.' });
  console.log('[bundle] detected language:', detected.data?.lang);

  /* 3. provider test through the real HTTP mock */
  const probe = await send({ type: 'TEST_PROVIDER', provider: 'deepseek' });
  console.log('[bundle] provider probe:', probe.ok ? `ok “${probe.data.sample}”` : `fail ${probe.error.message}`);

  /* 4. real translation */
  const segments = [
    { id: 1, text: 'This is a basic component that renders a button.' },
    { id: 2, text: 'Call `cargo build` to compile the project.' },
    { id: 3, text: 'Signals are the reactive primitives.' },
  ];
  const translation = await send({
    type: 'TRANSLATE',
    payload: {
      segments,
      sourceLang: 'auto',
      targetLang: 'ru',
      pageTitle: 'A Basic Component',
      pageHost: 'book.leptos.dev',
    },
  });

  if (!translation.ok) throw new Error(`translation failed: ${translation.error.message}`);
  console.log('[bundle] translation:', JSON.stringify(translation.data.texts));
  console.log('[bundle] provider/model:', translation.data.provider, translation.data.model);
  console.log('[bundle] cached:', translation.data.cached, 'failed:', translation.data.failedCount);

  const codeKept = translation.data.texts[1]?.includes('`cargo build`');
  console.log('[bundle] inline code preserved:', codeKept);

  /* 5. error mapping: bad host */
  const bad = await send({
    type: 'SET_SETTINGS',
    patch: { providers: { deepseek: { key: 'sk', model: 'deepseek-chat', baseUrl: 'http://127.0.0.1:9' } } },
  });
  const failed = await send({
    type: 'TRANSLATE',
    payload: { segments: [{ id: 1, text: 'Hello' }], sourceLang: 'en', targetLang: 'ru' },
  });
  console.log('[bundle] unreachable host error:', bad.ok, failed.ok, failed.error?.code);

  const passed =
    defaults.ok &&
    patched.ok &&
    probe.ok &&
    translation.ok &&
    codeKept &&
    translation.data.texts.some((text) => /\p{Script=Cyrillic}/u.test(text)) &&
    failed.ok === false &&
    ['network', 'timeout', 'unknown'].includes(failed.error?.code);

  await mock.close();
  console.log('\n[bundle] VERDICT:', passed ? 'PASS' : 'FAIL');
  process.exit(passed ? 0 : 2);
}

main().catch((err) => {
  console.error('[bundle] failed:', err);
  process.exit(1);
});
