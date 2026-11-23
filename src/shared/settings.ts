/** Persistent settings model with defaults, validation and migration. */
import type { GlossaryEntry, LangCode, ProviderId } from './types';
import { DEFAULT_PROVIDER } from './providers';
import { SKILL_VERSION } from '../core/skill/version';

export interface ProviderSettings {
  key: string;
  model: string;
  baseUrl: string;
}

export type DisplayMode = 'replace' | 'bilingual';

export interface Settings {
  version: number;
  sourceLang: LangCode;
  targetLang: LangCode;
  provider: ProviderId;
  providers: Partial<Record<ProviderId, ProviderSettings>>;
  displayMode: DisplayMode;
  /** Translate these attributes too: alt, title, placeholder, aria-label. */
  translateAttributes: boolean;
  /** Also translate the text inside <code> and inline code (off by default). */
  translateCode: boolean;
  /** Translate code comments (inside <pre>/<code>) — the skill explains the rules. */
  translateCodeComments: boolean;
  /** Keep the original block visible under the translation. */
  keepOriginal: boolean;
  /** Automatically translate pages on load for listed hosts. */
  autoTranslateHosts: string[];
  /** Never translate these hosts. */
  excludedHosts: string[];
  /** Skip navigation, footer and other boilerplate. */
  skipBoilerplate: boolean;
  /** Extra instruction appended to the model skill. */
  customInstruction: string;
  /** Use the built-in skill text or replace it entirely with customInstruction. */
  useCustomSkill: boolean;
  glossary: GlossaryEntry[];
  /** Paragraphs per request; larger chunks are cheaper but riskier. */
  chunkSize: number;
  /** Parallel provider requests. */
  concurrency: number;
  /** Seconds before a provider request is aborted. */
  requestTimeoutSec: number;
  /** Cache translations locally to avoid paying twice. */
  cacheEnabled: boolean;
  cacheTtlDays: number;
  /** PDF export options. */
  pdf: {
    includeOriginals: boolean;
    includeMeta: boolean;
    pageSize: 'A4' | 'Letter';
    marginMm: number;
  };
  uiLang: 'ru' | 'en';
  theme: 'auto' | 'light' | 'dark';
  skillVersion: number;
}

export const SETTINGS_VERSION = 3;

export const DEFAULT_SETTINGS: Settings = {
  version: SETTINGS_VERSION,
  sourceLang: 'auto',
  targetLang: 'ru',
  provider: DEFAULT_PROVIDER,
  providers: {
    deepseek: { key: '', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com' },
  },
  displayMode: 'replace',
  translateAttributes: true,
  translateCode: false,
  translateCodeComments: true,
  keepOriginal: true,
  autoTranslateHosts: [],
  excludedHosts: [],
  skipBoilerplate: true,
  customInstruction: '',
  useCustomSkill: false,
  glossary: [],
  chunkSize: 20,
  concurrency: 3,
  requestTimeoutSec: 120,
  cacheEnabled: true,
  cacheTtlDays: 30,
  pdf: {
    includeOriginals: false,
    includeMeta: true,
    pageSize: 'A4',
    marginMm: 14,
  },
  uiLang: 'ru',
  theme: 'auto',
  skillVersion: SKILL_VERSION,
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function clampNumber(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function stringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim().toLowerCase());
}

/** Merge stored data over the defaults, guarding every field. */
export function normalizeSettings(raw: unknown): Settings {
  if (!isRecord(raw)) return structuredCloneSettings(DEFAULT_SETTINGS);
  const base = structuredCloneSettings(DEFAULT_SETTINGS);
  const out: Settings = { ...base, ...(raw as Partial<Settings>) };

  out.version = SETTINGS_VERSION;
  out.sourceLang = typeof raw.sourceLang === 'string' ? raw.sourceLang : base.sourceLang;
  out.targetLang = typeof raw.targetLang === 'string' && raw.targetLang !== 'auto' ? raw.targetLang : base.targetLang;
  out.provider = (typeof raw.provider === 'string' ? raw.provider : base.provider) as ProviderId;
  out.displayMode = raw.displayMode === 'bilingual' ? 'bilingual' : 'replace';
  out.uiLang = raw.uiLang === 'en' ? 'en' : 'ru';
  out.theme = raw.theme === 'light' || raw.theme === 'dark' ? raw.theme : 'auto';

  out.translateAttributes = raw.translateAttributes !== false;
  out.translateCode = raw.translateCode === true;
  out.translateCodeComments = raw.translateCodeComments !== false;
  out.keepOriginal = raw.keepOriginal !== false;
  out.skipBoilerplate = raw.skipBoilerplate !== false;
  out.cacheEnabled = raw.cacheEnabled !== false;
  out.useCustomSkill = raw.useCustomSkill === true;
  out.customInstruction = typeof raw.customInstruction === 'string' ? raw.customInstruction.slice(0, 4000) : '';

  out.autoTranslateHosts = stringList(raw.autoTranslateHosts);
  out.excludedHosts = stringList(raw.excludedHosts);

  out.chunkSize = clampNumber(raw.chunkSize, base.chunkSize, 1, 80);
  out.concurrency = clampNumber(raw.concurrency, base.concurrency, 1, 6);
  out.requestTimeoutSec = clampNumber(raw.requestTimeoutSec, base.requestTimeoutSec, 10, 600);
  out.cacheTtlDays = clampNumber(raw.cacheTtlDays, base.cacheTtlDays, 0, 365);
  out.skillVersion = clampNumber(raw.skillVersion, SKILL_VERSION, 0, 10_000);

  if (isRecord(raw.pdf)) {
    out.pdf = {
      includeOriginals: raw.pdf.includeOriginals === true,
      includeMeta: raw.pdf.includeMeta !== false,
      pageSize: raw.pdf.pageSize === 'Letter' ? 'Letter' : 'A4',
      marginMm: clampNumber(raw.pdf.marginMm, base.pdf.marginMm, 5, 40),
    };
  }

  // Providers: keep known ids only, fill missing defaults from catalogue presets.
  const providers: Partial<Record<ProviderId, ProviderSettings>> = {};
  const storedProviders = isRecord(raw.providers) ? raw.providers : {};
  for (const [id, value] of Object.entries(storedProviders)) {
    if (!isRecord(value)) continue;
    providers[id as ProviderId] = {
      key: typeof value.key === 'string' ? value.key : '',
      model: typeof value.model === 'string' ? value.model : '',
      baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : '',
    };
  }
  out.providers = providers;

  out.glossary = Array.isArray(raw.glossary)
    ? raw.glossary
        .filter(isRecord)
        .map((g) => ({
          source: String(g.source ?? '').trim(),
          target: String(g.target ?? '').trim(),
          site: typeof g.site === 'string' ? g.site.trim().toLowerCase() : undefined,
          caseSensitive: g.caseSensitive === true,
        }))
        .filter((g) => g.source.length > 0 && g.target.length > 0)
        .slice(0, 500)
    : [];

  return out;
}

export function structuredCloneSettings(s: Settings): Settings {
  return JSON.parse(JSON.stringify(s)) as Settings;
}

/** Settings for one provider, falling back to the catalogue preset defaults. */
export function providerSettings(
  settings: Settings,
  id: ProviderId,
  preset: { baseUrl?: string; defaultModel: string },
): ProviderSettings {
  const stored = settings.providers[id];
  return {
    key: stored?.key ?? '',
    model: stored?.model || preset.defaultModel,
    baseUrl: stored?.baseUrl || preset.baseUrl || '',
  };
}

export function isHostExcluded(host: string, settings: Settings): boolean {
  const h = host.toLowerCase();
  return settings.excludedHosts.some((entry) => h === entry || h.endsWith('.' + entry));
}

export function isHostAutoTranslated(host: string, settings: Settings): boolean {
  const h = host.toLowerCase();
  return settings.autoTranslateHosts.some((entry) => h === entry || h.endsWith('.' + entry));
}
