import { describe, it, expect } from './helpers/framework';
import { maskSlots, unmaskSlots } from '../src/core/providers/mt';

/**
 * A context-free service turns `{{0}}…{{/0}}` into `{{0}}…{/0}}`, and that broken marker used
 * to reach the page as literal text. The markers are now swapped for `⟦…⟧` around the request
 * and restored afterwards; when the service still damages them, the segment is rejected and
 * the original text is kept.
 */
describe('slot masking for machine translation', () => {
  it('swaps the braces for markers that survive translation', () => {
    expect(maskSlots('Read {{0}}this{{/0}} now')).toBe('Read \u27E60\u27E7this\u27E6/0\u27E7 now');
  });

  it('restores the original markers', () => {
    const source = 'Read {{0}}this{{/0}} now';
    expect(unmaskSlots(maskSlots(source), source)).toBe(source);
  });

  it('handles several slots and repeated markers', () => {
    const source = '{{0}}a{{/0}} и {{1}}b{{/1}}';
    expect(unmaskSlots(maskSlots(source), source)).toBe(source);
  });

  it('reports damage instead of publishing a broken marker', () => {
    const source = 'Read {{0}}this{{/0}} now';
    // What Google actually returned: the closer lost one brace.
    expect(unmaskSlots('Прочтите \u27E60\u27E7это{/0}} сейчас', source)).toBe(null);
    expect(unmaskSlots('Прочтите это сейчас', source)).toBe(null);
  });

  it('leaves text without slots alone', () => {
    expect(maskSlots('plain text')).toBe('plain text');
    expect(unmaskSlots('обычный текст', 'plain text')).toBe('обычный текст');
  });
});
