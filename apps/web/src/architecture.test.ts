import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Boundary rules the shell cannot express in types.
 *
 * Both are one-line mistakes with consequences a long way from the line, and
 * both were made once already in this lane.
 */

const SRC = fileURLToPath(new URL('.', import.meta.url));

function sources(): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) {
        out.push({ path: relative(SRC, full), text: readFileSync(full, 'utf8') });
      }
    }
  };
  walk(SRC);
  return out;
}

/**
 * Comments out, so prose that names a rule cannot trip it.
 *
 * Line-comment stripping is done per line rather than by pattern, because a
 * `//` inside a string literal would otherwise eat the rest of the line. Same
 * approach, and the same reason, as `scripts/check-invariants.sh`.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n');
}

/**
 * Module specifiers, from both `import ... from` and `export ... from`.
 *
 * A re-export is exactly as much of a dependency as an import — this file's
 * first version missed that, and passed only because a sentence in a comment
 * happened to contain the word "imports". Anchoring each statement to the start
 * of a line is what stops prose matching.
 */
function imports(text: string): { clause: string; specifier: string }[] {
  const found: { clause: string; specifier: string }[] = [];
  const pattern = /^[ \t]*(?:import|export)\b([\s\S]*?)\bfrom\s*['"]([^'"]+)['"]/gm;
  for (const match of stripComments(text).matchAll(pattern)) {
    found.push({ clause: match[1]?.trim() ?? '', specifier: match[2] ?? '' });
  }
  return found;
}

const isTest = (path: string): boolean => /\.test\.tsx?$/.test(path);

describe('shell boundaries', () => {
  it('holds no runtime import of the financial seam outside the lazy demo module', () => {
    // `@strkworld/privacy` re-exports the wallet adapter, which pulls
    // `starknet` — roughly 900 kB. A single value import anywhere in the eager
    // graph puts all of it in the entry chunk, and the shell must be able to
    // render a connect screen without loading the chain. Types are erased and
    // cost nothing; `demo-operations.ts` is the deliberate exception and is
    // reached only through a dynamic import.
    const offenders = sources()
      .filter(({ path }) => !isTest(path) && path !== 'privacy/demo-operations.ts')
      .flatMap(({ path, text }) =>
        imports(text)
          .filter(({ clause, specifier }) => specifier === '@strkworld/privacy' && !clause.startsWith('type'))
          .map(() => path),
      );
    expect(offenders).toEqual([]);
  });

  it('reaches into the shared package by deep path in exactly one file', () => {
    // `packages/shared` declares no `exports` map, so the approved disclosures
    // are only reachable by deep path today. Adding one would break every such
    // import at once, so there is only ever one to fix.
    // Imports, not raw text: a comment naming the path in order to explain the
    // rule must not trip the rule.
    const offenders = new Set(
      sources().flatMap(({ path, text }) =>
        imports(text)
          .filter(({ specifier }) => specifier.startsWith('@strkworld/shared/src/'))
          .map(() => path),
      ),
    );
    expect([...offenders]).toEqual(['privacy/register.ts']);
  });

  it('loads the demo seam dynamically, never statically', () => {
    const provider = readFileSync(join(SRC, 'privacy/PrivacyProvider.tsx'), 'utf8');
    expect(provider).toContain("import('./demo-operations.js')");
    expect(imports(provider).map((entry) => entry.specifier)).not.toContain('./demo-operations.js');
  });
});
