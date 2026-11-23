/** Language catalogue and helpers shared by UI and provider adapters. */

export interface LanguageInfo {
  code: string;
  /** Endonym, always shown in the UI. */
  label: string;
  /** Russian name, used in prompts so the model sees an unambiguous target language. */
  ru: string;
  /** English name, used in prompts for providers tuned to English instructions. */
  en: string;
}

export const LANGUAGES: LanguageInfo[] = [
  { code: 'auto', label: 'Автоопределение', ru: 'автоопределение', en: 'auto-detect' },
  { code: 'ru', label: 'Русский', ru: 'русский', en: 'Russian' },
  { code: 'en', label: 'English', ru: 'английский', en: 'English' },
  { code: 'de', label: 'Deutsch', ru: 'немецкий', en: 'German' },
  { code: 'fr', label: 'Français', ru: 'французский', en: 'French' },
  { code: 'es', label: 'Español', ru: 'испанский', en: 'Spanish' },
  { code: 'it', label: 'Italiano', ru: 'итальянский', en: 'Italian' },
  { code: 'pt', label: 'Português', ru: 'португальский', en: 'Portuguese' },
  { code: 'nl', label: 'Nederlands', ru: 'нидерландский', en: 'Dutch' },
  { code: 'pl', label: 'Polski', ru: 'польский', en: 'Polish' },
  { code: 'uk', label: 'Українська', ru: 'украинский', en: 'Ukrainian' },
  { code: 'cs', label: 'Čeština', ru: 'чешский', en: 'Czech' },
  { code: 'tr', label: 'Türkçe', ru: 'турецкий', en: 'Turkish' },
  { code: 'ar', label: 'العربية', ru: 'арабский', en: 'Arabic' },
  { code: 'he', label: 'עברית', ru: 'иврит', en: 'Hebrew' },
  { code: 'hi', label: 'हिन्दी', ru: 'хинди', en: 'Hindi' },
  { code: 'id', label: 'Bahasa Indonesia', ru: 'индонезийский', en: 'Indonesian' },
  { code: 'ja', label: '日本語', ru: 'японский', en: 'Japanese' },
  { code: 'ko', label: '한국어', ru: 'корейский', en: 'Korean' },
  { code: 'zh', label: '中文', ru: 'китайский', en: 'Chinese' },
  { code: 'vi', label: 'Tiếng Việt', ru: 'вьетнамский', en: 'Vietnamese' },
  { code: 'th', label: 'ไทย', ru: 'тайский', en: 'Thai' },
  { code: 'fa', label: 'فارسی', ru: 'персидский', en: 'Persian' },
  { code: 'sv', label: 'Svenska', ru: 'шведский', en: 'Swedish' },
  { code: 'fi', label: 'Suomi', ru: 'финский', en: 'Finnish' },
  { code: 'ro', label: 'Română', ru: 'румынский', en: 'Romanian' },
  { code: 'hu', label: 'Magyar', ru: 'венгерский', en: 'Hungarian' },
];

const BY_CODE = new Map(LANGUAGES.map((l) => [l.code, l]));

export function languageInfo(code: string): LanguageInfo | undefined {
  return BY_CODE.get(code.split('-')[0].toLowerCase());
}

/** Name of the language as it should be rendered inside a prompt for the model. */
export function languageName(code: string, locale: 'ru' | 'en' = 'ru'): string {
  const info = languageInfo(code);
  if (!info) return code;
  return locale === 'ru' ? info.ru : info.en;
}

/** Name used by machine-translation endpoints (they expect English names). */
export function mtLanguageName(code: string): string {
  const info = languageInfo(code);
  if (!info) return code.toUpperCase();
  return info.en === 'auto-detect' ? 'auto' : info.en;
}

export function isSupportedLang(code: string): boolean {
  return code === 'auto' || BY_CODE.has(code);
}

/** BCP-47 code for the model's target language, e.g. "ru" -> "ru". */
export function promptLangName(code: string): string {
  const info = languageInfo(code);
  if (!info || code === 'auto') return 'the source language';
  return `${info.en} (${info.ru})`;
}
