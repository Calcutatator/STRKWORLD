// @vitest-environment node
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BRAND_COLOURS, BRAND_FONTS } from './tokens.js';

/**
 * The brand token module (D-113): `brand.css` and `tokens.ts` say the same
 * thing, the palette is the approved one, and the faces are self-hosted.
 */
const css = readFileSync(new URL('./brand.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function token(name: string): string | undefined {
  return new RegExp(`${name}\\s*:\\s*([^;]+);`).exec(css)?.[1]?.trim();
}

describe('the brand tokens (D-113)', () => {
  it('declares the approved palette, in step with tokens.ts', () => {
    expect(BRAND_COLOURS).toMatchObject({
      ember: '#f56a16',
      sunGold: '#ffc12e',
      outline: '#24120a',
      horizon: '#f2dcc0',
      sky: '#6f9edb',
      grass: '#86ad55',
    });
    for (const [key, value] of Object.entries(BRAND_COLOURS)) {
      const name = `--brand-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`;
      expect(token(name), name).toBe(value);
    }
  });

  it('names the three faces, each falling back to monospace and never a rounded UI face', () => {
    expect(token('--brand-font-headline')).toMatch(new RegExp(`^"${BRAND_FONTS.headline}"`));
    expect(token('--brand-font-body')).toMatch(new RegExp(`^"${BRAND_FONTS.body}"`));
    expect(token('--brand-font-menu')).toMatch(new RegExp(`^"${BRAND_FONTS.menu}"`));
    // D-121: money amounts are VT323, whose digits stay distinct; Jersey 15's merge.
    expect(token('--brand-font-numeric')).toMatch(new RegExp(`^"${BRAND_FONTS.body}", ui-monospace`));
    expect(token('--brand-font-numeric')).not.toMatch(/Jersey/);
    expect(css).not.toMatch(/rounded|Nunito/i);
  });

  it('self-hosts every face from a bundled, same-origin file', () => {
    const faces = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((match) => match[1]!);
    expect(faces).toHaveLength(4);
    const families = new Set(faces.map((face) => /font-family:\s*"([^"]+)"/.exec(face)?.[1]));
    expect(families).toEqual(new Set(Object.values(BRAND_FONTS)));
    for (const face of faces) {
      expect(face).toMatch(/font-display:\s*swap/);
      const url = /url\("([^"]+)"\)/.exec(face)?.[1];
      expect(url).toMatch(/^\.\/fonts\/[a-z0-9-]+\.woff2$/);
      expect(existsSync(new URL(url!, new URL('./brand.css', import.meta.url))), url).toBe(true);
    }
    expect(css).not.toMatch(/@import|https?:|\/\/fonts\./);
    expect(existsSync(new URL('./fonts/OFL.txt', import.meta.url))).toBe(true);
  });

  it('styles no element, so loading it changes no screen by itself', () => {
    const selectors = [...css.matchAll(/(@?[^{}]+)\{/g)].map((match) => match[1]!.trim()).filter((selector) => selector !== '@font-face');
    expect(selectors).toEqual([':root']);
  });
});
