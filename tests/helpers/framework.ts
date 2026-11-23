/** Test framework facade: describe/it/expect with a Jest-like surface. */

export const registry: { suite: string[]; name: string; fn: () => unknown | Promise<unknown> }[] = [];
const stack: string[] = [];

export function describe(name: string, fn: () => void): void {
  stack.push(name);
  try {
    fn();
  } finally {
    stack.pop();
  }
}

export function it(name: string, fn: () => unknown | Promise<unknown>): void {
  registry.push({ suite: [...stack], name, fn });
}

export const test = it;

export function beforeEach(): void {
  /* supported by the runner only for top-level suites; no-op here */
}

export function afterEach(): void {
  /* no-op */
}

type Matcher = (actual: unknown) => Record<string, (...args: unknown[]) => void>;

function fail(message: string): never {
  throw new Error(message);
}

function eq(actual: unknown, expected: unknown): boolean {
  if (Object.is(actual, expected)) return true;
  if (typeof actual !== 'object' || typeof expected !== 'object' || actual === null || expected === null) return false;
  return JSON.stringify(actual) === JSON.stringify(expected);
}

export function expect(actual: unknown) {
  const matchers = {
    toBe(expected: unknown) {
      if (!Object.is(actual, expected)) fail(`expected ${inspect(actual)} to be ${inspect(expected)}`);
    },
    toEqual(expected: unknown) {
      if (!eq(actual, expected)) fail(`expected ${inspect(actual)} to equal ${inspect(expected)}`);
    },
    toStrictEqual(expected: unknown) {
      if (!eq(actual, expected)) fail(`expected ${inspect(actual)} to strictly equal ${inspect(expected)}`);
    },
    toBeTruthy() {
      if (!actual) fail(`expected ${inspect(actual)} to be truthy`);
    },
    toBeFalsy() {
      if (actual) fail(`expected ${inspect(actual)} to be falsy`);
    },
    toBeNull() {
      if (actual !== null) fail(`expected ${inspect(actual)} to be null`);
    },
    toBeUndefined() {
      if (actual !== undefined) fail(`expected ${inspect(actual)} to be undefined`);
    },
    toBeDefined() {
      if (actual === undefined) fail('expected value to be defined');
    },
    toContain(expected: unknown) {
      if (typeof actual === 'string') {
        if (!actual.includes(String(expected))) fail(`expected string to contain ${inspect(expected)}`);
        return;
      }
      if (Array.isArray(actual)) {
        if (!actual.some((item) => eq(item, expected))) fail(`expected array to contain ${inspect(expected)}`);
        return;
      }
      fail('toContain requires a string or an array');
    },
    toHaveLength(length: number) {
      const actualLength = (actual as { length?: number })?.length;
      if (actualLength !== length) fail(`expected length ${length}, got ${actualLength}`);
    },
    toMatch(pattern: RegExp | string) {
      const re = typeof pattern === 'string' ? new RegExp(pattern) : pattern;
      if (!re.test(String(actual))) fail(`expected ${inspect(actual)} to match ${re}`);
    },
    toBeGreaterThan(expected: number) {
      if (!((actual as number) > expected)) fail(`expected ${inspect(actual)} > ${expected}`);
    },
    toBeGreaterThanOrEqual(expected: number) {
      if (!((actual as number) >= expected)) fail(`expected ${inspect(actual)} >= ${expected}`);
    },
    toBeLessThan(expected: number) {
      if (!((actual as number) < expected)) fail(`expected ${inspect(actual)} < ${expected}`);
    },
    toBeLessThanOrEqual(expected: number) {
      if (!((actual as number) <= expected)) fail(`expected ${inspect(actual)} <= ${expected}`);
    },
    toThrow(expected?: string | RegExp) {
      if (typeof actual !== 'function') fail('toThrow requires a function');
      let threw = false;
      let message = '';
      try {
        (actual as () => unknown)();
      } catch (err) {
        threw = true;
        message = err instanceof Error ? err.message : String(err);
      }
      if (!threw) fail('expected function to throw');
      if (expected) {
        const re = typeof expected === 'string' ? new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) : expected;
        if (!re.test(message)) fail(`expected thrown message ${inspect(message)} to match ${re}`);
      }
    },
    not: {
      toBe(expected: unknown) {
        if (Object.is(actual, expected)) fail(`expected ${inspect(actual)} not to be ${inspect(expected)}`);
      },
      toEqual(expected: unknown) {
        if (eq(actual, expected)) fail(`expected ${inspect(actual)} not to equal ${inspect(expected)}`);
      },
      toContain(expected: unknown) {
        if (typeof actual === 'string' && actual.includes(String(expected))) {
          fail(`expected string not to contain ${inspect(expected)}`);
        }
        if (Array.isArray(actual) && actual.some((item) => eq(item, expected))) {
          fail(`expected array not to contain ${inspect(expected)}`);
        }
      },
      toMatch(pattern: RegExp | string) {
        const re = typeof pattern === 'string' ? new RegExp(pattern) : pattern;
        if (re.test(String(actual))) fail(`expected ${inspect(actual)} not to match ${re}`);
      },
      toBeNull() {
        if (actual === null) fail('expected value not to be null');
      },
      toBeTruthy() {
        if (actual) fail(`expected ${inspect(actual)} to be falsy`);
      },
      toThrow() {
        if (typeof actual !== 'function') return;
        try {
          (actual as () => unknown)();
        } catch (err) {
          fail(`expected function not to throw, got: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
    },
  };
  return matchers;
}

export function inspect(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value instanceof Map) return `Map(${value.size})`;
  if (value instanceof Set) return `Set(${value.size})`;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
