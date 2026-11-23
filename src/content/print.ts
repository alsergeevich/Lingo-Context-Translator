/**
 * PDF export.
 *
 * Printing happens in an extension page (`print.html`), not in the content script:
 * content scripts have no `chrome.tabs`, and an extension page can call `window.print()`
 * safely in Chrome, Yandex and Opera alike. The translated blocks are handed over through
 * `chrome.storage.session`, so nothing is ever written to disk.
 *
 * The user picks "Save as PDF" in the browser's print dialog.
 */
import type { Settings } from '../shared/settings';
import type { AppliedText } from './apply';
import { stripMarkers } from './apply';
import { sendToBackground } from '../shared/messaging';

export interface PrintPayload {
  title: string;
  url: string;
  host: string;
  provider: string;
  sourceLang: string;
  targetLang: string;
  dateText: string;
  pageSize: 'A4' | 'Letter';
  marginMm: number;
  includeOriginals: boolean;
  includeMeta: boolean;
  /** Blocks in document order: translation, and the original when requested. */
  blocks: { translated: string; original?: string }[];
}

export interface PrintDocumentInput {
  settings: Settings;
  title: string;
  url: string;
  host: string;
  applied: AppliedText[];
}

export function buildPrintPayload(input: PrintDocumentInput): PrintPayload {
  const { settings } = input;
  return {
    title: input.title,
    url: input.url,
    host: input.host,
    provider: settings.provider,
    sourceLang: settings.sourceLang,
    targetLang: settings.targetLang,
    dateText: new Date().toLocaleString(settings.uiLang === 'ru' ? 'ru-RU' : 'en-GB'),
    pageSize: settings.pdf.pageSize,
    marginMm: settings.pdf.marginMm,
    includeOriginals: settings.pdf.includeOriginals,
    includeMeta: settings.pdf.includeMeta,
    blocks: input.applied
      // `plainText` is the rendered text with slots resolved: printing `translated` would put
      // raw `{{0}}` markers into the PDF. Attribute-only entries have no text of their own.
      .filter((entry) => entry.plainText.length > 0)
      .map((entry) => ({
        translated: entry.plainText,
        // The source line has the same problem: `entry.original` still holds `{{n}}` markers.
        original: settings.pdf.includeOriginals ? stripMarkers(entry.original) : undefined,
      })),
  };
}

/** Ask the service worker to open the print page with this content. */
export async function openPrintView(input: PrintDocumentInput): Promise<void> {
  const payload = buildPrintPayload(input);
  if (payload.blocks.length === 0) return;
  await sendToBackground({ type: 'OPEN_PRINT', payload });
}
