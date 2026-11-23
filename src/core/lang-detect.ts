/**
 * Language detection for the "auto" source.
 *
 * Uses the browser's own detector when available, then script-based heuristics that are
 * accurate enough to tell the usual suspects apart (Latin languages by stop words,
 * Cyrillic by distinctive letters, CJK by code point ranges).
 */
import type { LangCode } from '../shared/types';

const SCRIPT_RANGES: { lang: string; from: number; to: number }[] = [
  { lang: 'ru', from: 0x0400, to: 0x04ff },
  { lang: 'el', from: 0x0370, to: 0x03ff },
  { lang: 'he', from: 0x0590, to: 0x05ff },
  { lang: 'ar', from: 0x0600, to: 0x06ff },
  { lang: 'hi', from: 0x0900, to: 0x097f },
  { lang: 'th', from: 0x0e00, to: 0x0e7f },
  { lang: 'ka', from: 0x10a0, to: 0x10ff },
  { lang: 'hy', from: 0x0530, to: 0x058f },
  { lang: 'ko', from: 0xac00, to: 0xd7af },
  { lang: 'ja', from: 0x3040, to: 0x30ff },
  { lang: 'zh', from: 0x4e00, to: 0x9fff },
];

const STOP_WORDS: Record<string, string[]> = {
  en: ['the', 'and', 'of', 'to', 'is', 'that', 'with', 'for', 'this', 'you', 'are', 'be', 'it', 'as', 'on'],
  de: ['der', 'die', 'und', 'ist', 'nicht', 'mit', 'für', 'auf', 'ein', 'eine', 'wird', 'den', 'dem', 'des'],
  fr: ['le', 'la', 'les', 'et', 'est', 'des', 'que', 'pour', 'dans', 'une', 'pas', 'sur', 'avec', 'au'],
  es: ['el', 'la', 'los', 'las', 'y', 'es', 'de', 'que', 'para', 'con', 'una', 'por', 'en', 'del'],
  it: ['il', 'la', 'e', 'che', 'di', 'per', 'con', 'una', 'non', 'sono', 'gli', 'dei', 'dal'],
  pt: ['o', 'a', 'os', 'as', 'e', 'é', 'que', 'para', 'com', 'uma', 'não', 'do', 'da', 'em'],
  nl: ['de', 'het', 'een', 'en', 'van', 'is', 'dat', 'voor', 'met', 'niet', 'zijn', 'op', 'aan'],
  pl: ['i', 'w', 'na', 'się', 'nie', 'jest', 'że', 'do', 'od', 'dla', 'oraz', 'jak', 'tak'],
  uk: ['і', 'в', 'на', 'що', 'не', 'з', 'для', 'це', 'як', 'бути', 'по', 'до', 'від'],
  cs: ['a', 'v', 'se', 'na', 'je', 'že', 'do', 'pro', 'to', 'jako', 'není'],
  tr: ['ve', 'bir', 'bu', 'için', 'ile', 'olarak', 'daha', 'de', 'da', 'gibi'],
  id: ['yang', 'dan', 'di', 'untuk', 'dengan', 'ini', 'adalah', 'dari', 'pada', 'tidak'],
  vi: ['và', 'của', 'là', 'có', 'không', 'được', 'trong', 'cho', 'một', 'này'],
  ro: ['și', 'în', 'de', 'la', 'este', 'care', 'pentru', 'cu', 'nu', 'un'],
  hu: ['a', 'az', 'és', 'hogy', 'nem', 'egy', 'van', 'is', 'mint', 'meg'],
  fin: ['ja', 'on', 'ei', 'että', 'se', 'oli', 'kun', 'myös', 'voi'],
  sv: ['och', 'att', 'det', 'är', 'som', 'för', 'på', 'med', 'inte', 'av'],
};

function countByScript(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  let total = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x40) continue;
    if (cp >= 0x0041 && cp <= 0x024f) {
      counts.set('latin', (counts.get('latin') ?? 0) + 1);
      total++;
      continue;
    }
    for (const range of SCRIPT_RANGES) {
      if (cp >= range.from && cp <= range.to) {
        counts.set(range.lang, (counts.get(range.lang) ?? 0) + 1);
        total++;
        break;
      }
    }
  }
  if (total === 0) return counts;
  const normalized = new Map<string, number>();
  for (const [k, v] of counts) normalized.set(k, v / total);
  return normalized;
}

/** Score alternative Latin languages by stop-word overlap. */
function scoreLatin(text: string): { lang: string; score: number }[] {
  const words = text.toLowerCase().match(/[a-zà-öø-ÿœæ]{1,}/g) ?? [];
  if (words.length === 0) return [];
  const set = new Set(words);
  const scores: { lang: string; score: number }[] = [];
  for (const [lang, stops] of Object.entries(STOP_WORDS)) {
    let hits = 0;
    for (const stop of stops) if (set.has(stop)) hits++;
    // Normalise: longer texts should not win just because they repeat the same word.
    scores.push({ lang, score: hits / Math.sqrt(stops.length) });
  }
  return scores.sort((a, b) => b.score - a.score);
}

function cyrillicLanguage(text: string): string {
  const lower = text.toLowerCase();
  const uk = (lower.match(/[іїєґ']/g) ?? []).length;
  const ru = (lower.match(/[ыэёъ]/g) ?? []).length;
  const be = (lower.match(/[ў]/g) ?? []).length;
  if (be > 0) return 'be';
  if (uk > 0 && uk >= ru) return 'uk';
  const bg = (lower.match(/[ъ]/g) ?? []).length;
  if (bg > 2 && ru === 0) return 'bg';
  return 'ru';
}

export interface DetectionResult {
  lang: LangCode;
  confidence: number;
  method: 'browser' | 'script' | 'stopwords';
}

/** Heuristic detection used when the browser detector is unavailable. */
export function detectLanguageHeuristic(text: string): DetectionResult {
  const sample = text.slice(0, 4000);
  const scripts = countByScript(sample);
  let best = { lang: '', share: 0 };
  for (const [lang, share] of scripts) {
    if (share > best.share) best = { lang, share };
  }
  if (!best.lang) return { lang: 'en', confidence: 0.2, method: 'script' };

  if (best.lang === 'latin') {
    const scores = scoreLatin(sample);
    if (scores.length > 0 && scores[0].score > 0) {
      const second = scores[1]?.score ?? 0;
      const confidence = Math.min(0.95, 0.4 + (scores[0].score - second) * 0.2);
      return { lang: scores[0].lang, confidence, method: 'stopwords' };
    }
    return { lang: 'en', confidence: 0.3, method: 'stopwords' };
  }

  if (best.lang === 'ru') {
    return { lang: cyrillicLanguage(sample), confidence: Math.min(0.95, 0.5 + best.share * 0.5), method: 'script' };
  }
  if (best.lang === 'ja') {
    // Japanese mixes kana with Han; Han-only text is Chinese.
    const kana = (sample.match(/[\u3040-\u30ff]/g) ?? []).length;
    const han = (sample.match(/[\u4e00-\u9fff]/g) ?? []).length;
    if (han > kana * 4) return { lang: 'zh', confidence: 0.85, method: 'script' };
    return { lang: 'ja', confidence: 0.85, method: 'script' };
  }
  if (best.lang === 'zh') return { lang: 'zh', confidence: 0.8, method: 'script' };
  return { lang: best.lang, confidence: Math.min(0.9, 0.5 + best.share * 0.4), method: 'script' };
}

/** Browser LanguageDetector API (Chrome 138+ experimental) with a safe fallback. */
export async function detectLanguage(text: string): Promise<DetectionResult> {
  const heuristic = detectLanguageHeuristic(text);
  const detectorCtor = (globalThis as unknown as { LanguageDetector?: unknown }).LanguageDetector as
    | { availability?: () => Promise<string>; create: () => Promise<{ detect: (s: string) => Promise<{ detectedLanguage: string; confidence: number }[]> }> }
    | undefined;
  if (!detectorCtor?.create) return heuristic;
  try {
    if (detectorCtor.availability) {
      const status = await detectorCtor.availability();
      if (status === 'unavailable') return heuristic;
    }
    const detector = await detectorCtor.create();
    const results = await detector.detect(text.slice(0, 2000));
    const best = results?.[0];
    if (best?.detectedLanguage) {
      return {
        lang: best.detectedLanguage.split('-')[0].toLowerCase(),
        confidence: best.confidence ?? 0.5,
        method: 'browser',
      };
    }
  } catch {
    /* fall through to heuristics */
  }
  return heuristic;
}
