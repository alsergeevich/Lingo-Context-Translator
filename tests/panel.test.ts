import { describe, it, expect } from './helpers/framework';
import { JSDOM } from 'jsdom';

/**
 * The panel is the only feedback surface while a page translates. It used to print
 * "Готово: 0 фрагментов" for a page with no text, or for an excluded site, because
 * `PageState.notice` was never rendered — which is exactly what "the button does nothing"
 * looked like to a user.
 */
function setup() {
  const dom = new JSDOM('<!doctype html><html><body><p>page</p></body></html>', { url: 'https://example.com/' });
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.document = dom.window.document;
  g.location = dom.window.location;
  g.Node = dom.window.Node;
  g.HTMLElement = dom.window.HTMLElement;
  g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  return dom;
}

const baseState = {
  supported: true,
  phase: 'done' as const,
  total: 0,
  done: 0,
  failed: 0,
  showingOriginal: false,
};

describe('panel notices', () => {
  it('shows a notice instead of "Done: 0 segments"', async () => {
    setup();
    const { TranslationPanel } = await import('../src/content/panel');
    const handlers = { onStop() {}, onToggleOriginal() {}, onPdf() {}, onRetry() {}, onClose() {} };
    const panel = new TranslationPanel('ru', handlers);
    panel.render({ ...baseState, notice: 'На странице нет текста для перевода' });
    expect(panel.snapshotText()).toContain('На странице нет текста для перевода');
    expect(panel.snapshotText()).not.toContain('Готово: 0 фрагментов');
    panel.destroy();
  });

  it('reports when it is no longer attached', async () => {
    setup();
    const { TranslationPanel } = await import('../src/content/panel');
    const handlers = { onStop() {}, onToggleOriginal() {}, onPdf() {}, onRetry() {}, onClose() {} };
    const panel = new TranslationPanel('ru', handlers);
    expect(panel.isConnected()).toBe(true);
    (document.body as unknown as { replaceChildren(...n: unknown[]): void }).replaceChildren();
    expect(panel.isConnected()).toBe(false);
  });
});
