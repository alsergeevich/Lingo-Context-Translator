import { describe, it, expect } from './helpers/framework';
import { JSDOM } from 'jsdom';

/**
 * Slot markers must never reach the reader.
 *
 * `segment.text` carries `{{n}}…{{/n}}` around links and inline code so the model can place
 * them. The rendered translation resolves them into cloned elements — but the *original*
 * line, shown by "Показать оригинал", the bilingual layout and the PDF export, used to keep
 * them raw, so a page could display `Press {{0}}left{{/0}} or {{1}}right{{/1}} to navigate`.
 */
function setup(html: string) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: 'https://example.com/page' });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  g.location = dom.window.location;
  g.Node = dom.window.Node;
  g.Element = dom.window.Element;
  g.NodeFilter = dom.window.NodeFilter;
  g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  return dom;
}

const EXTRACT_OPTS = {
  translateAttributes: true,
  translateCodeBlocks: false,
  translateCodeComments: true,
  skipBoilerplate: true,
};

describe('slot markers never reach the reader', () => {
  it('strips markers from a text segment', async () => {
    const apply = await import('../src/content/apply.ts');
    expect(apply.stripMarkers('Press {{0}}left{{/0}} or {{1}}right{{/1}} now')).toBe(
      'Press left or right now',
    );
    expect(apply.stripMarkers('no markers here')).toBe('no markers here');
  });

  it('keeps markers out of the hidden original line', async () => {
    setup('<p>Press <a href="/1">left</a> or <a href="/2">right</a> to navigate.</p>');
    const { extractItems, filterTranslatable } = await import('../src/content/extract.ts');
    const { applyBlock } = await import('../src/content/apply.ts');

    const items = filterTranslatable(extractItems(EXTRACT_OPTS));
    const item = items[0];
    const block = item.block;
    if (!block) throw new Error('no block element for the segment');
    applyBlock(
      { block, nodes: item.nodes, slots: item.slots },
      item.segment.text,
      'Нажмите {{0}}влево{{/0}} или {{1}}вправо{{/1}}, чтобы перейти.',
      'replace',
      true,
    );

    const original = document.querySelector('.lingo-original-text');
    expect(original !== null).toBe(true);
    expect(/\{\{\/?\d+\}\}/.test(original?.textContent ?? '')).toBe(false);
    expect(original?.textContent).toBe('Press left or right to navigate.');
  });

  it('keeps markers out of the translation itself', async () => {
    setup('<p>Press <a href="/1">left</a> or <a href="/2">right</a> to navigate.</p>');
    const { extractItems, filterTranslatable } = await import('../src/content/extract.ts');
    const { applyBlock } = await import('../src/content/apply.ts');

    const items = filterTranslatable(extractItems(EXTRACT_OPTS));
    const item = items[0];
    const block = item.block;
    if (!block) throw new Error('no block element for the segment');
    const applied = applyBlock(
      { block, nodes: item.nodes, slots: item.slots },
      item.segment.text,
      'Нажмите {{0}}влево{{/0}} или {{1}}вправо{{/1}}, чтобы перейти.',
      'replace',
      true,
    );

    expect(/\{\{\/?\d+\}\}/.test(applied?.plainText ?? '')).toBe(false);
    expect(applied?.plainText).toBe('Нажмите влево или вправо, чтобы перейти.');
    // The links survive as real elements.
    expect(document.querySelectorAll('.lingo-translated a').length).toBe(2);
  });

  it('keeps markers out of the data-lingo-original attribute', async () => {
    setup('<p>Press <a href="/1">left</a> or <a href="/2">right</a> to navigate.</p>');
    const { extractItems, filterTranslatable } = await import('../src/content/extract.ts');
    const { applyBlock } = await import('../src/content/apply.ts');

    const items = filterTranslatable(extractItems(EXTRACT_OPTS));
    const item = items[0];
    const block = item.block;
    if (!block) throw new Error('no block element for the segment');
    applyBlock(
      { block, nodes: item.nodes, slots: item.slots },
      item.segment.text,
      'Нажмите {{0}}влево{{/0}} или {{1}}вправо{{/1}}, чтобы перейти.',
      'replace',
      true,
    );

    // The attribute is what a page's own scripts or a "view source" would show.
    const raw = document.querySelector('.lingo-translated')?.getAttribute('data-lingo-original') ?? '';
    expect(/\{\{\/?\d+\}\}/.test(raw)).toBe(false);
    expect(raw).toBe('Press left or right to navigate.');
  });

  it('strips markers from the PDF source line', async () => {
    setup('<p>x</p>');
    const { buildPrintPayload } = await import('../src/content/print.ts');
    const { normalizeSettings } = await import('../src/shared/settings.ts');
    const settings = normalizeSettings({
      provider: 'deepseek',
      sourceLang: 'en',
      targetLang: 'ru',
      pdf: { includeOriginals: true },
    });

    const payload = buildPrintPayload({
      settings,
      title: 'T',
      url: 'https://example.com',
      postHost: undefined,
      host: 'example.com',
      applied: [
        {
          block: document.createElement('p'),
          container: document.createElement('span'),
          originalNodes: [],
          originalSpan: null,
          original: 'Press {{0}}left{{/0}} to navigate',
          translated: 'Нажмите {{0}}влево{{/0}}',
          plainText: 'Нажмите влево',
          attributes: [],
        },
      ],
    } as never);

    expect(payload.blocks.length).toBe(1);
    expect(/\{\{\/?\d+\}\}/.test(payload.blocks[0].original ?? '')).toBe(false);
    expect(payload.blocks[0].original).toBe('Press left to navigate');
  });
});
