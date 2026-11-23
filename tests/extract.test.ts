import { describe, it, expect } from './helpers/framework';
import { JSDOM } from 'jsdom';

/**
 * Extraction and application are tested on jsdom — a real DOM implementation — rather
 * than a hand-written stub, because the code depends on TreeWalker, closest(), childNodes
 * and cloneNode semantics that a stub would get subtly wrong.
 */

function setup(html: string, url = 'https://book.leptos.dev/view/01_basic_component.html') {
  const dom = new JSDOM(`<!doctype html><html><head><title>Test page</title></head><body>${html}</body></html>`, {
    url,
    pretendToBeVisual: true,
  });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  g.location = dom.window.location;
  g.Node = dom.window.Node;
  g.NodeFilter = dom.window.NodeFilter;
  g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  return dom;
}

function options(overrides: Record<string, unknown> = {}) {
  return {
    translateAttributes: false,
    translateCodeBlocks: false,
    translateCodeComments: false,
    skipBoilerplate: false,
    ...overrides,
  };
}

const extract = () => import('../src/content/extract');
const apply = () => import('../src/content/apply');

describe('extraction', () => {
  it('collects paragraph text as one segment', async () => {
    setup('<div><p>Hello world, this is a paragraph.</p></div>');
    const { extractItems } = await extract();
    const items = extractItems(options());
    expect(items.length).toBe(1);
    expect(items[0].segment.text).toBe('Hello world, this is a paragraph.');
  });

  it('never sends code blocks to the model', async () => {
    setup('<div><pre><code>fn main() { println!("hi"); }</code></pre><p>A paragraph that should be translated.</p></div>');
    const { extractItems } = await extract();
    const items = extractItems(options({ translateCodeComments: true }));
    const all = items.map((item) => item.segment.text).join(' ');
    expect(all).not.toContain('fn main');
    expect(all).toContain('A paragraph');
  });

  it('skips script and style content', async () => {
    setup('<div><script>const x = 1;</script><style>.a{color:red}</style></div><p>Only me.</p>');
    const { extractItems } = await extract();
    const items = extractItems(options());
    expect(items.map((item) => item.segment.text)).toEqual(['Only me.']);
  });

  it('keeps a paragraph with an inline link as one segment with a slot', async () => {
    setup('<div><p>Read the <a href="#doc">documentation</a> before you start.</p></div>');
    const { extractItems } = await extract();
    const items = extractItems(options());
    expect(items.length).toBe(1);
    expect(items[0].segment.text).toContain('Read the');
    expect(items[0].segment.text).toContain('before you start');
    expect(items[0].segment.text).toContain('{{0}}');
    expect(items[0].slots.length).toBe(1);
    expect(items[0].slots[0].opaque).toBe(false);
  });

  it('marks inline code as an opaque slot and keeps it out of the prompt', async () => {
    setup('<div><p>Call <code>cargo build</code> to compile.</p></div>');
    const { extractItems } = await extract();
    const items = extractItems(options());
    expect(items.length).toBe(1);
    expect(items[0].slots.length).toBe(1);
    expect(items[0].slots[0].opaque).toBe(true);
    expect(items[0].segment.text).not.toContain('cargo build');
    expect(items[0].segment.text).toContain('{{0}}{{/0}}');
  });

  it('uses the nearest heading as segment context', async () => {
    setup('<main><section><h2>Reactivity</h2><p>Signals update automatically.</p></section></main>');
    const { extractItems } = await extract();
    const items = extractItems(options());
    const paragraph = items.find((item) => item.segment.text.includes('Signals update'));
    expect(paragraph?.segment.context).toBe('Reactivity');
  });

  it('drops punctuation-only and letterless segments', async () => {
    setup('<p>—</p><p>123 456</p><p>Real text here</p>');
    const { extractItems, filterTranslatable } = await extract();
    const items = filterTranslatable(extractItems(options()));
    expect(items.map((item) => item.segment.text)).toEqual(['Real text here']);
  });

  it('skips boilerplate when asked', async () => {
    setup('<nav>Home About Contact</nav><p>Actual content.</p>');
    const { extractItems } = await extract();
    const items = extractItems(options({ skipBoilerplate: true }));
    expect(items.map((item) => item.segment.text)).toEqual(['Actual content.']);
  });

  it('translates attributes when enabled', async () => {
    setup('<div><img alt="A diagram of the component tree"><p>Text.</p></div>');
    const { extractItems } = await extract();
    const items = extractItems(options({ translateAttributes: true }));
    const withAlt = items.find((item) => item.attributes.length > 0);
    expect(withAlt?.attributes[0].name).toBe('alt');
    expect(withAlt?.segment.text).toBe('A diagram of the component tree');
  });

  it('ignores elements marked as untranslatable', async () => {
    setup('<p data-lingo-ignore="1">Ignore me</p><p>Keep me</p>');
    const { extractItems } = await extract();
    const items = extractItems(options());
    expect(items.map((item) => item.segment.text)).toEqual(['Keep me']);
  });

  it('detects code-looking text', async () => {
    setup('<p>x</p>');
    const { looksLikeCode } = await extract();
    expect(looksLikeCode('{}[]();')).toBe(true);
    expect(looksLikeCode('const x = 1;')).toBe(true);
    expect(looksLikeCode('Normal sentence about code.')).toBe(false);
  });

  it('recognises code comments', async () => {
    setup('<p>x</p>');
    const { looksLikeComment } = await extract();
    expect(looksLikeComment('// explain the signal')).toBe(true);
    expect(looksLikeComment('# python style')).toBe(true);
    expect(looksLikeComment('Just a sentence.')).toBe(false);
  });

  it('never produces two segments for one block', async () => {
    setup('<div><p>One sentence with <em>emphasis</em> and more text.</p></div>');
    const { extractItems } = await extract();
    const items = extractItems(options());
    expect(items.length).toBe(1);
    expect(items[0].segment.text).toContain('emphasis');
  });

  it('handles a whole document without throwing', async () => {
    setup(
      '<header><h1>Title</h1></header><main><h2>Section</h2><p>Body text with <a href="/x">a link</a>.</p>' +
        '<pre><code>let x = 1;</code></pre><ul><li>First item</li><li>Second item</li></ul></main>' +
        '<footer>Footer text</footer>',
    );
    const { extractItems, filterTranslatable } = await extract();
    const items = filterTranslatable(extractItems(options({ skipBoilerplate: true })));
    const texts = items.map((item) => item.segment.text);
    expect(texts.some((text) => text.includes('Body text'))).toBe(true);
    expect(texts.some((text) => text.includes('First item'))).toBe(true);
    expect(texts.some((text) => text.includes('Footer text'))).toBe(false);
    expect(texts.some((text) => text.includes('let x'))).toBe(false);
  });
});

describe('slot rendering', () => {
  it('renders a link slot as a cloned element and drops the original label', async () => {
    setup('<p>Read the <a href="/guide">guide</a> now.</p>');
    const document_ = globalThis.document;
    const link = document_.querySelector('a')!;
    const { renderTranslation } = await apply();
    const fragment = renderTranslation('Прочитайте {{0}}руководство{{/0}} сейчас.', [
      { index: 0, element: link, opaque: false, innerHtml: 'guide' },
    ]);
    const container = document_.createElement('div');
    container.appendChild(fragment);
    expect(container.textContent).toBe('Прочитайте руководство сейчас.');
    expect(container.querySelectorAll('a').length).toBe(1);
    expect(container.querySelector('a')?.getAttribute('href')).toBe('/guide');
  });

  it('restores opaque slot content verbatim', async () => {
    setup('<p>Call <code>cargo build</code>.</p>');
    const document_ = globalThis.document;
    const code = document_.querySelector('code')!;
    const { renderTranslation } = await apply();
    const fragment = renderTranslation('Вызовите {{0}}{{/0}}.', [
      { index: 0, element: code, opaque: true, innerHtml: 'cargo build' },
    ]);
    const container = document_.createElement('div');
    container.appendChild(fragment);
    expect(container.textContent).toBe('Вызовите cargo build.');
    expect(container.querySelector('code')?.textContent).toBe('cargo build');
  });

  it('survives a dropped closing marker without throwing', async () => {
    setup('<p><a href="/x">x</a></p>');
    const document_ = globalThis.document;
    const link = document_.querySelector('a')!;
    const { renderTranslation } = await apply();
    const fragment = renderTranslation('{{0}}метка', [
      { index: 0, element: link, opaque: false, innerHtml: 'x' },
    ]);
    expect(fragment.textContent).toBe('метка');
  });

  it('apply then revert restores the original markup exactly', async () => {
    setup('<div><p>Read the <a href="/guide">guide</a> now.</p></div>');
    const document_ = globalThis.document;
    const before = document_.body.innerHTML;
    const { extractItems } = await extract();
    const { applyBlock, revertBlocks } = await apply();
    const items = extractItems(options());
    const entry = applyBlock(
      { block: items[0].block!, nodes: items[0].nodes, slots: items[0].slots },
      items[0].segment.text,
      'Прочитайте {{0}}руководство{{/0}} сейчас.',
      'replace',
      true,
    );
    expect(document_.querySelectorAll('[data-lingo="translation"]').length).toBe(1);
    revertBlocks([entry!]);
    expect(document_.body.innerHTML).toBe(before);
  });
});

/**
 * Nested blocks were the root cause of "the page translates only sometimes": each segment
 * used to flatten its whole subtree, so a wrapper DIV and the paragraphs inside it produced
 * overlapping text, and applying the wrapper wiped the paragraph markup. These tests pin the
 * two invariants that fix it: segments never share a node, and applying one never deletes
 * markup that belongs to another.
 */
describe('nested blocks', () => {
  const PAGE = `
    <div id="doc">
      <div class="wrapper">Welcome to the documentation site for our product.
        <h2>Getting started</h2>
        <p>Install the package and run the command. <a href="/docs">Read more</a></p>
      </div>
    </div>`;

  it('gives the wrapper and the paragraphs disjoint segments', async () => {
    setup(PAGE);
    const { extractItems, filterTranslatable } = await extract();
    const items = filterTranslatable(extractItems(options()));
    expect(items.map((item) => item.segment.text)).toEqual([
      'Welcome to the documentation site for our product.',
      'Getting started',
      'Install the package and run the command. {{0}}Read more{{/0}}',
    ]);

    const seen = new Set<Node>();
    let shared = 0;
    for (const item of items) {
      for (const node of item.nodes) {
        if (seen.has(node)) shared++;
        seen.add(node);
      }
    }
    expect(shared).toBe(0);
  });

  it('keeps nested blocks in the DOM when the wrapper is translated', async () => {
    setup(PAGE);
    const document_ = globalThis.document;
    const { extractItems, filterTranslatable } = await extract();
    const { applyBlock } = await apply();
    const items = filterTranslatable(extractItems(options()));
    applyBlock(
      { block: items[0].block!, nodes: items[0].nodes, slots: items[0].slots },
      items[0].segment.text,
      'Добро пожаловать в документацию нашего продукта.',
      'replace',
      false,
    );
    expect(document_.querySelector('h2')).not.toBe(null);
    expect(document_.querySelector('a[href="/docs"]')).not.toBe(null);
    expect(document_.querySelector('h2')?.textContent).toBe('Getting started');
  });

  it('translates every segment of a nested page', async () => {
    setup(PAGE);
    const { extractItems, filterTranslatable } = await extract();
    const { applyBlock } = await apply();
    const items = filterTranslatable(extractItems(options()));
    const applied = items.map((item) =>
      applyBlock(
        { block: item.block!, nodes: item.nodes, slots: item.slots },
        item.segment.text,
        item.segment.text.replace(/[^\s{}0-9/]+/g, 'п'),
        'replace',
        false,
      ),
    );
    expect(applied.filter(Boolean).length).toBe(items.length);
  });

  it('reverts a nested page byte for byte', async () => {
    setup(PAGE);
    const document_ = globalThis.document;
    const before = document_.body.innerHTML;
    const { extractItems, filterTranslatable } = await extract();
    const { applyBlock, revertBlocks } = await apply();
    const items = filterTranslatable(extractItems(options()));
    const applied = [];
    for (const item of items) {
      const entry = applyBlock(
        { block: item.block!, nodes: item.nodes, slots: item.slots },
        item.segment.text,
        item.segment.text.replace(/[^\s{}0-9/]+/g, 'п'),
        'replace',
        false,
      );
      if (entry) applied.push(entry);
    }
    revertBlocks(applied);
    expect(document_.body.innerHTML).toBe(before);
  });

  it('never drops code blocks or images that sit between runs', async () => {
    setup(`
      <div><p>Intro text that will be translated.</p>
        <pre><code>let x = 1;</code></pre>
        <p>Middle text that will be translated.</p>
        <p><img src="/pic.png" alt=""></p>
        <p>Final text that will be translated.</p>
      </div>`);
    const document_ = globalThis.document;
    const { extractItems, filterTranslatable } = await extract();
    const { applyBlock } = await apply();
    const items = filterTranslatable(extractItems(options()));
    for (const item of items) {
      applyBlock(
        { block: item.block!, nodes: item.nodes, slots: item.slots },
        item.segment.text,
        item.segment.text.replace(/[^\s{}0-9/]+/g, 'п'),
        'replace',
        false,
      );
    }
    expect(document_.querySelector('pre code')?.textContent).toBe('let x = 1;');
    expect(document_.querySelector('img[src="/pic.png"]')).not.toBe(null);
  });

  it('splits a segment that exceeds the character limit', async () => {
    const sentence = 'This sentence is long enough to fill the budget quickly. ';
    setup(`<div><p>${sentence.repeat(60)}</p></div>`);
    const { extractItems, filterTranslatable, MAX_SEGMENT_CHARS } = await extract();
    const items = filterTranslatable(extractItems(options()));
    expect(items.length).toBeGreaterThan(1);
    for (const item of items) expect(item.segment.text.length).toBeLessThanOrEqual(MAX_SEGMENT_CHARS);
  });
  it('keeps an <svg> icon inside a translated run', async () => {
    // Elements in the SVG namespace report tagName in lower case ('svg'), so a
    // case-sensitive SLOT_TAGS lookup missed them and every icon was deleted with the run.
    setup(`<div><p>Reading time <span><svg viewBox="0 0 8 8"><use href="#clock"></use></svg>20 min</span></p></div>`);
    const document_ = globalThis.document;
    const { extractItems, filterTranslatable } = await extract();
    const { applyBlock } = await apply();
    const items = filterTranslatable(extractItems(options()));
    for (const item of items) {
      applyBlock(
        { block: item.block!, nodes: item.nodes, slots: item.slots },
        item.segment.text,
        item.segment.text.replace(/[^\s{}0-9/]+/g, 'п'),
        'replace',
        false,
      );
    }
    expect(document_.querySelector('use[href="#clock"]')).not.toBe(null);
  });

  it('does not delete an <input> wrapped in a label', async () => {
    setup(`<div><p><label><span>Choose</span><input type="checkbox"></label></p><p>Other text here.</p></div>`);
    const document_ = globalThis.document;
    const { extractItems, filterTranslatable } = await extract();
    const { applyBlock } = await apply();
    const items = filterTranslatable(extractItems(options()));
    for (const item of items) {
      applyBlock(
        { block: item.block!, nodes: item.nodes, slots: item.slots },
        item.segment.text,
        item.segment.text.replace(/[^\s{}0-9/]+/g, 'п'),
        'replace',
        false,
      );
    }
    expect(document_.querySelector('input[type="checkbox"]')).not.toBe(null);
  });

  it('renders a cover image inside a link exactly once', async () => {
    // A link that wraps media is restored verbatim: the middle of the answer only carries
    // its label, so re-rendering would duplicate the image and lose the link.
    setup(`<div><p>Read <a href="/post"><img src="/cover.jpg" alt="">How to build it</a> today.</p></div>`);
    const document_ = globalThis.document;
    const { extractItems, filterTranslatable } = await extract();
    const { applyBlock } = await apply();
    const items = filterTranslatable(extractItems(options()));
    for (const item of items) {
      applyBlock(
        { block: item.block!, nodes: item.nodes, slots: item.slots },
        item.segment.text,
        item.segment.text.replace(/[^\s{}0-9/]+/g, 'п'),
        'replace',
        false,
      );
    }
    expect(document_.querySelectorAll('img[src="/cover.jpg"]').length).toBe(1);
  });

  it('keeps bold text bold through a translation', async () => {
    setup(`<div><p>Read the <strong>very <a href="/x">important guide</a></strong> now.</p></div>`);
    const document_ = globalThis.document;
    const { extractItems, filterTranslatable } = await extract();
    const { applyBlock } = await apply();
    const items = filterTranslatable(extractItems(options()));
    expect(items.length).toBe(1);
    const item = items[0];
    applyBlock(
      { block: item.block!, nodes: item.nodes, slots: item.slots },
      item.segment.text,
      'Прочтите {{0}}очень {{1}}важный гид{{/1}}{{/0}} сейчас.',
      'replace',
      false,
    );
    const strong = document_.querySelector('strong');
    expect(strong).not.toBe(null);
    expect(strong?.querySelector('a[href="/x"]')?.textContent).toBe('важный гид');
  });
});
