/**
 * Page translation engine.
 *
 * Owns the lifecycle of one run: extract → request in chunks → apply → allow revert.
 * Chunk requests go through the service worker (which owns the cache and the API keys), so
 * the content script never sees a key. Every state change is also reported to the worker
 * so the popup can show progress without polling the page.
 */
import type { PageState, RuntimeResponse, TranslateResponse } from '../shared/messaging';
import { sendToBackground, sendToTab } from '../shared/messaging';
import type { Settings } from '../shared/settings';
import { isHostExcluded } from '../shared/settings';
import { errorText, t } from '../shared/i18n';
import type { Segment } from '../shared/types';
import { chunk, chunkByBudget } from '../core/pool';
import { providerPreset } from '../shared/providers';
import { extractItems, filterTranslatable, type ExtractedItem } from './extract';
import { applyAttribute, applyBlock, revertBlocks, setShowingOriginal, type AppliedText } from './apply';
import { TranslationPanel } from './panel';
import { translateSelection } from './selection';
import { openPrintView } from './print';

export class PageTranslator {
  private settings: Settings;
  private panel: TranslationPanel | null = null;
  private applied: AppliedText[] = [];
  private items = new Map<number, ExtractedItem>();
  private abort: AbortController | null = null;
  private showingOriginal = false;
  private notifiedAt = 0;
  private state: PageState = {
    supported: true,
    phase: 'idle',
    total: 0,
    done: 0,
    failed: 0,
    showingOriginal: false,
  };

  constructor(settings: Settings) {
    this.settings = settings;
  }

  updateSettings(settings: Settings): void {
    this.settings = settings;
    this.panel?.setLang(settings.uiLang);
  }

  getState(): PageState {
    return { ...this.state, showingOriginal: this.showingOriginal, provider: this.settings.provider };
  }

  private setState(patch: Partial<PageState>): void {
    this.state = { ...this.state, ...patch };
    const snapshot = this.getState();
    this.panel?.render(snapshot);
    void sendToBackground({ type: 'REPORT_STATE', state: snapshot }).catch(() => undefined);
    this.notifyCompletion(snapshot);
  }

  /**
   * Tell the user the work is over even if they scrolled away and the panel is off-screen.
   * Uses the Notification API only when the page was slow enough that the user may have
   * moved on, and never asks for permission on its own.
   */
  private notifyCompletion(snapshot: PageState): void {
    if (snapshot.phase !== 'done') return;
    if (snapshot.total < 40) return;
    if (this.notifiedAt && Date.now() - this.notifiedAt < 10_000) return;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    this.notifiedAt = Date.now();
    try {
      new Notification(t(this.settings.uiLang, 'app.name'), {
        body: t(this.settings.uiLang, 'popup.done', { count: snapshot.total }),
        silent: true,
      });
    } catch {
      /* notifications may be unavailable in this context */
    }
  }

  private ensurePanel(): TranslationPanel {
    // A single-page app can wipe the body the panel lives in; rebuild it instead of keeping
    // a reference to a detached host, which would swallow every status update.
    if (this.panel) {
      if (this.panel.isConnected()) return this.panel;
      this.panel = null;
    }
    this.panel = new TranslationPanel(this.settings.uiLang, {
      onStop: () => this.stop(),
      onToggleOriginal: () => this.toggleOriginal(),
      onPdf: () => void this.exportPdf(),
      onRetry: () => void this.translatePage(),
      onClose: () => this.destroyPanel(),
    });
    this.panel.render(this.getState());
    return this.panel;
  }

  destroyPanel(): void {
    this.panel?.destroy();
    this.panel = null;
  }

  /** Translate the whole page. Re-running replaces the previous translation. */
  async translatePage(overrides: { sourceLang?: string; targetLang?: string } = {}): Promise<void> {
    const host = location.hostname;
    if (isHostExcluded(host, this.settings)) {
      this.ensurePanel();
      this.setState({ phase: 'error', error: t(this.settings.uiLang, 'popup.siteExcluded') });
      return;
    }

    // A second run must not race the first: the context menu, the keyboard shortcut and the
    // popup can all fire while a translation is in flight, and two runs would apply their
    // results on top of each other.
    if (this.state.phase === 'extracting' || this.state.phase === 'translating') {
      this.abort?.abort();
    }

    if (this.applied.length > 0) this.revert();

    const sourceLang = overrides.sourceLang ?? this.settings.sourceLang;
    const targetLang = overrides.targetLang ?? this.settings.targetLang;

    this.ensurePanel();
    this.setState({ phase: 'extracting', total: 0, done: 0, failed: 0, error: undefined, sourceLang, targetLang });

    // Keep the run's own controller: a second run replaces `this.abort`, and the loop below
    // must keep watching the signal it started with.
    const controller = new AbortController();
    this.abort = controller;

    const extracted = extractItems({
      translateAttributes: this.settings.translateAttributes,
      translateCodeBlocks: this.settings.translateCode,
      translateCodeComments: this.settings.translateCodeComments,
      skipBoilerplate: this.settings.skipBoilerplate,
    });
    const items = filterTranslatable(extracted);

    this.items = new Map(items.map((item) => [item.segment.id, item]));

    if (items.length === 0) {
      this.setState({ phase: 'done', total: 0, done: 0, notice: t(this.settings.uiLang, 'popup.noText') });
      return;
    }

    this.setState({ phase: 'translating', total: items.length, done: 0 });

    // Detect the source language once, on a representative sample, before translating:
    // the model can do better than a sentence-level guess, but naming the language in every
    // request is cheaper and keeps the style consistent across chunks.
    let effectiveSource = sourceLang;
    if (sourceLang === 'auto') {
      const sample = items
        .slice(0, 30)
        .map((item) => item.segment.text)
        .join(' ')
        .slice(0, 2000);
      const detected = await sendToBackground<{ lang: string; confidence: number }>({
        type: 'DETECT_LANGUAGE',
        text: sample,
      });
      if (detected.ok && detected.data.lang && detected.data.lang !== targetLang) {
        effectiveSource = detected.data.lang;
        this.setState({ sourceLang: effectiveSource });
      }
    }

    const segments = items.map((item) => item.segment);
    const size = Math.max(1, this.settings.chunkSize);
    // Some services cap a request at a few thousand characters (MyMemory: 500). Ignoring that
    // limit is what made long articles fail while book pages, split into short paragraphs,
    // worked — so batch by count *and* by the provider's documented budget.
    const budget = providerPreset(this.settings.provider).maxChunkChars;
    const batches = budget ? chunkByBudget(segments, size, budget) : chunk(segments, size);
    let done = 0;
    let failed = 0;

    for (const batch of batches) {
      if (controller.signal.aborted) break;

      const response: RuntimeResponse<TranslateResponse> = await sendToBackground<TranslateResponse>({
        type: 'TRANSLATE',
        payload: {
          segments: batch,
          // When the page is already in the target language, say so instead of asking the
          // model to translate ru → ru and hoping it returns the text unchanged.
          sourceLang: effectiveSource,
          targetLang,
          pageTitle: document.title,
          pageHost: host,
        },
      });

      if (!response.ok) {
        this.setState({
          phase: 'error',
          error: errorText(this.settings.uiLang, response.error.code, response.error.message),
        });
        return;
      }

      const result = response.data;
      const byId = new Map<number, string>();
      batch.forEach((segment, index) => byId.set(segment.id, result.texts[index] ?? segment.text));

      this.applyBatch(byId);
      done += batch.length;
      failed += result.failedCount ?? 0;
      this.setState({ done, failed });
    }

    if (controller.signal.aborted) {
      // A newer run owns the page now; leave the state alone instead of overwriting it.
      if (this.abort === controller) this.setState({ phase: 'stopped' });
      return;
    }
    if (this.abort === controller) this.setState({ phase: 'done', done, failed });
  }

  private applyBatch(byId: Map<number, string>): void {
    for (const [id, translated] of byId) {
      const item = this.items.get(id);
      if (!item || !translated || translated === item.segment.text) continue;

      if (item.attributes.length > 0) {
        for (const attribute of item.attributes) {
          const applied = applyAttribute(attribute.element, attribute.name, item.segment.text, translated);
          if (!applied) continue;
          this.applied.push({
            block: attribute.element,
            container: attribute.element as HTMLElement,
            originalNodes: [],
            originalSpan: null,
            original: item.segment.text,
            translated,
            plainText: translated,
            attributes: [applied],
          });
        }
        continue;
      }

      if (!item.block) continue;
      const applied = applyBlock(
        { block: item.block, nodes: item.nodes, slots: item.slots },
        item.segment.text,
        translated,
        this.settings.displayMode,
        this.settings.keepOriginal,
      );
      if (applied) this.applied.push(applied);
    }
    if (this.showingOriginal) setShowingOriginal(true);
  }

  revert(): void {
    revertBlocks(this.applied);
    this.applied = [];
    this.showingOriginal = false;
    setShowingOriginal(false);
  }

  stop(): void {
    this.abort?.abort();
    this.setState({ phase: 'stopped' });
  }

  toggleOriginal(): void {
    this.showingOriginal = !this.showingOriginal;
    setShowingOriginal(this.showingOriginal);
    this.setState({});
  }

  async translateSelection(): Promise<void> {
    const panel = this.ensurePanel();
    await translateSelection(this.settings, (patch) => {
      this.setState(patch);
      panel.render(this.getState());
    });
  }

  async exportPdf(): Promise<void> {
    if (this.applied.length === 0) {
      this.setState({ phase: this.state.phase, error: t(this.settings.uiLang, 'popup.nothingToPrint') });
      return;
    }
    await openPrintView({
      settings: this.settings,
      title: document.title,
      url: location.href,
      host: location.hostname,
      applied: this.applied,
    });
  }
}

/** Translate a DOM fragment (used by the selection bubble). */
export function segmentsFromScope(scope: Element | DocumentFragment): Segment[] {
  return filterTranslatable(
    extractItems({
      translateAttributes: false,
      translateCodeBlocks: false,
      translateCodeComments: true,
      skipBoilerplate: false,
      root: scope,
    }),
  ).map((item) => item.segment);
}

export { sendToTab };
