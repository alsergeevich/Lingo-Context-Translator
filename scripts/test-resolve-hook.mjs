/**
 * Module resolution hook for the test runner.
 *
 * The project uses extensionless relative imports (bundler-style), which Node's ESM
 * resolver rejects. This hook appends the real extension before Node resolves the
 * specifier, so the same sources run both in the bundle and under the test runner.
 */
import { existsSync } from 'node:fs';

const EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.js'];

export async function resolve(specifier, context, nextResolve) {
  if ((specifier.startsWith('./') || specifier.startsWith('../')) && !/\.[cm]?[jt]sx?$/.test(specifier)) {
    if (context.parentURL) {
      for (const ext of EXTENSIONS) {
        const candidate = new URL(specifier + ext, context.parentURL);
        if (existsSync(candidate)) return nextResolve(candidate.href, context);
      }
    }
  }
  return nextResolve(specifier, context);
}
