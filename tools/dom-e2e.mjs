/**
 * Offline end-to-end check against a real page.
 *
 * Chrome cannot be launched in the sandboxed shell (process creation is denied), so this
 * harness runs the *real* content-script modules against a real DOM: it loads the actual
 * page HTML into jsdom and executes the extension's own extraction, prompt building,
 * answer validation and DOM application. A mock model implements the same
 * "[id] text" protocol the skill demands.
 *
 * What it proves:
 *   - the page's prose is extracted and translated;
 *   - every code block is byte-identical afterwards;
 *   - the skill prompt contains the context and the "never translate code" rules;
 *   - revert restores the page exactly.
 *
 * Usage: node tools/dom-e2e.mjs [file|url]
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { register } from 'node:module';

// Extensionless relative imports are bundler-style; teach Node to resolve them.
register('../scripts/test-resolve-hook.mjs', import.meta.url);

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(root, '.tmp-e2e');
const DEFAULT_URL = 'https://book.leptos.dev/view/01_basic_component.html';
const target = process.argv[2] ?? DEFAULT_URL;

/* ------------------------------ DOM installation -------------------------- */

/**
 * Load the page under test. A local file is honoured (useful offline, and faster), and the
 * cache directory keeps the page when the network is unavailable.
 */
async function loadHtml(source) {
  if (/^https?:/.test(source)) {
    const cached = path.join(outDir, 'page.html');
    try {
      const html = await (await fetch(source)).text();
      await mkdir(outDir, { recursive: true });
      await writeFile(cached, html, 'utf8');
      return html;
    } catch (err) {
      if (existsSync(cached)) {
        console.warn(`[dom] network failed (${err.message}), using the cached page`);
        return readFile(cached, 'utf8');
      }
      throw err;
    }
  }
  return readFile(source, 'utf8');
}

async function main() {
  const html = await loadHtml(target);
  const dom = new JSDOM(html, {
    url: target.startsWith('http') ? target : DEFAULT_URL,
    pretendToBeVisual: true,
  });
  const { window } = dom;

  // Expose the browser globals the modules expect.
  const g = globalThis;
  g.window = window;
  g.document = window.document;
  g.location = window.location;
  g.getComputedStyle = window.getComputedStyle.bind(window);
  g.MutationObserver = window.MutationObserver;
  g.Node = window.Node;
  g.NodeFilter = window.NodeFilter;
  g.HTMLElement = window.HTMLElement;
  g.DocumentFragment = window.DocumentFragment;
  g.requestAnimationFrame = (cb) => setTimeout(cb, 0);
  g.chrome = {
    runtime: { getManifest: () => ({ version: '0.1.3' }), getURL: (p) => p },
    storage: { local: { get: async () => ({}), set: async () => undefined } },
  };

  // Stub the module-level imports the engine uses for messaging.
  window.getSelection = () => null;

  const { extractItems, filterTranslatable } = await import('../src/content/extract.ts');
  const { applyBlock, revertBlocks } = await import('../src/content/apply.ts');
  const { buildSystemPrompt, buildUserPrompt, detectDomain } = await import('../src/core/skill/translation-skill.ts');
  const { parseAnswer, checkIntegrity } = await import('../src/core/skill/validate.ts');
  const { normalizeSettings } = await import('../src/shared/settings.ts');
  const { fakeTranslate, parseSegments } = await import('./mock-api.mjs');

  const settings = normalizeSettings({
    sourceLang: 'auto',
    targetLang: 'ru',
    provider: 'deepseek',
    providers: { deepseek: { key: 'mock', model: 'deepseek-chat', baseUrl: 'http://127.0.0.1:8787' } },
    translateAttributes: true,
    translateCodeComments: true,
    skipBoilerplate: true,
  });

  /* ------------------------------- before --------------------------------- */

  const codeBefore = [...window.document.querySelectorAll('pre, code, kbd, samp')].map((node) => ({
    tag: node.tagName,
    text: node.textContent,
  }));
  const htmlBefore = window.document.body.innerHTML;
  const titleBefore = window.document.title;

  /* ------------------------------- extract -------------------------------- */

  const extracted = extractItems({
    translateAttributes: settings.translateAttributes,
    translateCodeBlocks: settings.translateCode,
    translateCodeComments: settings.translateCodeComments,
    skipBoilerplate: settings.skipBoilerplate,
  });
  const items = filterTranslatable(extracted);
  const segments = items.map((item) => item.segment);

  console.log(`[dom] page: ${titleBefore}`);
  console.log(`[dom] code elements before: ${codeBefore.length}`);
  console.log(`[dom] segments extracted: ${segments.length}`);
  console.log(`[dom] first segments: ${JSON.stringify(segments.slice(0, 3).map((s) => s.text.slice(0, 70)))}`);

  if (segments.length === 0) {
    console.error('[dom] FAIL: nothing extracted');
    process.exit(2);
  }

  /* --------------------------- prompt & answer ---------------------------- */

  const sample = segments.map((s) => s.text).join(' ').slice(0, 3000);
  const domain = detectDomain(titleBefore, 'book.leptos.dev', sample);
  const system = buildSystemPrompt(settings, { pageTitle: titleBefore, pageHost: 'book.leptos.dev', domain });
  const chunkSize = 20;
  const byId = new Map();

  for (let offset = 0; offset < segments.length; offset += chunkSize) {
    const batch = segments.slice(offset, offset + chunkSize);
    const prompt = buildUserPrompt({
      segments: batch,
      sourceLang: 'auto',
      targetLang: 'ru',
      pageTitle: titleBefore,
      pageHost: 'book.leptos.dev',
      domain,
    });
    const blocks = parseSegments(prompt);
    const answer = blocks.map((block) => `[${block.id}] ${fakeTranslate(block.lines.join(' '))}`).join('\n');
    const parsed = parseAnswer(answer, batch.map((s) => s.id));
    const integrity = checkIntegrity(batch, parsed);
    for (const [id, text] of parsed.byId) byId.set(id, text);
    if (!integrity.ok) {
      console.warn(`[dom] batch ${offset / chunkSize}: ${integrity.problems.join('; ')}`);
    }
  }

  console.log(`[dom] domain detected: ${domain}`);
  console.log(`[dom] translations received: ${byId.size}/${segments.length}`);
  console.log(`[dom] skill mentions code:`, /NEVER TRANSLATE OR ALTER/.test(system));
  console.log(`[dom] skill mentions context:`, /CONTEXT AWARENESS/.test(system));

  /* -------------------------------- apply --------------------------------- */

  const applied = [];
  for (const item of items) {
    const translated = byId.get(item.segment.id);
    if (!translated || translated === item.segment.text) continue;
    if (!item.block) continue;
    const block = applyBlock({ block: item.block, nodes: item.nodes, slots: item.slots }, item.segment.text, translated, 'replace', true);
    if (block) applied.push(block);
  }

  const codeAfter = [...window.document.querySelectorAll('pre, code, kbd, samp')].map((node) => ({
    tag: node.tagName,
    text: node.textContent,
  }));
  const codeUnchanged = JSON.stringify(codeBefore) === JSON.stringify(codeAfter);
  if (!codeUnchanged) {
    const diffs = [];
    for (let i = 0; i < Math.max(codeBefore.length, codeAfter.length); i++) {
      const a = codeBefore[i];
      const b = codeAfter[i];
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        diffs.push({ index: i, before: a, after: b });
      }
    }
    console.log('[dom] CODE DIFFS:', JSON.stringify(diffs.slice(0, 3), null, 2).slice(0, 2000));
  }
  const translatedNodes = window.document.querySelectorAll('[data-lingo="translation"]');
  const originals = window.document.querySelectorAll('.lingo-original-text');

  const sampleTranslations = [...translatedNodes].slice(0, 6).map((node) => node.textContent);
  const cyrillic = sampleTranslations.filter((text) => /\p{Script=Cyrillic}/u.test(text)).length;

  console.log(`[dom] applied blocks: ${applied.length}`);
  console.log(`[dom] original spans: ${originals.length}`);
  console.log(`[dom] code unchanged: ${codeUnchanged}`);
  console.log('[dom] samples:', JSON.stringify(sampleTranslations, null, 2));

  /* -------------------------------- revert -------------------------------- */

  revertBlocks(applied);
  const htmlAfterRevert = window.document.body.innerHTML;
  const revertClean = htmlAfterRevert === htmlBefore;

  console.log(`[dom] revert restores the DOM exactly: ${revertClean}`);

  await mkdir(outDir, { recursive: true });
  const report = {
    page: titleBefore,
    url: window.location.href,
    codeElements: codeBefore.length,
    segments: segments.length,
    translated: applied.length,
    codeUnchanged,
    revertClean,
    cyrillicSamples: cyrillic,
    samples: sampleTranslations,
    domain,
    passed:
      applied.length > 5 &&
      codeUnchanged &&
      revertClean &&
      cyrillic >= Math.min(3, sampleTranslations.length),
  };
  await writeFile(path.join(outDir, 'dom-report.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log('\n[dom] VERDICT:', report.passed ? 'PASS' : 'FAIL');
  process.exit(report.passed ? 0 : 2);
}

main().catch((err) => {
  console.error('[dom] failed:', err);
  process.exit(1);
});
