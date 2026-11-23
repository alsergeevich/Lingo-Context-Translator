import { describe, it, expect } from './helpers/framework';
import {
  buildSystemPrompt,
  buildUserPrompt,
  buildRepairPrompt,
  detectDomain,
} from '../src/core/skill/translation-skill';
import { DEFAULT_SETTINGS, normalizeSettings } from '../src/shared/settings';

const settings = normalizeSettings(DEFAULT_SETTINGS);

describe('translation skill', () => {
  it('forbids translating code and identifiers', () => {
    const prompt = buildSystemPrompt(settings, { pageHost: 'book.leptos.dev', domain: 'programming' });
    expect(prompt).toContain('NEVER TRANSLATE OR ALTER');
    expect(prompt).toContain('source code of any language');
    expect(prompt).toContain('identifiers');
    expect(prompt).not.toContain('STRIPED');
  });

  it('is context aware: uses page context and keeps terminology consistent', () => {
    const prompt = buildSystemPrompt(settings, { pageHost: 'example.com', domain: 'general' });
    expect(prompt).toContain('CONTEXT AWARENESS');
    expect(prompt).toContain('Keep terminology consistent');
  });

  it('prescribes a machine-checkable output format', () => {
    const prompt = buildSystemPrompt(settings, { pageHost: 'x', domain: 'general' });
    expect(prompt).toContain('[<id>]');
    expect(prompt).toContain('number of blocks must equal');
  });

  it('includes the programming domain guide', () => {
    const prompt = buildSystemPrompt(settings, { pageHost: 'docs.rs', domain: 'programming' });
    expect(prompt).toContain('Programming documentation');
    expect(prompt).toContain('Code examples are never translated');
  });

  it('injects the glossary scoped to a host', () => {
    const custom = normalizeSettings({
      glossary: [
        { source: 'signal', target: 'signal-ru' },
        { source: 'crate', target: 'crate-ru', site: 'book.leptos.dev' },
        { source: 'unrelated', target: 'nope', site: 'other.dev' },
      ],
    });
    const prompt = buildSystemPrompt(custom, { pageHost: 'book.leptos.dev', domain: 'programming' });
    expect(prompt).toContain('signal => signal-ru');
    expect(prompt).toContain('crate => crate-ru');
    expect(prompt).not.toContain('unrelated');
  });

  it('appends the user instruction without dropping the built-in skill', () => {
    const custom = normalizeSettings({ customInstruction: 'Be brief.' });
    const prompt = buildSystemPrompt(custom, { pageHost: 'x', domain: 'general' });
    expect(prompt).toContain('Be brief.');
    expect(prompt).toContain('NEVER TRANSLATE OR ALTER');
  });

  it('replaces the skill entirely when the user asks for it', () => {
    const custom = normalizeSettings({ useCustomSkill: true, customInstruction: 'Only my text.' });
    expect(buildSystemPrompt(custom, { pageHost: 'x', domain: 'general' })).toBe('Only my text.');
  });

  it('honours the code-comment setting', () => {
    const off = buildSystemPrompt(normalizeSettings({ translateCodeComments: false }), {
      pageHost: 'x',
      domain: 'programming',
    });
    expect(off).toContain('returned unchanged');
    const on = buildSystemPrompt(normalizeSettings({ translateCodeComments: true }), {
      pageHost: 'x',
      domain: 'programming',
    });
    expect(on).toContain('must be translated');
  });
});

describe('user prompt', () => {
  it('numbers every segment and includes context lines', () => {
    const prompt = buildUserPrompt({
      segments: [
        { id: 7, text: 'Hello', context: 'Greeting' },
        { id: 8, text: 'World' },
      ],
      sourceLang: 'auto',
      targetLang: 'ru',
      pageTitle: 'Demo',
      pageHost: 'demo.test',
      domain: 'general',
    });
    expect(prompt).toContain('TARGET LANGUAGE: Russian');
    expect(prompt).toContain('[7] Hello');
    expect(prompt).toContain('CONTEXT:');
    expect(prompt).toContain('Greeting');
    expect(prompt).toContain('[8] World');
    expect(prompt).toContain('Return 2 blocks');
  });

  it('mentions auto-detection instead of a fixed source language', () => {
    const prompt = buildUserPrompt({
      segments: [{ id: 1, text: 'x' }],
      sourceLang: 'auto',
      targetLang: 'ru',
      domain: 'general',
    });
    expect(prompt).toContain('auto — detect it');
  });

  it('names the source language when it is fixed', () => {
    const prompt = buildUserPrompt({
      segments: [{ id: 1, text: 'x' }],
      sourceLang: 'de',
      targetLang: 'ru',
      domain: 'general',
    });
    expect(prompt).toContain('SOURCE LANGUAGE: German');
  });
});

describe('repair prompt', () => {
  it('restates the required ids', () => {
    const prompt = buildRepairPrompt('missing 2 segments', [3, 4]);
    expect(prompt).toContain('missing 2 segments');
    expect(prompt).toContain('3, 4');
  });
});

describe('domain detection', () => {
  it('detects programming documentation by host', () => {
    expect(detectDomain('Signals', 'book.leptos.dev', '')).toBe('programming');
    expect(detectDomain('Docs', 'developer.mozilla.org', '')).toBe('programming');
  });

  it('detects programming by code density', () => {
    const body = 'fn main() { let mut x = 1; } const y = 2; impl Foo for Bar { }';
    expect(detectDomain('Anything', 'example.com', body)).toBe('programming');
  });

  it('falls back to general for plain prose', () => {
    const body = 'Today we will talk about how the world around us works and why it matters.';
    expect(detectDomain('Note', 'blog.example.com', body)).toBe('general');
  });

  it('detects marketing pages', () => {
    expect(detectDomain('Shop', 'shop.example.com', 'Buy now, add to cart, get a discount')).toBe('marketing');
  });
});
