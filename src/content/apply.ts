/**
 * Applying translations to the DOM, and undoing it.
 *
 * A translated block is rendered from the model's answer, which keeps the `{{n}}…{{/n}}`
 * slots of the source. Each slot is replaced with a *clone of the original element*, so
 * links stay clickable, inline code stays clickable/copyable and images keep their source —
 * only the human-readable text changes. Slot content that must never be translated (code,
 * images) is restored verbatim from the original inner HTML.
 *
 * The original markup is stored on the injected node, so "show original" and revert are
 * lossless and instantaneous: no re-fetch, no re-extraction.
 */
import type { SlotInfo } from './extract';

export type ApplyMode = 'replace' | 'bilingual';

export interface AppliedAttribute {
  element: Element;
  name: string;
  original: string;
  translated: string;
}

export interface AppliedText {
  block: Element;
  /** The node we inserted (already holds the translation). */
  container: HTMLElement;
  /** Original children of the block, kept for a lossless revert. */
  originalNodes: Node[];
  /** Hidden sibling with the original text (when the user wants it). */
  originalSpan: HTMLElement | null;
  original: string;
  /** Raw answer, still containing `{{n}}` slot markers. */
  translated: string;
  /** Rendered text as the reader sees it (slots resolved, no markers). */
  plainText: string;
  attributes: AppliedAttribute[];
}

const ORIGINAL_CLASS = 'lingo-original-text';
const SLOT_RE = /\{\{(\/?)(\d+)\}\}/g;
const MARKER_RE = /\{\{\/?\d+\}\}/g;

/**
 * The reader-visible form of a segment text: slot markers removed, slot content kept.
 * `segment.text` carries `{{n}}…{{/n}}` so the model can place links; anywhere the user
 * looks at the source text (the "original" line, a bilingual pair, the PDF export) those
 * markers must not leak through.
 */
export function stripMarkers(text: string): string {
  return text.replace(MARKER_RE, '');
}

/** Parse the translated text into a DOM fragment, re-creating slots as cloned elements. */
export function renderTranslation(translated: string, slots: SlotInfo[]): DocumentFragment {
  const fragment = document.createDocumentFragment();
  // Stack of { slotIndex, targetNode } for nested slots.
  const stack: { index: number; node: Node }[] = [];

  const appendText = (text: string) => {
    if (!text) return;
    const target = stack.length > 0 ? stack[stack.length - 1].node : fragment;
    target.appendChild(document.createTextNode(text));
  };

  let lastIndex = 0;
  for (const match of translated.matchAll(SLOT_RE)) {
    appendText(translated.slice(lastIndex, match.index));
    lastIndex = (match.index ?? 0) + match[0].length;

    const closing = match[1] === '/';
    const slotIndex = Number(match[2]);
    const slot = slots[slotIndex];
    if (!slot) continue;

    if (closing) {
      // Pop back to (and including) the matching slot.
      const position = stack.map((entry) => entry.index).lastIndexOf(slotIndex);
      if (position >= 0) stack.length = position;
      continue;
    }

    const clone = slot.element.cloneNode(true) as Element;
    // Slots carry no extension state.
    clone.removeAttribute('data-lingo');

    if (slot.opaque) {
      // Opaque slots keep their exact original content (code, images).
      clone.innerHTML = slot.innerHtml;
      appendNode(clone);
      // No need to push: there is no closing marker content to fill in.
      continue;
    }

    // A translatable slot is mostly an empty shell: its label comes from the model, so the
    // original text must be dropped or the label would appear twice. Anything that is not
    // text — a cover image inside a link, an icon — is kept, because the answer carries no
    // way to reproduce it and dropping it deletes the picture from the page.
    const preserved = Array.from(clone.childNodes).filter(
      (child) => child.nodeType === Node.ELEMENT_NODE && !(child as Element).textContent?.trim(),
    );
    clone.replaceChildren(...preserved);
    appendNode(clone);
    stack.push({ index: slotIndex, node: clone });
  }
  appendText(translated.slice(lastIndex));

  function appendNode(node: Node) {
    const target = stack.length > 0 ? stack[stack.length - 1].node : fragment;
    target.appendChild(node);
  }

  return fragment;
}

/** Apply a translation: replace the segment's own nodes with the rendered answer. */
export function applyBlock(
  item: { block: Element; nodes: Node[]; slots: SlotInfo[] },
  original: string,
  translated: string,
  mode: ApplyMode,
  keepOriginal: boolean,
): AppliedText | null {
  const { block, nodes, slots } = item;
  if (!block.isConnected) return null;
  // A segment owns a run of sibling nodes. If an earlier translation already replaced
  // them (same run translated twice), there is nothing left to swap out.
  const anchor = nodes.find((node) => node.parentNode === block) ?? null;
  if (nodes.length > 0 && !anchor) return null;

  const container = document.createElement('span');
  container.className = 'lingo-translated';
  container.setAttribute('data-lingo', 'translation');
  container.setAttribute('data-lingo-original', stripMarkers(original));
  container.appendChild(renderTranslation(translated, slots));

  // The reader-visible text: slots resolved, no markers. This is what the PDF must contain.
  const plainText = (container.textContent ?? '').replace(/\s+/g, ' ').trim();

  // Swap the run in place: nested blocks that sit between the owned nodes stay untouched.
  if (anchor) {
    block.insertBefore(container, anchor);
    for (const node of nodes) {
      if (node.parentNode === block) block.removeChild(node);
    }
  } else {
    // An attribute-only or empty run: nothing to replace, so skip rather than destroy.
    return null;
  }

  let originalSpan: HTMLElement | null = null;
  if (keepOriginal || mode === 'bilingual') {
    originalSpan = document.createElement('span');
    originalSpan.className = mode === 'bilingual' ? `${ORIGINAL_CLASS} lingo-original-visible` : ORIGINAL_CLASS;
    originalSpan.setAttribute('data-lingo', 'original');
    // The source text, minus the slot markers the model uses to place links.
    originalSpan.textContent = stripMarkers(original);
    container.after(originalSpan);
  }

  return {
    block,
    container,
    originalNodes: nodes,
    originalSpan,
    original,
    translated,
    plainText,
    attributes: [],
  };
}

/** Translate an attribute (alt, title, placeholder, aria-label) in place. */
export function applyAttribute(
  element: Element,
  name: string,
  original: string,
  translated: string,
): AppliedAttribute | null {
  if (!element.isConnected) return null;
  if (!element.hasAttribute(`data-lingo-orig-${name}`)) {
    element.setAttribute(`data-lingo-orig-${name}`, original);
  }
  element.setAttribute(name, translated);
  return { element, name, original, translated };
}

/** Restore every touched block and attribute. */
export function revertBlocks(applied: AppliedText[]): void {
  // Reverse order: segments of one block are reverted independently, newest run first.
  for (const entry of applied.slice().reverse()) {
    // Attribute-only entries reuse the element itself as `container`; never remove those.
    const isTranslation = entry.container.getAttribute?.('data-lingo') === 'translation';
    if (isTranslation && entry.container.isConnected && entry.originalNodes.length > 0) {
      // Put the original run back exactly where the translation was inserted; nested blocks
      // and any other translated runs in the same block are left alone.
      entry.container.before(...entry.originalNodes);
    }
    entry.originalSpan?.remove();
    if (isTranslation) entry.container.remove();
    for (const attribute of entry.attributes) {
      if (!attribute.element.isConnected) continue;
      attribute.element.setAttribute(attribute.name, attribute.original);
      attribute.element.removeAttribute(`data-lingo-orig-${attribute.name}`);
    }
  }
}

/** Switch every injected block between "translation" and "original". */
export function setShowingOriginal(showingOriginal: boolean): void {
  document.documentElement.classList.toggle('lingo-show-original', showingOriginal);
}

export function isShowingOriginal(): boolean {
  return document.documentElement.classList.contains('lingo-show-original');
}

/** Count of injected translation containers currently in the document. */
export function countApplied(): number {
  return document.querySelectorAll('[data-lingo="translation"]').length;
}

/**
 * Page-level CSS for the original/translation switch and the bilingual layout.
 * Everything else inherits the site's own typography — the extension must look invisible.
 */
export const PAGE_STYLES = `
html.lingo-show-original .lingo-translated[data-lingo="translation"] { display: none !important; }
html.lingo-show-original .lingo-original-text { display: block !important; }
.lingo-original-text { display: none; color: inherit; }
.lingo-original-text.lingo-original-visible { display: block !important; }
html.lingo-show-original .lingo-original-text::before,
.lingo-original-text.lingo-original-visible::before {
  content: "";
  display: block;
  border-top: 1px dashed currentColor;
  opacity: .22;
  margin: .3em 0;
}
.lingo-original-text.lingo-original-visible {
  margin-top: .35em;
  font-size: .94em;
  opacity: .82;
}
.lingo-translated a, .lingo-translated code { color: inherit; }
`;
