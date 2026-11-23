/**
 * Text extraction from the live DOM.
 *
 * The hard part of page translation is not the API call but deciding *what* to send:
 *
 *  - skip non-rendered, non-textual and code-bearing elements;
 *  - group text nodes into paragraph-level blocks so the model sees whole sentences and
 *    inline markup never splits a sentence;
 *  - represent links, images and inline code inside a paragraph as `{{n}}…{{/n}}` slots, so
 *    the translation can put a *live* link back where the model placed that slot. Content of
 *    inline code slots is never sent to the model — it is restored byte for byte;
 *  - keep navigation/footer boilerplate out when the user asks for it;
 *  - translate a few attributes (alt, title, placeholder, aria-label) when enabled;
 *  - never touch elements the extension itself injected.
 */
import type { Segment } from '../shared/types';

export interface ExtractionOptions {
  translateAttributes: boolean;
  translateCodeBlocks: boolean;
  translateCodeComments: boolean;
  skipBoilerplate: boolean;
  /** Restrict extraction to this subtree (selection translation). */
  root?: Element | DocumentFragment | null;
  /** Optional cap on how many segments to produce. */
  maxSegments?: number;
}

/** One inline slot inside a paragraph. */
export interface SlotInfo {
  /** 0-based index used in the `{{n}}` markers. */
  index: number;
  /** Element to clone when the translation is applied. */
  element: Element;
  /** True when the slot's own text must never be translated (code, images). */
  opaque: boolean;
  /** Original inner HTML, restored verbatim for opaque slots. */
  innerHtml: string;
}

export interface ExtractedItem {
  segment: Segment;
  /** The block-level element this segment belongs to (heading context, revert bookkeeping). */
  block: Element | null;
  /**
   * The exact child nodes of `block` that this segment owns — a maximal run of inline
   * content between two nested blocks. Only these nodes are replaced when the translation
   * is applied, so nested blocks keep their own markup and their own translations.
   * Empty for attribute-only items.
   */
  nodes: Node[];
  /** Inline slots referenced by the segment text. */
  slots: SlotInfo[];
  /** Attribute carriers: element + attribute name. */
  attributes: { element: Element; name: string }[];
  /** The segment sits inside a code block. */
  isCode?: boolean;
}

/** Tags represented as slots instead of flattened text. */
const SLOT_TAGS = new Set(['A', 'IMG', 'BR', 'WBR', 'CODE', 'KBD', 'SAMP', 'VAR', 'ABBR', 'SUB', 'SUP', 'BUTTON', 'PICTURE', 'SVG',
  'B', 'STRONG', 'I', 'EM', 'U', 'S', 'DEL', 'INS', 'MARK', 'SMALL', 'CITE', 'Q', 'TIME']);

/** Slot tags whose content must never be translated. */
const OPAQUE_SLOT_TAGS = new Set(['CODE', 'KBD', 'SAMP', 'VAR', 'IMG', 'BR', 'WBR', 'PICTURE', 'SVG']);

/**
 * Media that cannot be re-created from a model answer. A link that wraps one (a card with a
 * cover image) is restored verbatim instead of being re-rendered, because the answer only
 * carries its label — and the nested image would otherwise be rendered twice, once as the
 * label's sibling and once as its own slot.
 */
const MEDIA_TAGS = new Set(['IMG', 'PICTURE', 'SVG', 'VIDEO', 'AUDIO', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'INPUT', 'SELECT']);

const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'CANVAS', 'SVG', 'MATH', 'VIDEO', 'AUDIO',
  'TEXTAREA', 'INPUT', 'SELECT', 'OPTION', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'BASE', 'TITLE',
  'PRE', 'CODE', 'KBD', 'SAMP', 'VAR', 'TT',
]);

const BOILERPLATE_SELECTORS = [
  'nav', 'footer', 'aside', '[role="navigation"]', '[role="banner"]', '[role="contentinfo"]',
  '.nav', '.navbar', '.menu', '.footer', '.sidebar', '.breadcrumb', '.breadcrumbs', '.pagination',
  '.cookie', '.cookies', '.cookie-banner', '.gdpr', '.advert', '.advertisement', '.ads',
  '.share', '.social', '.newsletter', '.subscribe',
];

export const LINGO_ATTR = 'data-lingo';

/**
 * Elements that own a sentence/paragraph. Inline elements are deliberately absent: their
 * text must belong to the surrounding block, otherwise a sentence with a link inside would
 * be split into fragments and translated badly.
 */
const BLOCK_TAGS = new Set([
  'P', 'DIV', 'LI', 'TD', 'TH', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'FIGCAPTION',
  'DT', 'DD', 'ARTICLE', 'SECTION', 'HEADER', 'MAIN', 'SUMMARY', 'CAPTION', 'BUTTON',
  'FORM', 'FIELDSET', 'ADDRESS', 'TABLE', 'UL', 'OL', 'DL', 'TR', 'NAV', 'ASIDE', 'FOOTER',
]);

const MIN_SEGMENT_LENGTH = 2;
export const MAX_SEGMENT_CHARS = 1800;

export function cleanText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Uppercased tag name for set lookups.
 *
 * HTML elements already report `tagName` in upper case, but elements in other namespaces do
 * not: an `<svg>` reports `'svg'`, so a plain `SLOT_TAGS.has(tagName)` never matched it and
 * every icon was flattened into the surrounding text run — and deleted with it.
 */
export function tagNameOf(element: Element): string {
  return (element.tagName || '').toUpperCase();
}

function isVisible(el: Element): boolean {
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  return style.opacity !== '0';
}

const SKIP_SELECTORS = ['[aria-hidden="true"]', '[hidden]', '[data-lingo-ignore]', '.lingo-panel', '.lingo-bubble'];

function isExcluded(el: Element): boolean {
  for (const selector of SKIP_SELECTORS) {
    try {
      if (el.closest(selector)) return true;
    } catch {
      /* malformed selector in an exotic document */
    }
  }
  return false;
}

function matchesBoilerplate(el: Element): boolean {
  for (const selector of BOILERPLATE_SELECTORS) {
    try {
      if (el.closest(selector)) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

/** Heading that introduces the element, used as segment context. */
function headingContext(el: Element): string {
  let node: Element | null = el;
  while (node) {
    let previous: Element | null = node.previousElementSibling;
    while (previous) {
      if (/^H[1-6]$/.test(previous.tagName)) return cleanText(previous.textContent ?? '').slice(0, 160);
      previous = previous.previousElementSibling;
    }
    node = node.parentElement;
    if (node && /^H[1-6]$/.test(node.tagName)) return cleanText(node.textContent ?? '').slice(0, 160);
  }
  return '';
}

export function looksLikeCode(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  if (/^[{}()[\];<>=+\-*/%&|^~!?:.,\s]+$/.test(trimmed)) return true;
  const signals = [/=>/, /::/, /\bfn\s+\w+\s*\(/, /\bdef\s+\w+\s*\(/, /;\s*$/m, /\bconst\s+\w+\s*=/, /\bimport\s+.*\bfrom\b/];
  return signals.some((re) => re.test(trimmed));
}

function insideCode(node: Node): boolean {
  return !!node.parentElement?.closest('pre, code, kbd, samp, var, tt');
}

/** A code comment — slashes, hashes, block and HTML style. */
export function looksLikeComment(text: string): boolean {
  return /^(\/\/|#|\/\*|\*|<!--|--)/.test(text.trim());
}

/**
 * Should this text node be sent to the model?
 *
 * `allowSlots` is true while building a paragraph: text inside links is translatable
 * (their label must be translated), but text inside code slots is not.
 */
function isTranslatableText(node: Text, opts: ExtractionOptions, inSlot: string | null): boolean {
  const text = node.nodeValue ?? '';
  if (cleanText(text).length < MIN_SEGMENT_LENGTH) return false;
  const parent = node.parentElement;
  if (!parent) return false;
  if (isExcluded(parent)) return false;

  if (inSlot === 'opaque') return false;

  const code = insideCode(node);
  if (code && !opts.translateCodeBlocks) return false;
  if (code) {
    if (!opts.translateCodeComments) return false;
    if (!looksLikeComment(text)) return false;
  }
  if (SKIP_TAGS.has(tagNameOf(parent))) return false;
  if (!isVisible(parent)) return false;
  if (opts.skipBoilerplate && matchesBoilerplate(parent)) return false;
  return true;
}

interface BuiltText {
  text: string;
  slots: SlotInfo[];
}

/**
 * Render one run of sibling nodes as a single string, replacing inline slots with
 * `{{n}}…{{/n}}` markers.
 *
 * `blocks` holds every element that owns a segment of its own. Such an element is never
 * descended into: its text belongs to its own segment. That is what keeps segments
 * disjoint — a segment owns only the inline content *between* two nested blocks, so
 * replacing it cannot destroy the nested block's markup.
 */
function buildRunText(nodes: Node[], opts: ExtractionOptions, blocks: Set<Element>): BuiltText {
  const slots: SlotInfo[] = [];
  let out = '';

  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.nodeValue ?? '';
      const parent = node.parentElement;
      if (!parent) return;
      if (cleanText(text).length < MIN_SEGMENT_LENGTH) return;
      if (isExcluded(parent)) return;
      // A code element that is *not* being marked as a slot: never send it.
      if (insideCode(node)) return;
      if (!isVisible(parent)) return;
      if (opts.skipBoilerplate && matchesBoilerplate(parent)) return;
      out += text.replace(/\s+/g, ' ');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    const element = node as Element;
    if (isExcluded(element)) return;
    // Another segment's block: its text is extracted separately.
    if (blocks.has(element)) return;

    if (SLOT_TAGS.has(tagNameOf(element))) {
      const opaque = OPAQUE_SLOT_TAGS.has(tagNameOf(element));
      const index = slots.length;
      slots.push({ index, element, opaque, innerHtml: element.innerHTML });
      out += `{{${index}}}`;
      // A translatable slot contributes its own label; an opaque one contributes nothing,
      // because its content is restored verbatim from the original element. Media inside a
      // translatable slot is skipped here: the rendered clone keeps it as it is, and sending
      // it as a child slot too would draw the image twice.
      if (!opaque) {
        for (const child of Array.from(element.childNodes)) {
          if (child.nodeType === Node.ELEMENT_NODE && holdsMedia(child as Element)) continue;
          visit(child);
        }
      }
      out += `{{/${index}}}`;
      return;
    }

    for (const child of Array.from(element.childNodes)) visit(child);
  };

  for (const node of nodes) visit(node);
  return { text: cleanText(out), slots };
}

/**
 * Split one over-long text node into word-aligned pieces. Portals send paragraphs far
 * longer than any provider accepts (a single `<div>` page produced a 22 755-character
 * segment), and an over-limit request comes back as HTTP 400 — the page then simply does
 * not translate. The pieces stay in the same place, so the rendered page is unchanged.
 */
function splitTextNode(node: Text, limit: number): Node[] {
  const value = node.nodeValue ?? '';
  if (value.length <= limit) return [node];
  const parts: string[] = [];
  let rest = value;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf(' ', limit);
    if (cut < Math.floor(limit / 2)) cut = limit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  parts.push(rest);
  const replacement = parts.map((part) => document.createTextNode(part));
  node.replaceWith(...replacement);
  return replacement;
}

/** Character count of all text inside a node, used to keep a segment under the limit. */
function textLength(node: Node): number {
  if (node.nodeType === Node.TEXT_NODE) return (node.nodeValue ?? '').length;
  return ((node as Element).textContent ?? '').length;
}

/**
 * True when the subtree holds an element that owns a segment of its own. Such markup must
 * stay in the DOM: a run is replaced by freshly rendered text, and a slot's label replaces
 * its children, so anything nested inside would be destroyed.
 */
function containsOwner(element: Element, owners: Set<Element>): boolean {
  for (const child of Array.from(element.children)) {
    if (owners.has(child)) return true;
    if (containsOwner(child, owners)) return true;
  }
  return false;
}

/**
 * True when this element is media, or wraps it at any depth.
 *
 * Media is preserved inside a translated slot by the rendered clone (its non-text children
 * are kept), so it must not also be emitted as a nested slot — the answer would then draw
 * the same image twice, once from the clone and once from the marker.
 */
function holdsMedia(element: Element): boolean {
  if (MEDIA_TAGS.has(tagNameOf(element))) return true;
  for (const child of Array.from(element.children)) {
    if (holdsMedia(child)) return true;
  }
  return false;
}

/**
 * True when the subtree holds content that a translated run cannot reproduce.
 *
 * A run is replaced by freshly rendered text, so anything that is not prose or an inline
 * slot — an `<input>` inside a `<label>`, a sprite, an embed — must be left alone instead of
 * being flattened away.
 */
function containsOpaque(element: Element): boolean {
  for (const child of Array.from(element.children)) {
    const name = tagNameOf(child);
    if (!SLOT_TAGS.has(name) && SKIP_TAGS.has(name)) return true;
    if (containsOpaque(child)) return true;
  }
  return false;
}

/**
 * True when this node must stay in the DOM untouched and therefore ends a segment run.
 *
 * A run is replaced as a unit, so anything that is not inline prose would be *deleted* if it
 * sat inside one: a nested block the extractor did not pick up (an image-only paragraph, a
 * hidden section), a code block, a boilerplate box. Only inline content belongs to a run.
 */
function breaksRun(node: Node, opts: ExtractionOptions, owners: Set<Element>): boolean {
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const element = node as Element;
  if (isExcluded(element)) return true;
  // An inline slot is cloned back as an element, so it can stay inside a run — unless it
  // wraps a nested block, whose markup the clone would lose.
  const name = tagNameOf(element);
  if (SLOT_TAGS.has(name)) return containsOwner(element, owners);
  if (SKIP_TAGS.has(name)) return true;
  if (BLOCK_TAGS.has(name)) return true;
  if (!isVisible(element)) return true;
  if (opts.skipBoilerplate && matchesBoilerplate(element)) return true;
  // Any other wrapper is flattened into the run's text. That is fine for a shell that holds
  // only prose (its words survive), but not for one that holds an input, an icon font, an
  // embedded frame: those would be deleted along with the run.
  return containsOwner(element, owners) || containsOpaque(element);
}

/**
 * Turn one run of sibling nodes into segments of at most `limit` characters, keeping every
 * node consecutive so the run can be replaced and restored as one unit.
 */
function groupRun(nodes: Node[], limit: number): Node[][] {
  const groups: Node[][] = [];
  let current: Node[] = [];
  let length = 0;
  const flush = () => {
    if (current.length > 0) groups.push(current);
    current = [];
    length = 0;
  };

  for (const node of nodes) {
    const pieces =
      node.nodeType === Node.TEXT_NODE && (node.nodeValue ?? '').length > limit
        ? splitTextNode(node as Text, limit)
        : [node];
    for (const piece of pieces) {
      const pieceLength = textLength(piece);
      if (current.length > 0 && length + pieceLength > limit) flush();
      current.push(piece);
      length += pieceLength;
    }
  }
  flush();
  return groups;
}

/**
 * Collect translatable items in document order.
 *
 * A segment is one maximal run of inline content inside a block-level element — the text
 * *between* two nested blocks, never the text of the whole subtree. Each run carries
 * `{{n}}` slots for its inline links, images and inline code, and owns exactly the nodes it
 * was built from, so applying a translation leaves nested blocks (and their own
 * translations) intact.
 */
export function extractItems(opts: ExtractionOptions): ExtractedItem[] {
  const root: ParentNode = opts.root ?? document.body;
  if (!root) return [];
  const cap = opts.maxSegments ?? Number.POSITIVE_INFINITY;
  const limit = MAX_SEGMENT_CHARS;

  /* -- pass 1: which elements own a segment of their own? ------------------- */

  const blocks: Element[] = [];
  const owners = new Set<Element>();

  const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const text = node as Text;
    const parent = text.parentElement;
    if (parent && isTranslatableText(text, opts, insideCode(text) ? 'opaque' : null)) {
      let block: Element | null = parent;
      while (block && !BLOCK_TAGS.has(tagNameOf(block))) block = block.parentElement;
      const target = block ?? parent;
      if (!owners.has(target)) {
        owners.add(target);
        blocks.push(target);
      }
    }
    node = walker.nextNode();
  }

  /* -- pass 2: split each owner into disjoint runs -------------------------- */

  const items: ExtractedItem[] = [];
  for (const block of blocks) {
    if (items.length >= cap) break;

    // Direct children only, cut at every nested owner and at every node the extractor will
    // not translate — those stay in the DOM and must never end up inside a replaced run.
    const runs: Node[][] = [];
    let current: Node[] = [];
    for (const child of Array.from(block.childNodes)) {
      if ((child.nodeType === Node.ELEMENT_NODE && owners.has(child as Element)) || breaksRun(child, opts, owners)) {
        if (current.length > 0) runs.push(current);
        current = [];
        continue;
      }
      current.push(child);
    }
    if (current.length > 0) runs.push(current);

    for (const run of runs) {
      if (items.length >= cap) break;
      for (const group of groupRun(run, limit)) {
        if (items.length >= cap) break;
        const built = buildRunText(group, opts, owners);
        if (!built.text || !/\p{L}/u.test(built.text)) continue;
        items.push({
          segment: {
            id: items.length,
            text: built.text,
            context: headingContext(block) || undefined,
            hasMarkup: built.slots.length > 0,
          },
          block,
          nodes: group,
          slots: built.slots,
          attributes: [],
          isCode: insideCode(block),
        });
      }
    }
  }

  if (opts.translateAttributes) {
    const attributeNames = ['alt', 'title', 'placeholder', 'aria-label'];
    const elements = Array.from(root.querySelectorAll?.('[alt], [title], [placeholder], [aria-label]') ?? []);
    for (const element of elements) {
      if (items.length >= cap) break;
      if (isExcluded(element)) continue;
      if (opts.skipBoilerplate && matchesBoilerplate(element)) continue;
      for (const name of attributeNames) {
        const value = element.getAttribute(name);
        if (!value || cleanText(value).length < MIN_SEGMENT_LENGTH) continue;
        if (looksLikeCode(value)) continue;
        items.push({
          segment: { id: items.length, text: cleanText(value), context: headingContext(element) || undefined },
          block: null,
          nodes: [],
          slots: [],
          attributes: [{ element, name }],
        });
      }
    }
  }

  return items;
}

/** Drop segments that carry no translatable prose. */
export function filterTranslatable(items: ExtractedItem[]): ExtractedItem[] {
  return items.filter((item) => {
    const text = item.segment.text;
    if (!text.trim()) return false;
    if (!/\p{L}/u.test(text)) return false;
    const letters = (text.match(/\p{L}/gu) ?? []).length;
    return letters >= 2;
  });
}

/** True when the text still contains at least one letter outside slot markers. */
export function hasProseInSlots(text: string): boolean {
  return /\p{L}/u.test(text.replace(/\{\{\/?\d+\}\}/g, ' '));
}
