/**
 * Print page: renders a translation payload as a clean, printable document and opens the
 * browser print dialog (the user chooses "Save as PDF").
 *
 * Deliberately dependency-free and isolated from the source page: no site chrome, no
 * dark theme, no sticky headers, code blocks are never split across pages.
 */
import type { PrintPayload } from '../content/print';

const PAYLOAD_KEY = 'printPayload';

function esc(input: string): string {
  return input.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

function render(payload: PrintPayload): void {
  const root = document.getElementById('doc');
  if (!root) return;

  const meta = payload.includeMeta
    ? `<div class="meta">
         <span>${esc(payload.host)}</span>
         <span>${esc(payload.dateText)}</span>
         <span>${esc(payload.sourceLang)} → ${esc(payload.targetLang)}</span>
       </div>
       <div class="source-url">${esc(payload.url)}</div>`
    : '';

  const blocks = payload.blocks
    .map((block) => {
      const original =
        block.original && block.original !== block.translated
          ? `<div class="original">${esc(block.original)}</div>`
          : '';
      return `<section class="seg"><div class="translated">${esc(block.translated)}</div>${original}</section>`;
    })
    .join('\n');

  root.innerHTML = `
    <header class="doc-head">
      <h1>${esc(payload.title)}</h1>
      ${meta}
    </header>
    <main>${blocks}</main>
    <footer class="doc-foot">Lingo Context · ${esc(payload.provider)}</footer>
  `;

  document.title = payload.title;
  document.documentElement.lang = payload.targetLang;
  document.documentElement.style.setProperty('--page-size', payload.pageSize);
  document.documentElement.style.setProperty('--page-margin', `${payload.marginMm}mm`);

  const printButton = document.getElementById('print-again');
  printButton?.addEventListener('click', () => window.print());

  // Give the renderer one frame, then open the print dialog.
  requestAnimationFrame(() => {
    setTimeout(() => window.print(), 120);
  });
}

async function init(): Promise<void> {
  const stored = await chrome.storage.session.get(PAYLOAD_KEY);
  const payload = stored[PAYLOAD_KEY] as PrintPayload | undefined;
  if (!payload) {
    const root = document.getElementById('doc');
    if (root) root.textContent = 'Нет данных для печати. Откройте страницу и выберите «Сохранить в PDF» ещё раз.';
    return;
  }
  await chrome.storage.session.remove(PAYLOAD_KEY);
  render(payload);
}

void init();
