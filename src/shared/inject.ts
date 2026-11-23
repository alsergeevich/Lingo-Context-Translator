/**
 * Content-script injection from the popup.
 *
 * A tab that was already open when the extension was installed, updated or reloaded has no
 * content script running: every message to it fails with "Receiving end does not exist" and
 * the translate button looks dead. Injecting the script on demand makes those tabs work
 * without a reload. The content script guards against being initialised twice, so injecting
 * into a tab that already has it is harmless.
 */
const CONTENT_SCRIPT = 'content.js';

/** Inject the content script into a tab. Returns false when the browser refuses. */
export async function injectContentScript(tabId: number): Promise<boolean> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT] });
    return true;
  } catch {
    // chrome:// pages, the Web Store, PDFs and other privileged documents reject injection.
    return false;
  }
}
