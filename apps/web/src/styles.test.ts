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

/** The declarations of the one rule whose whole selector is exactly `selector`. */
function ruleBody(selector: string): string {
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (match[1]!.trim() === selector) return match[2]!;
  }
  throw new Error(`No rule for ${selector}`);
}

function customProperties(body: string): Map<string, string> {
  const properties = new Map<string, string>();
  for (const match of body.matchAll(/(--ui-[a-z-]+)\s*:\s*([^;]+);/g)) properties.set(match[1]!, match[2]!.trim());
  return properties;
}

/** WCAG 2 contrast ratio of two #rrggbb colours. */
function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
      .map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

describe('the degen counter\'s theme (D-067)', () => {
  const exchange = customProperties(ruleBody('.panel[data-building="exchange"]'));
  const degen = customProperties(ruleBody('.panel[data-building="exchange"][data-brand="degen"]'));

  it('re-declares every token the Exchange theme sets, derived ones included', () => {
    expect(exchange.size).toBeGreaterThan(40);
    expect([...exchange.keys()].filter((name) => !degen.has(name))).toEqual([]);
  });

  it('wears neon pink and cyan on navy', () => {
    expect(degen.get('--ui-surface')).toBe('#11131d');
    expect(degen.get('--ui-accent')).toBe('#ff2bd6');
    expect(degen.get('--ui-focus')).toBe('#22d3ee');
  });

  it('keeps every text pair at WCAG AA and the focus ring visible', () => {
    const surface = degen.get('--ui-surface')!;
    for (const token of ['--ui-text', '--ui-text-dim', '--ui-heading', '--ui-accent', '--ui-danger', '--ui-success', '--ui-lock']) {
      expect(contrast(degen.get(token)!, surface), token).toBeGreaterThanOrEqual(4.5);
      expect(contrast(degen.get(token)!, degen.get('--ui-surface-raised')!), token).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast(degen.get('--ui-primary-text')!, degen.get('--ui-primary-bg')!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(degen.get('--ui-primary-text')!, degen.get('--ui-primary-bg-hover')!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(degen.get('--ui-btn-text')!, degen.get('--ui-btn-bg')!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(degen.get('--ui-btn-text')!, degen.get('--ui-btn-bg-hover')!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(degen.get('--ui-input-border')!, surface)).toBeGreaterThanOrEqual(3);
    expect(contrast(degen.get('--ui-focus')!, surface)).toBeGreaterThanOrEqual(3);
    expect(Number.parseFloat(degen.get('--ui-focus-width')!)).toBeGreaterThanOrEqual(2);
    expect(css).toMatch(/\.panel\[data-brand="degen"\] \.degen-board-scroll:focus-visible\s*\{[^}]*outline:/);
  });

  it('scopes every degen rule to the degen counter, so no other window changes', () => {
    // Split a selector list at its top-level commas only, not those inside `:is(…)`.
    const selectorsOf = (prelude: string) => {
      const selectors: string[] = [];
      let depth = 0;
      let current = '';
      for (const character of prelude) {
        if (character === '(') depth += 1;
        if (character === ')') depth -= 1;
        if (character === ',' && depth === 0) {
          selectors.push(current.trim());
          current = '';
        } else {
          current += character;
        }
      }
      return [...selectors, current.trim()];
    };
    let scoped = 0;
    for (const match of css.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
      for (const selector of selectorsOf(match[1]!).filter((candidate) => /degen/.test(candidate))) {
        expect(selector, selector).toMatch(/\[data-brand="degen"\]/);
        scoped += 1;
      }
    }
    expect(scoped).toBeGreaterThan(10);
  });

  it('lays the list out for phone width', () => {
    const phone = css.slice(css.indexOf('@media (max-width: 480px)'));
    expect(phone).toMatch(/\.panel\[data-brand="degen"\] \.degen-chips\s*\{[^}]*flex-basis:\s*100%/);
  });
});

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

describe('the entry gate cards (D-072)', () => {
  it('borrow the window\'s own form controls rather than styling their own', () => {
    for (const selector of ['.panel label', '.panel input', '.panel select']) {
      const rule = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((match) =>
        match[1]!.split(',').map((part) => part.trim()).includes(selector));
      expect(rule, selector).toBeDefined();
      const selectors = rule![1]!.split(',').map((part) => part.trim());
      expect(selectors, selector).toContain(selector.replace('.panel', '.room-entry'));
    }
  });
});

describe('the Vault window\'s theme (D-077)', () => {
  const root = customProperties(ruleBody(':root'));
  const vault = customProperties(ruleBody('.panel[data-building="vault"]'));

  it('re-declares every token the base theme sets, so nothing leaks from the dark game theme', () => {
    expect(root.size).toBeGreaterThan(40);
    expect([...root.keys()].filter((name) => !vault.has(name))).toEqual([]);
  });

  it('wears Vesu: white pages, near-black ink, electric blue and periwinkle', () => {
    expect(vault.get('--ui-surface')).toBe('#ffffff');
    expect(vault.get('--ui-text')).toBe('#0a0a0a');
    expect(vault.get('--ui-accent')).toBe('#2c41f6');
    expect(vault.get('--ui-btn-bg')).toBe('#e0e5ff');
    expect(vault.get('--ui-btn-text')).toBe('#2030b6');
  });

  it('keeps every text pair at WCAG AA and the focus ring visible', () => {
    for (const background of ['--ui-surface', '--ui-surface-raised']) {
      for (const token of ['--ui-text', '--ui-text-dim', '--ui-heading', '--ui-accent', '--ui-danger', '--ui-success', '--ui-warn', '--ui-lock']) {
        expect(contrast(vault.get(token)!, vault.get(background)!), `${token} on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
    }
    expect(contrast(vault.get('--ui-primary-text')!, vault.get('--ui-primary-bg')!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(vault.get('--ui-primary-text')!, vault.get('--ui-primary-bg-hover')!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(vault.get('--ui-btn-text')!, vault.get('--ui-btn-bg')!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(vault.get('--ui-btn-text')!, vault.get('--ui-btn-bg-hover')!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(vault.get('--ui-tab-selected-text')!, vault.get('--ui-tab-selected-bg')!)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(vault.get('--ui-input-border')!, vault.get('--ui-surface')!)).toBeGreaterThanOrEqual(3);
    expect(contrast(vault.get('--ui-focus')!, vault.get('--ui-surface')!)).toBeGreaterThanOrEqual(3);
    expect(Number.parseFloat(vault.get('--ui-focus-width')!)).toBeGreaterThanOrEqual(2);
  });

  it('scopes every Vault rule to the Vault window', () => {
    // Split a selector list at its top-level commas only, not those inside `:is(…)`.
    const selectorsOf = (prelude: string) => {
      const selectors: string[] = [];
      let depth = 0;
      let current = '';
      for (const character of prelude) {
        if (character === '(') depth += 1;
        if (character === ')') depth -= 1;
        if (character === ',' && depth === 0) {
          selectors.push(current.trim());
          current = '';
        } else {
          current += character;
        }
      }
      return [...selectors, current.trim()];
    };
    let scoped = 0;
    for (const match of css.matchAll(/([^{}]+)\{[^{}]*\}/g)) {
      for (const selector of selectorsOf(match[1]!).filter((part) => /vault/.test(part))) {
        expect(selector, selector).toMatch(/^\.panel\[data-building="vault"\]/);
        scoped += 1;
      }
    }
    expect(scoped).toBeGreaterThan(8);
  });
});
