import { describe, it, expect } from './helpers/framework';
import { JSDOM } from 'jsdom';
import { buildPrintPayload } from '../src/content/print';
import { normalizeSettings } from '../src/shared/settings';
import type { AppliedText } from '../src/content/apply';

/**
 * PDF payload construction.
 *
 * The bug this locks down: the print document used to receive the raw model answer, so a
 * saved PDF contained `{{0}}` markers where a link used to be. It now receives the rendered
 * text, which is what the reader actually sees.
 */
function setup(html: string) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url: 'https://example.com/page' });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  g.location = dom.window.location;
  g.Node = dom.window.Node;
  g.NodeFilter = dom.window.NodeFilter;
  g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  return dom;
}

const settings = normalizeSettings({ provider: 'deepseek', sourceLang: 'en', targetLang: 'ru' });

function entry(plainText: string, original: string): AppliedText {
  return {
    block: document.createElement('p'),
    container: document.createElement('span'),
    originalNodes: [],
    originalSpan: null,
    original,
    translated: original,
    plainText,
    attributes: [],
  };
}

describe('print payload', () => {
  it('prints the rendered text, never the slot markers', () => {
    setup('<p>x</p>');
    const payload = buildPrintPayload({
      settings,
      title: 'A Basic Component',
      url: 'https://book.leptos.dev/view/01_basic_component.html',
      host: 'book.leptos.dev',
      applied: [
        entry('Прочитайте руководство и вызовите cargo build.', 'Read the guide and call cargo build.'),
      ],
    });
    expect(payload.blocks.length).toBe(1);
    expect(payload.blocks[0].translated).toBe('Прочитайте руководство и вызовите cargo build.');
    expect(payload.blocks[0].translated).not.toContain('{{');
  });

  it('omits entries that carry no text (attribute-only translations)', () => {
    setup('<p>x</p>');
    const payload = buildPrintPayload({
      settings,
      title: 'T',
      url: 'https://example.com',
      host: 'example.com',
      applied: [entry('', 'alt text'), entry('Текст', 'Text')],
    });
    expect(payload.blocks.length).toBe(1);
    expect(payload.blocks[0].translated).toBe('Текст');
  });

  it('includes the original only when the option is on', () => {
    setup('<p>x</p>');
    const off = buildPrintPayload({
      settings,
      title: 'T',
      url: 'https://example.com',
      host: 'example.com',
      applied: [entry('Перевод', 'Original')],
    });
    expect(off.blocks[0].original).toBe(undefined);

    const on = normalizeSettings({ ...settings, pdf: { ...settings.pdf, includeOriginals: true } });
    const withOriginal = buildPrintPayload({
      settings: on,
      title: 'T',
      url: 'https://example.com',
      host: 'example.com',
      applied: [entry('Перевод', 'Original')],
    });
    expect(withOriginal.blocks[0].original).toBe('Original');
  });

  it('carries the page metadata and PDF options', () => {
    setup('<p>x</p>');
    const payload = buildPrintPayload({
      settings: normalizeSettings({ ...settings, pdf: { ...settings.pdf, pageSize: 'Letter', marginMm: 20 } }),
      title: 'Page title',
      url: 'https://example.com/a',
      host: 'example.com',
      applied: [entry('Текст', 'Text')],
    });
    expect(payload.title).toBe('Page title');
    expect(payload.url).toBe('https://example.com/a');
    expect(payload.pageSize).toBe('Letter');
    expect(payload.marginMm).toBe(20);
    expect(payload.targetLang).toBe('ru');
    expect(payload.dateText.length).toBeGreaterThan(4);
  });
});
