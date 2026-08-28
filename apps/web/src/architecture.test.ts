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
 * Every module specifier a file depends on, in three forms.
 *
 * All three have been escape hatches in an earlier version of this file:
 *
 * - `import … from 'x'` — the obvious one.
 * - `export … from 'x'` — exactly as much of a dependency as an import, and
 *   missed at first. The first version also passed vacuously, because its
 *   pattern matched the word "imports" in a doc comment rather than the
 *   statement below it; hence the comment stripping and the line anchor.
 * - `import 'x'` — a side-effect import with no clause, which pulls the whole
 *   module in while matching neither of the above.
 *
 * A specifier is returned with `clause: null` when there was no clause, which
 * is what lets the type-only rule treat it as a runtime import.
 */
function imports(text: string): { clause: string | null; specifier: string }[] {
  const found: { clause: string | null; specifier: string }[] = [];
  const source = stripComments(text);
  const withClause = /^[ \t]*(?:import|export)\b([\s\S]*?)\bfrom\s*['"]([^'"]+)['"]/gm;
  for (const match of source.matchAll(withClause)) {
    found.push({ clause: match[1]?.trim() ?? '', specifier: match[2] ?? '' });
  }
  const bare = /^[ \t]*import\s*['"]([^'"]+)['"]/gm;
  for (const match of source.matchAll(bare)) {
    found.push({ clause: null, specifier: match[1] ?? '' });
  }
  return found;
}

/** `@strkworld/privacy` itself, or any subpath of it. */
function isSeam(specifier: string): boolean {
  return specifier === '@strkworld/privacy' || specifier.startsWith('@strkworld/privacy/');
}

function isAllowedLobbyImport(specifier: string): boolean {
  return specifier === '@strkworld/lobby/client';
}

const isTest = (path: string): boolean => /\.test\.tsx?$/.test(path);

describe('shell boundaries', () => {
  it('imports only the browser lobby client, never the server entry', () => {
    const offenders = sources()
      .filter(({ path }) => !isTest(path))
      .flatMap(({ path, text }) => imports(text)
        .filter(({ specifier }) => (specifier === '@strkworld/lobby' || specifier.startsWith('@strkworld/lobby/')) && !isAllowedLobbyImport(specifier))
        .map(() => path));
    expect(offenders).toEqual([]);
    expect(isAllowedLobbyImport('@strkworld/lobby/client')).toBe(true);
    expect(isAllowedLobbyImport('@strkworld/lobby/server')).toBe(false);
    expect(isAllowedLobbyImport('@strkworld/lobby')).toBe(false);
    // Adversarial fixture: the scanner must catch a bare server-capable entry,
    // not only a `/server` subpath.
    expect(imports("import { LobbyClient } from '@strkworld/lobby';").some(({ specifier }) =>
      specifier === '@strkworld/lobby' && !isAllowedLobbyImport(specifier),
    )).toBe(true);
  });

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
          .filter(({ clause, specifier }) => isSeam(specifier) && !clause?.startsWith('type'))
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

  it('loads the demo Bridge and 1Click runtime dynamically, never in the entry graph', () => {
    const provider = readFileSync(join(SRC, 'bridge/BridgeProvider.tsx'), 'utf8');
    expect(provider).toContain("import('./demo-runtime.js')");
    expect(imports(provider).map((entry) => entry.specifier)).not.toContain('./demo-runtime.js');
    const runtime = readFileSync(join(SRC, 'bridge/demo-runtime.ts'), 'utf8');
    expect(runtime).toContain("import('@strkworld/privacy')");
  });

  it('hands the production Bridge a dormant loader rather than importing it during wallet bootstrap', () => {
    const main = readFileSync(join(SRC, 'main.tsx'), 'utf8');
    expect(main).toContain("import('./bridge/production-runtime.js')");
    expect(imports(main).map((entry) => entry.specifier)).not.toContain(
      './bridge/production-runtime.js',
    );
    expect(main).toContain('async function loadProductionBridgeRuntime()');
    expect(main).toContain('bridge={{ loadRuntime: loadProductionBridgeRuntime }}');
    expect(main).not.toMatch(/Promise\.all\([\s\S]*production-runtime/);
  });
});
