/** chrome.storage wrappers: settings (sync-safe local) and ephemeral job state. */
import { DEFAULT_SETTINGS, normalizeSettings, type Settings } from './settings';
import type { PageState } from './messaging';

const SETTINGS_KEY = 'settings';
const STATE_KEY = 'runtime';

export async function loadSettings(): Promise<Settings> {
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    const normalized = normalizeSettings(stored[SETTINGS_KEY]);
    if (JSON.stringify(stored[SETTINGS_KEY]) !== JSON.stringify(normalized)) {
      await saveSettings(normalized);
    }
    return normalized;
  } catch {
    return normalizeSettings(DEFAULT_SETTINGS);
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

export async function patchSettings(patch: Record<string, unknown>): Promise<Settings> {
  const current = await loadSettings();
  const merged = normalizeSettings({ ...current, ...patch });
  await saveSettings(merged);
  return merged;
}

export async function onSettingsChanged(cb: (settings: Settings) => void): Promise<() => void> {
  const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'local' || !(SETTINGS_KEY in changes)) return;
    cb(normalizeSettings(changes[SETTINGS_KEY].newValue));
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

/** Last page state per tab, so the popup can render without waiting for the content script. */
export async function saveTabState(tabId: number, state: PageState): Promise<void> {
  const stored = await chrome.storage.session.get(STATE_KEY);
  const map = (stored[STATE_KEY] as Record<string, PageState>) ?? {};
  map[String(tabId)] = state;
  await chrome.storage.session.set({ [STATE_KEY]: map });
}

export async function loadTabState(tabId: number): Promise<PageState | undefined> {
  const stored = await chrome.storage.session.get(STATE_KEY);
  const map = (stored[STATE_KEY] as Record<string, PageState>) ?? {};
  return map[String(tabId)];
}
