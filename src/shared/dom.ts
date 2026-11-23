/**
 * Tiny DOM helper shared by the popup and the options page.
 *
 * `h(tag, props, children)` sets properties, attributes, event handlers and inline styles
 * from one object, so UI code stays declarative without a framework.
 */
export type Child = Node | string | null | undefined | false;
export type Props = Record<string, unknown>;

const EVENT_RE = /^on[A-Z]/;

/**
 * Properties that exist on elements but must never be *assigned* by the helper:
 * read-only DOM collections (`input.list`, `select.options`), which a naive `key in node`
 * check would happily clobber.
 */
const READ_ONLY_PROPS = new Set(['list', 'options', 'labels', 'validity', 'form', 'ownerDocument', 'children', 'dataset']);

/** Properties worth assigning for their side effects (`value`, `checked`, …). */
const ASSIGNABLE_PROPS = new Set([
  'value', 'checked', 'disabled', 'selected', 'readOnly', 'required', 'multiple', 'hidden',
  'placeholder', 'title', 'type', 'name', 'id', 'htmlFor', 'min', 'max', 'step', 'accept',
  'autocomplete', 'spellcheck', 'rows', 'cols', 'tabIndex', 'draggable', 'src', 'href', 'alt',
]);

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null) continue;
    if (key === 'style') {
      node.setAttribute('style', String(value));
      continue;
    }
    if (key === 'class' || key === 'className') {
      node.className = String(value);
      continue;
    }
    if (key === 'text' || key === 'textContent') {
      node.textContent = String(value);
      continue;
    }
    if (key === 'html' || key === 'innerHTML') {
      node.innerHTML = String(value);
      continue;
    }
    if (key === 'dataset' && typeof value === 'object') {
      Object.assign(node.dataset, value as Record<string, string>);
      continue;
    }
    if (EVENT_RE.test(key) && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
      continue;
    }
    if (!READ_ONLY_PROPS.has(key) && ASSIGNABLE_PROPS.has(key) && key in node) {
      (node as unknown as Record<string, unknown>)[key] = value;
      continue;
    }
    node.setAttribute(key, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function frag(children: Child[]): DocumentFragment {
  const out = document.createDocumentFragment();
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    out.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return out;
}

export function clear(node: Element): void {
  node.replaceChildren();
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
