// @vitest-environment node
import { readFileSync } from 'node:fs';
import { AVATAR_WALKER } from '@strkworld/world';
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

  it('pins the rest of Vesu\'s light theme: its page grey, hairlines, 8 px controls and blue primary', () => {
    expect(Object.fromEntries(['--ui-page', '--ui-surface-raised', '--ui-surface-sunken', '--ui-line', '--ui-line-subtle', '--ui-text-dim', '--ui-focus'].map((name) => [name, vault.get(name)]))).toEqual({
      '--ui-page': '#f5f5f5',
      '--ui-surface-raised': '#f5f5f5',
      '--ui-surface-sunken': '#fbfbfb',
      '--ui-line': '#e8e8e8',
      '--ui-line-subtle': 'rgb(0 0 0 / 0.07)',
      '--ui-text-dim': '#666666',
      '--ui-focus': '#2030b6',
    });
    // Vesu's buttons and fields are 8 px round on 16 px panels: no pills.
    expect(vault.get('--ui-radius-button')).toBe('8px');
    expect(vault.get('--ui-radius-control')).toBe('8px');
    expect(vault.get('--ui-radius-panel')).toBe('16px');
    expect(vault.get('--ui-primary-bg')).toBe('#2c41f6');
    expect(vault.get('--ui-primary-text')).toBe('#ffffff');
    expect(vault.get('--ui-tab-selected-bg')).toBe('#2c41f6');
    // Flat, as Vesu's are: no 3D edge, no glow.
    expect(vault.get('--ui-btn-depth')).toBe('0px');
    expect(vault.get('--ui-primary-glow')).toBe('0 0 #0000');
    // Its faces are named first and approximated by system ones: Nunito Sans
    // by Avenir Next, Base Neue Wide by the system face widened.
    expect(vault.get('--ui-font')).toMatch(/^"Nunito Sans", "Avenir Next", Avenir, /);
    expect(vault.get('--ui-heading-font')).toMatch(/^"Base Neue", system-ui, /);
    expect(vault.get('--ui-heading-weight')).toBe('600');
    expect(css).toMatch(/\.panel\[data-building="vault"\] :is\(\.panel-header h2, [^{]*\)\s*\{[^}]*font-stretch:\s*125%/);
  });

  it('loads no font and fetches nothing: its one image, Vesu\'s mark, is inline', () => {
    expect(css).not.toMatch(/@font-face|@import/);
    // Every stylesheet url() is a quoted inline SVG (whose own url(#…) fills
    // stay inside it); nothing else names a resource.
    const quoted = /url\(\s*"([^"]*)"\s*\)/g;
    const urls = [...css.matchAll(quoted)].map((match) => match[1]!);
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url.startsWith('data:image/svg+xml,'), url.slice(0, 40)).toBe(true);
    expect(css.replace(quoted, '')).not.toMatch(/url\(/);
    const mark = ruleBody('.panel[data-building="vault"] > .panel-card > .panel-header::before');
    expect(mark).toMatch(/content:\s*""/);
    expect(mark).toMatch(/background:\s*url\("data:image\/svg\+xml,/);
    // The logo's own colours: the bar's ink and teal, the triangle's gold and orange.
    for (const colour of ['0a0a0a', '008bad', 'd9b91d', 'eb7700']) expect(mark).toContain(`%23${colour}`);
  });

  it('adds no motion of its own, so reduced motion has nothing to stop', () => {
    let rules = 0;
    for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/data-building="vault"/.test(match[1]!)) continue;
      rules += 1;
      expect(match[2], match[1]!.trim()).not.toMatch(/(^|[;\s])(animation|transition)\s*:/);
    }
    expect(rules).toBeGreaterThan(20);
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

/**
 * A checkbox styled as a text field is a full-width box with its tick in the
 * middle, far from its label (the Vault's "Redeem everything" did exactly
 * this). Text-field rules must leave checkboxes and radios out, and those get
 * their own small box.
 */
describe('form controls', () => {
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selectors: match[1]!.split(',').map((selector) => selector.trim()),
    body: match[2]!,
  }));

  it('never stretches a checkbox or radio across the row', () => {
    for (const rule of rules.filter((candidate) => /width:\s*100%/.test(candidate.body))) {
      for (const selector of rule.selectors) {
        expect(selector).not.toMatch(/^\.(panel|room-entry) input$/);
        expect(selector).not.toMatch(/input\[type="(checkbox|radio)"\]$/);
      }
    }
  });

  it('gives checkboxes and radios their own compact box', () => {
    const box = rules.find((rule) => rule.selectors.includes('.panel input[type="checkbox"]') && /width:\s*1\.1rem/.test(rule.body));
    expect(box, 'a compact checkbox rule').toBeDefined();
    expect(box!.selectors).toContain('.panel input[type="radio"]');
  });
});

/** The body of every at-rule whose prelude is exactly `prelude`, braces matched. */
function atRuleBodies(prelude: string): string[] {
  const bodies: string[] = [];
  for (let start = css.indexOf(`${prelude} {`); start !== -1; start = css.indexOf(`${prelude} {`, start + 1)) {
    const open = css.indexOf('{', start);
    let depth = 0;
    for (let index = open; index < css.length; index += 1) {
      if (css[index] === '{') depth += 1;
      else if (css[index] === '}' && --depth === 0) {
        bodies.push(css.slice(open + 1, index));
        break;
      }
    }
  }
  return bodies;
}

/**
 * The wallet cue's walker (D-058): the World's pre-rendered strip of the 3D
 * figure, standing in its first cell and walking through the rest. The CSS
 * numbers must be the strip's, or the cue would show half a figure or skip.
 */
describe("the wallet cue's walker (D-058)", () => {
  const walker = ruleBody('.wallet-attention-walker');
  const cell = AVATAR_WALKER.cellSize;

  it("steps through the strip's walking cells over one stride", () => {
    expect(walker).toMatch(new RegExp(
      `animation:\\s*wallet-attention-walk ${AVATAR_WALKER.strideMs}ms steps\\(${AVATAR_WALKER.walkFrames}\\) infinite;`,
    ));
    const frames = atRuleBodies('@keyframes wallet-attention-walk');
    expect(frames).toHaveLength(1);
    // From the first walking cell to one past the last: steps() never shows its end.
    expect(frames[0]).toMatch(new RegExp(`from\\s*\\{\\s*transform:\\s*translateX\\(-${cell}px\\);\\s*\\}`));
    expect(frames[0]).toMatch(new RegExp(
      `to\\s*\\{\\s*transform:\\s*translateX\\(-${AVATAR_WALKER.cells * cell}px\\);\\s*\\}`,
    ));
  });

  it('shows the standing cell when motion is reduced', () => {
    // At rest the strip sits unmoved in the slot, so its first cell shows.
    expect(walker).toMatch(/top:\s*0;/);
    expect(walker).toMatch(/left:\s*0;/);
    expect(walker).not.toMatch(/transform|translate/);
    const reduced = atRuleBodies('@media (prefers-reduced-motion: reduce)')
      .flatMap((body) => [...body.matchAll(/([^{}]+)\{([^{}]*)\}/g)])
      .filter((match) => match[1]!.split(',').map((selector) => selector.trim()).includes('.wallet-attention-walker'));
    expect(reduced.map((match) => match[2]!.trim())).toEqual(['animation: none;']);
  });

  it("fills the old sprite's 64px slot, on a light disc that sets it off the dark card", () => {
    const slot = ruleBody('.wallet-attention-avatar');
    expect(slot).toMatch(new RegExp(`width:\\s*${cell}px;`));
    expect(slot).toMatch(new RegExp(`height:\\s*${cell}px;`));
    expect(slot).toMatch(/overflow:\s*hidden;/);
    expect(ruleBody('.wallet-attention-cue')).toMatch(new RegExp(`grid-template-columns:\\s*${cell}px `));
    const stops = [...ruleBody('.wallet-attention-avatar::before').matchAll(/#[0-9a-f]{6}/g)].map((match) => match[0]);
    expect(stops).toHaveLength(2);
    for (const stop of stops) {
      for (const card of ['#33271e', '#271d17']) expect(contrast(stop, card)).toBeGreaterThanOrEqual(7);
    }
    expect(css).not.toMatch(/wallet-attention-avatar-sheet|pixelated/);
  });
});
