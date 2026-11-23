/**
 * Few-shot examples appended to the request for small models that tend to drift.
 * They are stored separately from the rules: the rules are normative, examples only
 * show the mechanics of the answer format and the "code is untranslatable" rule.
 */
import type { SkillContext } from './translation-skill';

export interface FewShot {
  segments: { id: number; text: string; context?: string }[];
  answer: string;
}

export function fewShotFor(ctx: Pick<SkillContext, 'targetLang'>): FewShot | null {
  // Only Russian currently has curated examples; other targets rely on the rules alone.
  if (ctx.targetLang !== 'ru') return null;
  return {
    segments: [
      {
        id: 1,
        text: 'The `use_signal` hook returns a `ReadOnlySignal<T>`, so the value can be cloned cheaply.',
        context: 'Leptos book — Reactivity',
      },
      { id: 2, text: 'Run cargo build --release to produce an optimized binary.', context: 'Leptos book — Setup' },
    ],
    answer: [
      '[1] Хук `use_signal` возвращает `ReadOnlySignal<T>`, поэтому значение можно дешево клонировать.',
      '[2] Запустите cargo build --release, чтобы собрать оптимизированный бинарный файл.',
    ].join('\n'),
  };
}

/** Rendered as a trailing reminder, not as conversation turns. */
export function fewShotBlock(fewShot: FewShot): string {
  const segs = fewShot.segments.map((s) => `[${s.id}] ${s.text}`).join('\n');
  return ['EXAMPLE (format only — translate your own segments, not this one):', segs, 'ANSWER:', fewShot.answer].join(
    '\n',
  );
}
