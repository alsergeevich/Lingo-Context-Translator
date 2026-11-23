/** Options page: providers, skill, glossary, sites, PDF, cache. */
import { loadSettings, saveSettings } from '../shared/storage';
import { normalizeSettings, type Settings } from '../shared/settings';
import { LANGUAGES } from '../shared/languages';
import { PROVIDERS, providerPreset } from '../shared/providers';
import type { ProviderId } from '../shared/types';
import type { RuntimeResponse } from '../shared/messaging';
import { sendToBackground } from '../shared/messaging';
import { t, type UiLang } from '../shared/i18n';
import { h, downloadBlob, type Child } from '../shared/dom';
import { skillPreview } from '../core/skill/translation-skill';
import { SKILL_VERSION } from '../core/skill/version';
import { parseCsv, splitHosts, clampNumber } from './util';

let settings: Settings;
let activeTab = 'general';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const L = (): UiLang => settings.uiLang;

interface TabDef {
  id: string;
  key: string;
}

const TABS: TabDef[] = [
  { id: 'general', key: 'options.tabGeneral' },
  { id: 'providers', key: 'options.tabProviders' },
  { id: 'skill', key: 'options.tabSkill' },
  { id: 'glossary', key: 'options.tabGlossary' },
  { id: 'sites', key: 'options.tabSites' },
  { id: 'pdf', key: 'options.tabPdf' },
  { id: 'cache', key: 'options.tabCache' },
  { id: 'about', key: 'options.tabAbout' },
];

/* ------------------------------------------------------------------ layout */

function render(): void {
  const root = $('app');
  const lang = L();

  const tabs = h(
    'nav',
    { class: 'tabs' },
    TABS.map((tab) =>
      h('button', {
        class: `tab${activeTab === tab.id ? ' active' : ''}`,
        text: t(lang, tab.key),
        onClick: () => {
          activeTab = tab.id;
          render();
        },
      }),
    ),
  );

  const section =
    activeTab === 'general'
      ? generalSection()
      : activeTab === 'providers'
        ? providersSection()
        : activeTab === 'skill'
          ? skillSection()
          : activeTab === 'glossary'
            ? glossarySection()
            : activeTab === 'sites'
              ? sitesSection()
              : activeTab === 'pdf'
                ? pdfSection()
                : activeTab === 'cache'
                  ? cacheSection()
                  : aboutSection();

  root.replaceChildren(
    h('header', { class: 'page-head' }, [
      h('div', { class: 'logo' }),
      h('div', {}, [
        h('h1', { text: t(lang, 'options.title') }),
        h('div', {
          class: 'subtitle',
          text: `${t(lang, 'options.version')} ${chrome.runtime.getManifest().version} · ${t(
            lang,
            'options.skillVersion',
          )} ${SKILL_VERSION}`,
        }),
      ]),
    ]),
    tabs,
    section,
    saveBar(),
  );
}

/* ----------------------------------------------------------------- sections */

function generalSection(): HTMLElement {
  const lang = L();

  const sourceSelect = h(
    'select',
    {},
    LANGUAGES.map((language) =>
      h('option', {
        value: language.code,
        text: language.code === 'auto' ? t(lang, 'popup.autoDetect') : language.label,
      }),
    ),
  );
  sourceSelect.value = settings.sourceLang;
  sourceSelect.onchange = () => (settings.sourceLang = sourceSelect.value);

  const targetSelect = h(
    'select',
    {},
    LANGUAGES.filter((language) => language.code !== 'auto').map((language) =>
      h('option', { value: language.code, text: language.label }),
    ),
  );
  targetSelect.value = settings.targetLang;
  targetSelect.onchange = () => (settings.targetLang = targetSelect.value);

  const modeSelect = h('select', {}, [
    h('option', { value: 'replace', text: t(lang, 'options.displayReplace') }),
    h('option', { value: 'bilingual', text: t(lang, 'options.displayBilingual') }),
  ]);
  modeSelect.value = settings.displayMode;
  modeSelect.onchange = () => {
    settings.displayMode = modeSelect.value === 'bilingual' ? 'bilingual' : 'replace';
  };

  const uiSelect = h('select', {}, [
    h('option', { value: 'ru', text: 'Русский' }),
    h('option', { value: 'en', text: 'English' }),
  ]);
  uiSelect.value = settings.uiLang;
  uiSelect.onchange = () => {
    settings.uiLang = uiSelect.value === 'en' ? 'en' : 'ru';
    render();
  };

  const themeSelect = h('select', {}, [
    h('option', { value: 'auto', text: 'Авто / Auto' }),
    h('option', { value: 'light', text: 'Светлая / Light' }),
    h('option', { value: 'dark', text: 'Тёмная / Dark' }),
  ]);
  themeSelect.value = settings.theme;
  themeSelect.onchange = () => {
    settings.theme = themeSelect.value as Settings['theme'];
  };

  const chunkInput = numberField(settings.chunkSize, 1, 80, (value) => (settings.chunkSize = value));
  const concurrencyInput = numberField(settings.concurrency, 1, 6, (value) => (settings.concurrency = value));
  const timeoutInput = numberField(settings.requestTimeoutSec, 10, 600, (value) => (settings.requestTimeoutSec = value));

  return h('section', { class: 'card' }, [
    h('h2', { text: t(lang, 'options.tabGeneral') }),
    h('div', { class: 'grid' }, [
      fieldRow(t(lang, 'options.sourceLang'), sourceSelect),
      fieldRow(t(lang, 'options.targetLang'), targetSelect),
      fieldRow(t(lang, 'options.displayMode'), modeSelect),
      fieldRow(t(lang, 'options.uiLang'), uiSelect),
      fieldRow(t(lang, 'options.theme'), themeSelect),
      fieldRow(t(lang, 'options.chunkSize'), chunkInput),
      fieldRow(t(lang, 'options.concurrency'), concurrencyInput),
      fieldRow(t(lang, 'options.timeout'), timeoutInput),
    ]),
    h('div', { style: 'height:10px' }),
    checkRow(t(lang, 'options.keepOriginal'), settings.keepOriginal, (v) => (settings.keepOriginal = v)),
    checkRow(t(lang, 'options.translateAttributes'), settings.translateAttributes, (v) => {
      settings.translateAttributes = v;
    }),
    checkRow(t(lang, 'options.translateCode'), settings.translateCode, (v) => (settings.translateCode = v)),
    checkRow(t(lang, 'options.translateCodeComments'), settings.translateCodeComments, (v) => {
      settings.translateCodeComments = v;
    }),
    checkRow(t(lang, 'options.skipBoilerplate'), settings.skipBoilerplate, (v) => (settings.skipBoilerplate = v)),
  ]);
}

function providersSection(): HTMLElement {
  const lang = L();
  const cards = PROVIDERS.map((provider) => {
    const stored = settings.providers[provider.id];
    const isActive = settings.provider === provider.id;
    const card = h('div', { class: `provider${isActive ? ' active' : ''}` });

    const head = h('div', { class: 'provider-head' }, [
      h('span', { class: 'provider-name', text: provider.label }),
      h('span', {
        class: `badge${provider.needsKey ? '' : ' free'}`,
        text: provider.needsKey ? t(lang, 'popup.llmService') : t(lang, 'options.freeNote'),
      }),
      isActive ? h('span', { class: 'badge', text: t(lang, 'options.active') }) : null,
    ]);
    card.append(head, h('div', { class: 'provider-note', text: provider.note }));

    const fields = h('div', { class: 'provider-fields' });

    const keyInput = h('input', {
      type: 'password',
      placeholder: t(lang, 'options.keyPlaceholder'),
      value: stored?.key ?? '',
      autocomplete: 'off',
      spellcheck: false,
    });
    keyInput.onchange = () => upsertProvider(provider.id, { key: keyInput.value.trim() });

    if (provider.needsKey) {
      const keyRow = fieldRow(t(lang, 'options.key'), keyInput);
      if (provider.keyUrl) {
        keyRow.append(
          h('a', {
            class: 'link',
            href: provider.keyUrl,
            target: '_blank',
            rel: 'noreferrer',
            text: t(lang, 'options.getKey'),
            style: 'font-size:11.5px;margin-top:4px;display:inline-block',
          }),
        );
      }
      fields.append(keyRow);
    }

    let modelInput: HTMLInputElement | null = null;
    if (provider.kind === 'llm') {
      modelInput = h('input', {
        type: 'text',
        value: stored?.model || provider.defaultModel,
        list: `models-${provider.id}`,
        spellcheck: false,
      });
      modelInput.onchange = () => upsertProvider(provider.id, { model: modelInput!.value.trim() });
      const datalist = h(
        'datalist',
        { id: `models-${provider.id}` },
        (provider.models ?? [provider.defaultModel]).map((model) => h('option', { value: model })),
      );
      fields.append(fieldRow(t(lang, 'options.model'), modelInput), datalist);
    }

    if (provider.id === 'openai-compatible' || provider.id === 'ollama' || provider.id === 'libretranslate') {
      const baseInput = h('input', {
        type: 'text',
        value: stored?.baseUrl || provider.baseUrl || '',
        placeholder: provider.baseUrl ?? '',
        spellcheck: false,
      });
      baseInput.onchange = () => upsertProvider(provider.id, { baseUrl: baseInput.value.trim() });
      fields.append(fieldRow(t(lang, 'options.baseUrl'), baseInput));
    }

    card.append(fields);

    const actions = h('div', { class: 'row-inline', style: 'margin-top:11px' });
    const result = h('span', { class: 'test-result' });
    const testBtn = h('button', { class: 'btn', text: t(lang, 'options.test') });
    testBtn.onclick = async () => {
      testBtn.disabled = true;
      result.className = 'test-result';
      result.textContent = t(lang, 'options.testing');
      const response: RuntimeResponse<{ model: string; sample: string }> = await sendToBackground({
        type: 'TEST_PROVIDER',
        provider: provider.id,
        overrides: {
          key: keyInput.value.trim(),
          model: modelInput ? modelInput.value.trim() : undefined,
        },
      });
      testBtn.disabled = false;
      if (response.ok) {
        result.className = 'test-result ok';
        result.textContent = `${t(lang, 'options.testOk', { model: response.data.model || provider.id })} — “${response.data.sample}”`;
      } else {
        result.className = 'test-result err';
        result.textContent = `${t(lang, 'options.testFail')}: ${response.error.message}`;
      }
    };

    if (!isActive) {
      actions.append(
        h('button', {
          class: 'btn',
          text: t(lang, 'options.use'),
          onClick: () => {
            settings.provider = provider.id;
            void persist().then(render);
          },
        }),
      );
    }
    actions.append(testBtn, result);
    card.append(actions);
    return card;
  });

  return h('section', { class: 'provider-list' }, cards);
}

function skillSection(): HTMLElement {
  const lang = L();

  const textarea = h('textarea', { placeholder: t(lang, 'options.skillCustomHint') });
  textarea.value = settings.customInstruction;
  textarea.oninput = () => (settings.customInstruction = textarea.value);

  const preview = h('pre', { class: 'skill', text: skillPreview(settings, 'book.leptos.dev') });

  return h('section', { class: 'card' }, [
    h('h2', { text: t(lang, 'options.skillBuiltin') }),
    h('p', { class: 'hint', text: t(lang, 'options.skillIntro') }),
    h('label', { class: 'check' }, [
      checkbox(settings.useCustomSkill, (v) => {
        settings.useCustomSkill = v;
        render();
      }),
      h('span', {}, [t(lang, 'options.skillReplace'), h('small', { text: t(lang, 'options.skillCustomHint') })]),
    ]),
    fieldRow(t(lang, 'options.skillCustom'), textarea),
    h('div', { style: 'margin:14px 0 6px;font-size:12px;color:var(--muted)', text: t(lang, 'options.skillPreview') }),
    preview,
    h('div', { class: 'row-inline', style: 'margin-top:12px' }, [
      h('button', {
        class: 'btn',
        text: t(lang, 'options.skillReset'),
        onClick: () => {
          settings.useCustomSkill = false;
          settings.customInstruction = '';
          render();
        },
      }),
    ]),
  ]);
}

function glossarySection(): HTMLElement {
  const lang = L();
  const rows = settings.glossary.map((entry, index) => {
    const sourceInput = h('input', { type: 'text', value: entry.source });
    sourceInput.onchange = () => (settings.glossary[index].source = sourceInput.value.trim());
    const targetInput = h('input', { type: 'text', value: entry.target });
    targetInput.onchange = () => (settings.glossary[index].target = targetInput.value.trim());
    const siteInput = h('input', { type: 'text', value: entry.site ?? '' });
    siteInput.onchange = () => {
      const site = siteInput.value.trim();
      settings.glossary[index].site = site || undefined;
    };
    return h('tr', {}, [
      h('td', {}, [sourceInput]),
      h('td', {}, [targetInput]),
      h('td', {}, [siteInput]),
      h('td', { class: 'actions' }, [
        h('button', {
          class: 'btn danger',
          text: '×',
          title: t(lang, 'options.remove'),
          onClick: () => {
            settings.glossary.splice(index, 1);
            render();
          },
        }),
      ]),
    ]);
  });

  const table = h('table', { class: 'glossary' }, [
    h('thead', {}, [
      h('tr', {}, [
        h('th', { text: t(lang, 'options.glossarySource') }),
        h('th', { text: t(lang, 'options.glossaryTarget') }),
        h('th', { text: t(lang, 'options.glossarySite') }),
        h('th'),
      ]),
    ]),
    h('tbody', {}, rows),
  ]);

  const fileInput = h('input', { type: 'file', accept: '.csv,text/csv', style: 'display:none' });
  fileInput.onchange = async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    await importGlossary(file);
  };

  return h('section', { class: 'card' }, [
    h('h2', { text: t(lang, 'options.tabGlossary') }),
    h('p', { class: 'hint', text: t(lang, 'options.glossaryIntro') }),
    table,
    h('div', { class: 'row-inline', style: 'margin-top:12px' }, [
      h('button', {
        class: 'btn primary',
        text: t(lang, 'options.add'),
        onClick: () => {
          settings.glossary.push({ source: '', target: '' });
          render();
        },
      }),
      h('button', { class: 'btn', text: t(lang, 'options.export'), onClick: exportGlossary }),
      h('label', { class: 'btn', style: 'cursor:pointer' }, [t(lang, 'options.import'), fileInput]),
    ]),
  ]);
}

function sitesSection(): HTMLElement {
  const lang = L();

  const autoArea = h('textarea', { class: 'sites', placeholder: 'example.com\ndocs.example.org' });
  autoArea.value = settings.autoTranslateHosts.join('\n');
  autoArea.onchange = () => (settings.autoTranslateHosts = splitHosts(autoArea.value));

  const excludedArea = h('textarea', { class: 'sites', placeholder: 'intranet.local' });
  excludedArea.value = settings.excludedHosts.join('\n');
  excludedArea.onchange = () => (settings.excludedHosts = splitHosts(excludedArea.value));

  return h('section', { class: 'card' }, [
    h('h2', { text: t(lang, 'options.tabSites') }),
    h('p', { class: 'hint', text: t(lang, 'options.sitesHint') }),
    fieldRow(t(lang, 'options.sitesAuto'), autoArea),
    h('div', { style: 'height:12px' }),
    fieldRow(t(lang, 'options.sitesExcluded'), excludedArea),
  ]);
}

function pdfSection(): HTMLElement {
  const lang = L();

  const sizeSelect = h('select', {}, [
    h('option', { value: 'A4', text: 'A4' }),
    h('option', { value: 'Letter', text: 'Letter' }),
  ]);
  sizeSelect.value = settings.pdf.pageSize;
  sizeSelect.onchange = () => {
    settings.pdf.pageSize = sizeSelect.value === 'Letter' ? 'Letter' : 'A4';
  };

  const marginInput = numberField(settings.pdf.marginMm, 5, 40, (value) => (settings.pdf.marginMm = value));

  return h('section', { class: 'card' }, [
    h('h2', { text: t(lang, 'options.tabPdf') }),
    h('p', { class: 'hint', text: t(lang, 'options.pdfIntro') }),
    checkRow(t(lang, 'options.pdfOriginals'), settings.pdf.includeOriginals, (v) => (settings.pdf.includeOriginals = v)),
    checkRow(t(lang, 'options.pdfMeta'), settings.pdf.includeMeta, (v) => (settings.pdf.includeMeta = v)),
    h('div', { class: 'grid', style: 'margin-top:12px' }, [
      fieldRow(t(lang, 'options.pdfPageSize'), sizeSelect),
      fieldRow(t(lang, 'options.pdfMargin'), marginInput),
    ]),
  ]);
}

function cacheSection(): HTMLElement {
  const lang = L();
  const statsLine = h('div', { class: 'kv' }, [
    h('span', { class: 'k', text: t(lang, 'options.cacheStats', { count: '…', size: '…' }) }),
  ]);

  void sendToBackground<{ count: number; bytes: number }>({ type: 'CACHE_STATS' }).then((response) => {
    if (!response.ok) return;
    const { count, bytes } = response.data;
    statsLine.replaceChildren(
      h('span', {
        class: 'k',
        text: t(lang, 'options.cacheStats', { count, size: `${(bytes / 1024 / 1024).toFixed(1)} MB` }),
      }),
    );
  });

  const ttlInput = numberField(settings.cacheTtlDays, 0, 365, (value) => (settings.cacheTtlDays = value));

  const importInput = h('input', { type: 'file', accept: '.json,application/json', style: 'display:none' });
  importInput.onchange = async () => {
    const file = importInput.files?.[0];
    if (!file) return;
    try {
      settings = normalizeSettings(JSON.parse(await file.text()));
      await persist();
      render();
    } catch (err) {
      console.error(err);
    }
  };

  return h('section', { class: 'card' }, [
    h('h2', { text: t(lang, 'options.tabCache') }),
    statsLine,
    h('div', { style: 'height:12px' }),
    checkRow(t(lang, 'options.cacheEnabled'), settings.cacheEnabled, (v) => (settings.cacheEnabled = v)),
    h('div', { class: 'grid', style: 'margin:10px 0 14px' }, [fieldRow(t(lang, 'options.cacheTtl'), ttlInput)]),
    h('div', { class: 'row-inline' }, [
      h('button', {
        class: 'btn danger',
        text: t(lang, 'options.cacheClear'),
        onClick: async () => {
          await sendToBackground({ type: 'CACHE_CLEAR' });
          render();
        },
      }),
      h('button', { class: 'btn', text: t(lang, 'options.exportSettings'), onClick: exportSettings }),
      h('label', { class: 'btn', style: 'cursor:pointer' }, [t(lang, 'options.importSettings'), importInput]),
    ]),
  ]);
}

function aboutSection(): HTMLElement {
  const lang = L();
  return h('section', { class: 'card' }, [
    h('h2', { text: t(lang, 'options.tabAbout') }),
    h('p', { class: 'hint', text: t(lang, 'options.aboutText') }),
    kv(t(lang, 'options.version'), chrome.runtime.getManifest().version),
    kv(t(lang, 'options.skillVersion'), String(SKILL_VERSION)),
    kv('Manifest', 'v3'),
    kv('Chrome / Yandex / Opera', 'MV3'),
  ]);
}

function saveBar(): HTMLElement {
  const lang = L();
  const flash = h('span', { class: 'saved-flash' });

  return h('div', { class: 'savebar' }, [
    flash,
    h('button', {
      class: 'btn',
      text: t(lang, 'options.reset'),
      onClick: async () => {
        settings = normalizeSettings({});
        await persist();
        render();
      },
    }),
    h('button', {
      class: 'btn primary',
      text: t(lang, 'options.save'),
      onClick: async () => {
        await persist();
        flash.textContent = t(lang, 'options.saved');
        flash.classList.add('show');
        setTimeout(() => flash.classList.remove('show'), 1600);
      },
    }),
  ]);
}

/* ------------------------------------------------------------------ helpers */

function fieldRow(label: string, control: HTMLElement): HTMLElement {
  return h('label', { class: 'field' }, [h('span', { text: label }), control]);
}

function checkbox(checked: boolean, onChange: (value: boolean) => void): HTMLInputElement {
  const input = h('input', { type: 'checkbox' });
  input.checked = checked;
  input.onchange = () => onChange(input.checked);
  return input;
}

function checkRow(label: string, checked: boolean, onChange: (value: boolean) => void): HTMLElement {
  return h('label', { class: 'check' }, [checkbox(checked, onChange), h('span', { text: label })]);
}

function numberField(initial: number, min: number, max: number, onChange: (value: number) => void): HTMLInputElement {
  const input = h('input', { type: 'number', min: String(min), max: String(max), value: String(initial) });
  input.onchange = () => {
    const value = clampNumber(Number(input.value), min, max);
    onChange(value);
    input.value = String(value);
  };
  return input;
}

function kv(key: string, value: string): HTMLElement {
  return h('div', { class: 'kv' }, [
    h('span', { class: 'k', text: key }),
    h('span', { class: 'mono', text: value }),
  ]);
}

function upsertProvider(id: ProviderId, patch: { key?: string; model?: string; baseUrl?: string }): void {
  const preset = providerPreset(id);
  const current = settings.providers[id] ?? { key: '', model: preset.defaultModel, baseUrl: preset.baseUrl ?? '' };
  settings.providers[id] = { ...current, ...patch };
}

async function persist(): Promise<void> {
  settings = normalizeSettings(settings);
  await saveSettings(settings);
}

function exportSettings(): void {
  downloadBlob(
    new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' }),
    'lingo-context-settings.json',
  );
}

function exportGlossary(): void {
  const rows: string[][] = [['source', 'target', 'site'], ...settings.glossary.map((g) => [g.source, g.target, g.site ?? ''])];
  const csv = rows.map((row) => row.map(csvCell).join(',')).join('\r\n');
  downloadBlob(new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' }), 'lingo-context-glossary.csv');
}

function csvCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

async function importGlossary(file: File): Promise<void> {
  const rows = parseCsv(await file.text());
  const header = rows[0]?.map((cell) => cell.toLowerCase()) ?? [];
  const start = header.includes('source') || header.includes('оригинал') ? 1 : 0;
  for (const row of rows.slice(start)) {
    const [source, target, site] = row;
    if (!source?.trim() || !target?.trim()) continue;
    settings.glossary.push({ source: source.trim(), target: target.trim(), site: site?.trim() || undefined });
  }
  render();
}

async function init(): Promise<void> {
  settings = await loadSettings();
  const hash = location.hash.replace('#', '');
  if (hash && TABS.some((tab) => tab.id === hash)) activeTab = hash;
  render();
  location.hash = activeTab;
}

void init();
