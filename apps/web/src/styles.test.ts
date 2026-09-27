// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * Layout rules jsdom cannot see. The window card must never be positioned: the
 * Bridge's nested shield window is laid out against the outer `.panel`, and a
 * positioned card traps and clips it once the card has scrolled (a review
 * finding against the NEAR theme's crosshair motif).
 */
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Every rule whose selector list ends at `.panel-card` itself (not a descendant or pseudo-element). */
function cardRules(): string[] {
  const rules: string[] = [];
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1]!.split(',').map((selector) => selector.trim());
    if (selectors.some((selector) => /\.panel-card$/.test(selector))) rules.push(match[2]!);
  }
  return rules;
}

describe('window layout rules', () => {
  it('finds the card rules it guards', () => {
    expect(cardRules().length).toBeGreaterThan(0);
  });

  it('never positions the window card, in any theme', () => {
    for (const body of cardRules()) {
      expect(body).not.toMatch(/(^|[;\s])position\s*:\s*(relative|absolute|fixed|sticky)/);
    }
  });
});
