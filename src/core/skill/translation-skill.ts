/**
 * The translation skill: the instruction set sent to a language model with every request.
 *
 * Requirements it encodes (see the product spec):
 *  - translation is context-aware: the document domain, page section and the surrounding
 *    paragraph all inform the wording;
 *  - source code, identifiers, CLI flags, paths, URLs and versions are never translated;
 *  - terminology is consistent and honours the user glossary;
 *  - the structure of the answer is machine-checkable (one numbered block per segment).
 *
 * The skill is versioned by SKILL_VERSION so cached translations are invalidated when
 * the wording of the instructions changes.
 */
import type { Segment } from '../../shared/types';
import { languageName } from '../../shared/languages';
import type { Settings } from '../../shared/settings';

export interface SkillContext {
  targetLang: string;
  sourceLang: string;
  pageTitle?: string;
  pageHost?: string;
  topicHint?: string;
  segmentCount: number;
}

export const SKILL_ID = 'context-translation';
export const SKILL_TITLE = 'Перевод с учётом контекста';

/**
 * Domain heuristics: the model is told which register to use, and which tokens are
 * technical identifiers it must leave alone.
 */
export type Domain = 'programming' | 'technical' | 'academic' | 'legal' | 'marketing' | 'news' | 'forum' | 'general';

export function detectDomain(pageTitle: string | undefined, host: string | undefined, sampleText: string): Domain {
  const haystack = `${pageTitle ?? ''} ${host ?? ''}`.toLowerCase();
  const body = sampleText.toLowerCase();

  const programmingHosts = [
    'github', 'gitlab', 'stackoverflow', 'stackexchange', 'docs.rs', 'developer.mozilla', 'devdocs',
    'npmjs', 'pypi', 'crates.io', 'readthedocs', 'rust-lang', 'docs.python', 'learn.microsoft',
    'book.leptos', 'leptos', 'vuejs', 'reactjs', 'nodejs', 'kotlinlang', 'golang', 'rustdoc',
  ];
  if (programmingHosts.some((h) => haystack.includes(h))) return 'programming';

  const codeSignals = [
    'fn ', 'const ', 'let mut', 'function ', 'class ', 'import ', 'public static', 'def ', '=>', '();',
    'impl ', 'cargo ', 'npm ', 'pip install', 'git clone', 'stdout', 'return ', '#include', 'println!',
  ];
  const codeHits = codeSignals.reduce((acc, s) => acc + (body.split(s).length - 1), 0);
  if (codeHits >= 3) return 'programming';
  if (codeHits >= 1 && /\b(api|sdk|http|json|cli|config|regex|database)\b/.test(body)) return 'programming';

  if (/\b(terms of service|privacy policy|agreement|liability|user agreement)\b/.test(haystack)) return 'legal';
  if (/\b(price|buy|cart|discount|sale|shipping|order now)\b/.test(body)) return 'marketing';
  if (/\b(abstract|et al\.|doi|references|hypothesis)\b/.test(body)) return 'academic';
  if (/\b(reply|quote|thread|upvote|karma|comment)\b/.test(haystack)) return 'forum';
  if (/\b(breaking|reuters|reported|according to)\b/.test(body)) return 'news';
  if (/\b(install|configure|usage|parameters|returns|example)\b/.test(body)) return 'technical';
  return 'general';
}

const DOMAIN_GUIDE: Record<Domain, string> = {
  programming:
    'Programming documentation or source discussion. Keep every identifier, type, macro, crate/package name, ' +
    'CLI invocation, file path and error message exactly as written. Translate prose only. ' +
    'Code examples are never translated; code comments follow the CODE COMMENTS rule.',
  technical:
    'Technical prose. Prefer established industry terminology of the target language, keep product and API names as-is.',
  academic:
    'Academic prose. Keep a neutral formal register, preserve citations, footnotes and reference numbers.',
  legal:
    'Legal text. Translate precisely and literally, never simplify, keep defined terms consistent with the glossary.',
  marketing:
    'Marketing copy. Adapt idiomatically for the target audience rather than word-for-word; keep brand names untouched.',
  news: 'News reporting. Neutral journalistic register, keep names and quotations accurate.',
  forum: 'User discussion. Conversational register, keep quoted user names and code snippets untouched.',
  general: 'General web text. Natural, fluent register of the target language.',
};

/** Rules that never change, regardless of the user's settings. */
const CORE_RULES = `You are a professional translator working inside a browser extension. You translate web page text into the target language with full awareness of context. You never summarise, explain, expand or comment — you only translate.

## WHAT YOU RECEIVE
Each request contains:
1. TARGET LANGUAGE and SOURCE LANGUAGE (the source may be "auto" — detect it yourself).
2. PAGE CONTEXT: the page title, the site host, the document domain and the surrounding paragraph for every segment.
3. GLOSSARY: mandatory term translations (may be empty).
4. SEGMENTS: the text units to translate, each prefixed with an id in square brackets.

## WHAT YOU MUST NEVER TRANSLATE OR ALTER
These stay byte-for-byte identical to the source:
- source code of any language, including code shown inline;
- identifiers, function/type/variable/module names, API and SDK names, crate and package names;
- command-line invocations, flags and options (--release, -rf, /S, etc.);
- file paths, URLs, email addresses, hostnames, version numbers, semantic version ranges;
- placeholders and technical tokens written between ⟪ ⟫, ⟦ ⟧, {{ }}, {0}, %s, %d, $1, <tag> attributes;
- numbers, units, dates, ISO codes, hashes, UUIDs, regexes, JSON/YAML/TOML fragments;
- emoji, punctuation that carries meaning, and the Markdown/HTML markers already present.

## INLINE SLOTS
Segments may contain numbered slots written as {{0}}…{{/0}}. A slot is an inline element of
the page: a link, an abbreviation, an inline-code fragment or an image. The markers must be
copied into your translation exactly as they are, both the opening and the closing marker:
- never delete, duplicate, renumber or reorder a slot pair;
- the text between {{n}} and {{/n}} is the slot's own label; translate that label in place
  (a link titled "Read the guide" should stay a slot with a translated label);
- move a slot pair as a unit when the target language needs a different word order;
- if a slot pair contains only code or an identifier, leave its content unchanged.
Leaving out or unbalancing a slot breaks the page, so this rule overrides stylistic
preferences.

## CONTEXT AWARENESS
- Use PAGE CONTEXT to resolve ambiguity: a word in programming documentation rarely means the same as in a shop or a legal notice. Choose the sense that fits the document, the section heading and the surrounding paragraph.
- Keep terminology consistent inside one document: once you pick a translation for a term, reuse it in every later segment of the same page.
- Follow the domain guide below. Do not mix registers: no marketing tone inside documentation, no slang inside a legal text.
- If a segment is a heading, a button label or a short UI string, translate it as UI copy: short, imperative where appropriate, no trailing period added.
- If a segment is already in the target language, return it unchanged.
- Never merge, split, reorder or drop segments.

## CODE COMMENTS RULE
Code itself is never sent to you. If a segment is explicitly a code comment (it may be marked as such), translate the comment text while keeping its comment syntax (//, #, /* */, <!-- -->), indentation and any doc-comment markup intact. If the user disabled comment translation, return such segments unchanged.

## OUTPUT FORMAT — STRICT
Return exactly one block per input segment, in the same order, in this form:

[<id>] <translated text>

Rules for the answer:
- Start every block with the id in square brackets, exactly as given.
- The translated text may span several lines; the next block starts at the next "[<id>]" at the beginning of a line.
- Output nothing before the first block and nothing after the last one: no preamble, no explanation, no code fences, no notes.
- The number of blocks must equal the number of input segments.
- If a segment cannot be translated (it is pure code, a lone identifier, an empty string), repeat it unchanged in its block.`;

function glossaryBlock(settings: Settings, host: string | undefined): string {
  const entries = settings.glossary.filter((g) => !g.site || !host || host.toLowerCase().includes(g.site));
  if (entries.length === 0) return 'GLOSSARY: (empty)\n';
  const lines = entries.map((g) => `- ${g.source} => ${g.target}`).join('\n');
  return `GLOSSARY (apply exactly; overrides any other choice):\n${lines}\n`;
}

export function buildSystemPrompt(
  settings: Settings,
  ctx: {
    pageTitle?: string;
    pageHost?: string;
    domain: Domain;
    topicHint?: string;
  },
): string {
  if (settings.useCustomSkill && settings.customInstruction.trim()) {
    return settings.customInstruction.trim();
  }

  const parts = [
    CORE_RULES,
    '',
    `## DOMAIN\n${DOMAIN_GUIDE[ctx.domain]}`,
    '',
    glossaryBlock(settings, ctx.pageHost).trimEnd(),
    '',
    `## TERMINOLOGY\nUse recognised terminology of the target language. Prefer the form a native speaker of that language would search for. When a technical term has no established translation, keep the original term and, on first use only, give the translation in parentheses.`,
    '',
    `## STYLE\nWrite natural, idiomatic ${languageName(settings.targetLang, 'en')}. Avoid machine-translation artefacts, calques and unnecessary anglicisms. Preserve the author's tone and level of formality. Preserve the original sentence order unless the target language demands otherwise.`,
  ];

  if (settings.translateCodeComments) {
    parts.push('', '## CODE COMMENTS\nCode comment segments must be translated; keep the comment markers and indentation intact.');
  } else {
    parts.push('', '## CODE COMMENTS\nCode comment segments must be returned unchanged.');
  }

  if (settings.customInstruction.trim()) {
    parts.push('', `## ADDITIONAL INSTRUCTIONS FROM THE USER\n${settings.customInstruction.trim()}`);
  }

  return parts.join('\n');
}

/** Human-readable summary shown in the settings page. */
export function skillPreview(settings: Settings, host = 'example.com'): string {
  const domain: Domain = 'programming';
  return buildSystemPrompt(settings, {
    pageTitle: 'A programming guide',
    pageHost: host,
    domain,
  });
}

const CONTEXT_MARK_OPEN = '⟪';
const CONTEXT_MARK_CLOSE = '⟫';

export interface UserPromptOptions {
  segments: Segment[];
  sourceLang: string;
  targetLang: string;
  pageTitle?: string;
  pageHost?: string;
  topicHint?: string;
  domain: Domain;
}

export function buildUserPrompt(opts: UserPromptOptions): string {
  const { segments } = opts;
  const lines: string[] = [];

  lines.push(`TARGET LANGUAGE: ${languageName(opts.targetLang, 'en')} (${languageName(opts.targetLang, 'ru')})`);
  lines.push(
    opts.sourceLang === 'auto'
      ? 'SOURCE LANGUAGE: auto — detect it, then translate into the target language.'
      : `SOURCE LANGUAGE: ${languageName(opts.sourceLang, 'en')}`,
  );

  const ctxLines: string[] = [];
  if (opts.pageTitle) ctxLines.push(`- title: ${opts.pageTitle.slice(0, 200)}`);
  if (opts.pageHost) ctxLines.push(`- site: ${opts.pageHost}`);
  ctxLines.push(`- domain: ${opts.domain}`);
  if (opts.topicHint) ctxLines.push(`- user note: ${opts.topicHint.slice(0, 300)}`);
  lines.push('PAGE CONTEXT:\n' + ctxLines.join('\n'));

  lines.push(`SEGMENTS (${segments.length}):`);
  for (const seg of segments) {
    lines.push(`[${seg.id}] ${seg.text}`);
    if (seg.context) {
      lines.push(`  CONTEXT: ${CONTEXT_MARK_OPEN}${seg.context}${CONTEXT_MARK_CLOSE}`);
    }
  }

  lines.push('');
  lines.push(`Return ${segments.length} blocks, ids ${segments.map((s) => s.id).join(', ')}, in that order.`);
  return lines.join('\n');
}

/** Repair instruction when the model's answer failed validation. */
export function buildRepairPrompt(problem: string, expectedIds: number[]): string {
  return [
    'Your previous answer did not match the required format.',
    `Problem: ${problem}`,
    `Required ids, in this order: ${expectedIds.join(', ')}.`,
    'Return every segment again in the "[id] text" form, nothing else.',
  ].join('\n');
}
