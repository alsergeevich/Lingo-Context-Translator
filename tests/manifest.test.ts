import { describe, it, expect } from './helpers/framework';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Manifest checks.
 *
 * A broken manifest is the most expensive class of bug here: the extension simply refuses to
 * load, with a cryptic message, in three different browsers. These tests encode the rules that
 * Chrome, Yandex and Opera all enforce.
 */
interface ManifestShape {
  manifest_version: number;
  name: string;
  short_name: string;
  description: string;
  default_locale: string;
  background: { service_worker: string; type: string };
  content_scripts: { js: string[]; matches: string[] }[];
  permissions: string[];
  host_permissions: string[];
  optional_host_permissions: string[];
  commands: Record<string, { suggested_key: { default: string }; description: string }>;
  icons: Record<string, string>;
  action: { default_popup: string; default_icon: Record<string, string> };
  options_ui: { page: string; open_in_tab: boolean };
}

const root = path.resolve(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'public/manifest.json'), 'utf8')) as ManifestShape;

function localeMessages(locale: string): Record<string, { message: string }> {
  return JSON.parse(
    readFileSync(path.join(root, `public/_locales/${locale}/messages.json`), 'utf8'),
  ) as Record<string, { message: string }>;
}

/** The string a browser would actually show for `__MSG_x__` in the given locale. */
function resolve(value: string, locale: string): string {
  const match = /^__MSG_(\w+)__$/.exec(value);
  if (!match) return value;
  return localeMessages(locale)[match[1]]?.message ?? value;
}

describe('manifest', () => {
  it('is Manifest V3', () => {
    expect(manifest.manifest_version).toBe(3);
  });

  /**
   * Opera Add-ons validates the *raw* manifest, before `__MSG_` substitution, and it rejects
   * the upload with `'<value>' is too long` when a short field exceeds its limit. That is
   * exactly how `short_name: "Lingo Context"` (13 chars vs a 12-char limit) blocked 0.1.2.
   */
  it('keeps store-visible strings inside the store limits', () => {
    expect(manifest.short_name.length).toBeLessThan(13);
    // Even when the raw value is a localization key, the parser sees something short.
    expect(manifest.name.length).toBeLessThan(76);
    expect(manifest.description.length).toBeLessThan(133);

    for (const locale of ['ru', 'en']) {
      expect(resolve(manifest.name, locale).length).toBeLessThan(76);
      expect(resolve(manifest.description, locale).length).toBeLessThan(133);
    }
  });

  it('resolves name and description through _locales', () => {
    expect(manifest.name).toBe('__MSG_extName__');
    expect(manifest.description).toBe('__MSG_extDescription__');
    expect(manifest.default_locale).toBe('ru');

    for (const locale of ['ru', 'en']) {
      const messages = localeMessages(locale);
      expect(typeof messages.extName.message).toBe('string');
      expect(typeof messages.extDescription.message).toBe('string');
      // Chrome rejects a longer description.
      expect(messages.extDescription.message.length).toBeLessThan(133);
    }
  });

  it('declares a module service worker', () => {
    expect(manifest.background.service_worker).toBe('background.js');
    expect(manifest.background.type).toBe('module');
  });

  it('injects the content script on http, https and file pages', () => {
    const [script] = manifest.content_scripts;
    expect(script.js).toEqual(['content.js']);
    for (const pattern of ['http://*/*', 'https://*/*', 'file:///*']) {
      expect(script.matches).toContain(pattern);
    }
    expect(script.matches).not.toContain('<all_urls>');
  });

  it('requests the minimum permissions it needs', () => {
    for (const permission of ['storage', 'contextMenus', 'activeTab', 'scripting']) {
      expect(manifest.permissions).toContain(permission);
    }
    for (const forbidden of ['tabs', 'cookies', 'history', 'downloads', 'debugger', 'webRequest']) {
      expect(manifest.permissions).not.toContain(forbidden);
    }
  });

  it('declares host permissions for every built-in provider', () => {
    const hosts = manifest.host_permissions.join(' ');
    for (const host of [
      'api.deepseek.com',
      'api.openai.com',
      'openrouter.ai',
      'api.groq.com',
      'api.anthropic.com',
      'generativelanguage.googleapis.com',
      'translate.googleapis.com',
      'api.mymemory.translated.net',
      'lingva.ml',
      'api-free.deepl.com',
      'localhost',
    ]) {
      expect(hosts).toContain(host);
    }
  });

  it('keeps broad host access optional, for custom gateways', () => {
    expect(manifest.optional_host_permissions).toEqual(['https://*/*', 'http://*/*']);
  });

  it('declares the three commands with defaults', () => {
    for (const name of ['translate-page', 'toggle-original', 'save-pdf']) {
      expect(typeof manifest.commands[name].suggested_key.default).toBe('string');
      expect(manifest.commands[name].suggested_key.default).toMatch(/^Ctrl\+Shift\+[A-Z]$/);
    }
    // Chrome allows at most four suggested keys.
    expect(Object.keys(manifest.commands).length).toBeLessThan(5);
  });

  /**
   * Chrome truncates a command description past 40 characters without saying so, and the
   * keyboard-shortcut UI then shows a cut-off sentence. Keep every label short enough that no
   * browser has to decide where to break it.
   */
  it('keeps command descriptions short enough to render', () => {
    for (const command of Object.values(manifest.commands)) {
      expect(command.description.length).toBeGreaterThan(0);
      expect(command.description.length).toBeLessThanOrEqual(40);
    }
  });

  it('ships icons in every size the stores expect', () => {
    for (const size of ['16', '32', '48', '128']) {
      expect(manifest.icons[size]).toBe(`icons/icon-${size}.png`);
    }
  });

  it('points the action at the popup and options at options.html', () => {
    expect(manifest.action.default_popup).toBe('popup.html');
    expect(manifest.options_ui.page).toBe('options.html');
    expect(manifest.options_ui.open_in_tab).toBe(true);
  });
});
