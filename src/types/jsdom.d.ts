/**
 * Minimal ambient declarations for the test-only dependencies.
 *
 * `jsdom` and the Node test APIs are used exclusively by tests and tooling; installing the
 * full DefinitelyTyped packages would add weight for two type names, so the shapes actually
 * used are declared here.
 */
declare module 'jsdom' {
  export interface JSDOMOptions {
    url?: string;
    pretendToBeVisual?: boolean;
    runScripts?: 'dangerously' | 'outside-only';
  }

  export class JSDOM {
    constructor(html?: string, options?: JSDOMOptions);
    readonly window: Window & typeof globalThis;
    serialize(): string;
  }
}
