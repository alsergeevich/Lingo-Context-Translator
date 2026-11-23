/**
 * Minimal DOM shim for tests that touch extraction.
 *
 * Provides just enough of the DOM API used by src/content/extract.ts: elements, text
 * nodes, a TreeWalker over a static tree, closest()/matches() with the selectors the
 * module uses, and a getComputedStyle stub.
 */

export class FakeText {
  readonly nodeType = 3;
  nodeValue: string;
  parentElement: FakeElement | null = null;
  constructor(value: string) {
    this.nodeValue = value;
  }
}

export class FakeElement {
  readonly nodeType = 1;
  tagName: string;
  children: (FakeElement | FakeText)[] = [];
  parentElement: FakeElement | null = null;
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  className = '';

  constructor(tagName: string, attrs: Record<string, string> = {}) {
    this.tagName = tagName.toUpperCase();
    for (const [k, v] of Object.entries(attrs)) this.attributes.set(k, v);
  }

  get childElementCount(): number {
    return this.children.filter((c) => c instanceof FakeElement).length;
  }

  get previousElementSibling(): FakeElement | null {
    const parent = this.parentElement;
    if (!parent) return null;
    const index = parent.children.indexOf(this);
    for (let i = index - 1; i >= 0; i--) {
      const candidate = parent.children[i];
      if (candidate instanceof FakeElement) return candidate;
    }
    return null;
  }

  get nextElementSibling(): FakeElement | null {
    const parent = this.parentElement;
    if (!parent) return null;
    const index = parent.children.indexOf(this);
    for (let i = index + 1; i < parent.children.length; i++) {
      const candidate = parent.children[i];
      if (candidate instanceof FakeElement) return candidate;
    }
    return null;
  }

  append(...nodes: (FakeElement | FakeText | string | (FakeElement | FakeText | string)[])[]): this {
    for (const raw of nodes) {
      const items = Array.isArray(raw) ? raw : [raw];
      for (const node of items) {
        const child = typeof node === 'string' ? new FakeText(node) : node;
        child.parentElement = this;
        this.children.push(child);
      }
    }
    return this;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  get textContent(): string {
    return this.children.map((c) => (c instanceof FakeText ? c.nodeValue : c.textContent)).join('');
  }

  set textContent(value: string) {
    this.children = [Object.assign(new FakeText(value), { parentElement: this })];
  }

  /** Ancestors from this element up to the root. */
  ancestors(): FakeElement[] {
    const out: FakeElement[] = [];
    let node: FakeElement | null = this;
    while (node) {
      out.push(node);
      node = node.parentElement;
    }
    return out;
  }

  closest(selector: string): FakeElement | null {
    for (const node of this.ancestors()) {
      if (matchesSelector(node, selector)) return node;
    }
    return null;
  }

  matches(selector: string): boolean {
    return matchesSelector(this, selector);
  }

  querySelectorAll(selector: string): FakeElement[] {
    const out: FakeElement[] = [];
    const walk = (node: FakeElement) => {
      for (const child of node.children) {
        if (child instanceof FakeElement) {
          if (matchesSelector(child, selector)) out.push(child);
          walk(child);
        }
      }
    };
    walk(this);
    return out;
  }

  getBoundingClientRect() {
    return { top: 0, left: 0, bottom: 100, right: 100, width: 100, height: 100 };
  }
}

/**
 * Supports the selector subset used by the extension: tag, .class, [attr],
 * [attr="value"], comma lists, and simple descendant combinators ("a b").
 */
export function matchesSelector(element: FakeElement, selector: string): boolean {
  return selector.split(',').some((part) => matchesSimple(element, part.trim()));
}

function matchesSimple(element: FakeElement, selector: string): boolean {
  const tokens = selector.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  const lastIndex = tokens.length - 1;
  if (!matchesCompound(element, tokens[lastIndex])) return false;
  // Every preceding token must match some ancestor, in order (descendant combinator).
  let index = lastIndex - 1;
  let node = element.parentElement;
  while (index >= 0 && node) {
    if (matchesCompound(node, tokens[index])) index--;
    node = node.parentElement;
  }
  return index < 0;
}

function matchesCompound(element: FakeElement, compound: string): boolean {
  let rest = compound;
  if (rest.startsWith('#')) {
    const id = /^#([\w-]+)/.exec(rest)?.[1];
    if (!id || element.getAttribute('id') !== id) return false;
    rest = rest.slice(id.length + 1);
  }
  const tagMatch = /^[a-zA-Z][\w-]*/.exec(rest);
  if (tagMatch) {
    if (element.tagName !== tagMatch[0].toUpperCase()) return false;
    rest = rest.slice(tagMatch[0].length);
  }
  for (const classMatch of rest.matchAll(/\.([\w-]+)/g)) {
    const classes = element.className.split(/\s+/).filter(Boolean);
    if (!classes.includes(classMatch[1])) return false;
  }
  for (const attrMatch of rest.matchAll(/\[([\w-]+)(?:(\^?=)"([^"]*)")?\]/g)) {
    const [, name, operator, value] = attrMatch;
    if (!element.hasAttribute(name)) return false;
    if (operator && value !== undefined) {
      const actual = element.getAttribute(name) ?? '';
      if (operator === '=' && actual !== value) return false;
      if (operator === '^=' && !actual.startsWith(value)) return false;
    }
  }
  return true;
}

export interface FakeDocumentOptions {
  title?: string;
  host?: string;
  height?: number;
}

/** Install globals that extract.ts expects, and return the document root. */
export function installDom(options: FakeDocumentOptions = {}): FakeElement {
  const html = new FakeElement('html');
  const head = new FakeElement('head');
  const body = new FakeElement('body');
  html.append(head, body);

  const document = {
    body,
    documentElement: html,
    title: options.title ?? 'Test page',
    createTreeWalker(
      root: FakeElement,
      _whatToShow: number,
      filter?: { acceptNode: (node: unknown) => number },
    ) {
      const nodes: FakeText[] = [];
      const visit = (node: FakeElement) => {
        for (const child of node.children) {
          if (child instanceof FakeText) {
            if (!filter || filter.acceptNode(child) === 1) nodes.push(child);
          } else {
            visit(child);
          }
        }
      };
      visit(root);
      let index = 0;
      return {
        get currentNode() {
          return nodes[index - 1] ?? null;
        },
        nextNode() {
          if (index >= nodes.length) return null;
          index++;
          return nodes[index - 1];
        },
      };
    },
    createElement(tag: string) {
      return new FakeElement(tag);
    },
  };

  const g = globalThis as unknown as Record<string, unknown>;
  g.Node = { TEXT_NODE: 3, ELEMENT_NODE: 1, showText: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 };
  g.NodeFilter = { SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2 };
  g.document = document;
  g.getComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1' });
  g.location = { hostname: options.host ?? 'example.com', href: `https://${options.host ?? 'example.com'}/` };
  g.window = {
    innerHeight: options.height ?? 800,
    innerWidth: 1200,
    getSelection: () => null,
  };

  return body;
}

/** Convenience: build an element tree from a tiny HTML-ish string. */
export function el(tag: string, attrs: Record<string, string> = {}, ...children: (FakeElement | string)[]): FakeElement {
  const node = new FakeElement(tag, attrs);
  node.append(...children);
  return node;
}

/** Wrap a text node so it can be used as a child in `el()`. */
export function text(value: string): FakeText {
  return new FakeText(value);
}
