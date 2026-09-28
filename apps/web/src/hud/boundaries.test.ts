import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Boundaries for the HUD, the guide, the Bridge arrival nudge and the
 * next-step prompts — the same kind of rule `architecture.test.ts` keeps for
 * the whole shell, narrowed to the modules this batch added.
 */
const MODULES = [
  'hud/HudLayer.tsx',
  'hud/hud-model.ts',
  'hud/GettingStarted.tsx',
  'bridge/arrival-nudge.ts',
  'bridge/ArrivalNudgeProvider.tsx',
  'store/viewer-storage.ts',
  'panels/next-step.ts',
  'panels/JourneyNotice.tsx',
] as const;

function imports(path: string): { clause: string; specifier: string }[] {
  const text = readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');
  return [...text.matchAll(/^[ \t]*(?:import|export)\b([\s\S]*?)\bfrom\s*['"]([^'"]+)['"]/gm)].map(
    (match) => ({ clause: match[1]?.trim() ?? '', specifier: match[2] ?? '' }),
  );
}

describe('journey module boundaries', () => {
  it('never reaches the lobby or presence: nothing here can put money in lobby traffic', () => {
    const all = MODULES.flatMap((path) => imports(path).map(({ specifier }) => ({ path, specifier })));
    // Not vacuous: the scanner must be reading real import statements.
    expect(all.length).toBeGreaterThan(20);
    for (const { path, specifier } of all) {
      expect(specifier, path).not.toMatch(/lobby|presence/);
    }
  });

  it('holds only types from the financial seam', () => {
    for (const path of MODULES) {
      for (const { clause, specifier } of imports(path)) {
        if (specifier === '@strkworld/privacy' || specifier.startsWith('@strkworld/privacy/')) {
          expect(clause.startsWith('type'), `${path} imports ${specifier} at runtime`).toBe(true);
        }
      }
    }
  });

  it('reads the Bridge record through persistence alone, keeping 1Click out of the entry graph', () => {
    const runtime = MODULES.flatMap((path) =>
      imports(path)
        .filter(({ specifier }) => specifier.startsWith('@strkworld/bridge'))
        .filter(({ clause }) => !clause.startsWith('type'))
        .map(({ specifier }) => `${path} -> ${specifier}`),
    );
    expect(runtime).toEqual(['bridge/arrival-nudge.ts -> @strkworld/bridge/src/persistence.js']);

    const persistence = readFileSync(
      fileURLToPath(new URL('../../../../packages/bridge/src/persistence.ts', import.meta.url)),
      'utf8',
    );
    const persistenceImports = [...persistence.matchAll(/^[ \t]*import\b([\s\S]*?)\bfrom\s*['"]([^'"]+)['"]/gm)];
    expect(persistenceImports.length).toBeGreaterThan(0);
    for (const [, clause] of persistenceImports) {
      expect(clause?.trim().startsWith('type'), 'persistence.ts gained a runtime import').toBe(true);
    }
  });
});
