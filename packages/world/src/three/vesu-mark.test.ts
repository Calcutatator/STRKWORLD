import { Color, SRGBColorSpace, Vector3 } from 'three';
import { describe, expect, it } from 'vitest';
import {
  BUILDING_THEMES,
  GeometryBin,
  MARK_COLUMNS,
  MARK_ROWS,
  ROOM_THEMES,
  VESU,
  VESU_LABEL,
  VESU_MARK,
  VESU_BORROW_STATION_THEME,
  VESU_STATION_THEME,
  addVesuMark,
  vesuMarkColour,
  vesuMarkOutlines,
  type Face,
} from './palette.js';

/**
 * Vesu's palette and mark, as the Vault wears them (D-077): the tokens
 * measured from vesu.xyz's stylesheet, the V's gradients sampled from its
 * logo art, and the relief the street, the room and the counter build from
 * them. The street's and room's own tests cover where the V stands.
 */

const hex = (value: Color): number => value.getHex(SRGBColorSpace);

describe('Vesu\'s palette', () => {
  it('pins the light theme measured from vesu.xyz', () => {
    expect(VESU).toEqual({
      white: 0xffffff,
      page: 0xf5f5f5,
      fill: 0xe8e8e8,
      ink: 0x0a0a0a,
      muted: 0x808080,
      blue: 0x2c41f6,
      blueSoft: 0xe0e5ff,
      blueText: 0x2030b6,
      night: 0x182062,
    });
    expect(Object.isFrozen(VESU)).toBe(true);
  });

  it('dresses the Vault\'s facade, room, counter and label in it', () => {
    expect(BUILDING_THEMES.vault).toMatchObject({ wall: VESU.white, wallAlt: VESU.fill, glow: VESU.blue, openPortal: VESU.blue });
    expect(BUILDING_THEMES.vault!.brand).toMatchObject({ text: 'vesu', style: { lowercase: true, foreground: '#0a0a0a' } });
    expect(ROOM_THEMES.vault).toMatchObject({ floorA: VESU.white, floorB: VESU.page, trim: VESU.blue, label: VESU_LABEL });
    // D-099: lending's two counters wear the supply card, borrowing's two the loan card.
    expect(ROOM_THEMES.vault!.stations).toEqual({
      'vault:supply': VESU_STATION_THEME,
      'vault:redeem': VESU_STATION_THEME,
      'vault:borrow': VESU_BORROW_STATION_THEME,
      'vault:repay': VESU_BORROW_STATION_THEME,
    });
    expect(ROOM_THEMES.vault!.stations!['vault:borrow']).toBe(VESU_BORROW_STATION_THEME);
    // Borrowing (D-083) is lending's twin, so the two read as one brand: only its props differ.
    const { props: borrowProps, ...borrowDress } = VESU_BORROW_STATION_THEME;
    const { props: lendingProps, ...lendingDress } = VESU_STATION_THEME;
    expect([borrowProps, lendingProps]).toEqual(['vesu-borrow', 'vesu']);
    expect(borrowDress).toEqual(lendingDress);
    expect(VESU_BORROW_STATION_THEME.plate).toBe(VESU_STATION_THEME.plate);
    expect(VESU_BORROW_STATION_THEME.label).toBe(VESU_LABEL);
    expect(Object.isFrozen(VESU_BORROW_STATION_THEME)).toBe(true);
    expect(VESU_STATION_THEME).toMatchObject({ props: 'vesu', kioskBase: VESU.white, kioskTrim: VESU.ink });
    expect(VESU_STATION_THEME.plate).toMatchObject({ text: 'vesu', style: { background: '#ffffff', foreground: '#0a0a0a', titleStretch: 1.4 } });
    expect(VESU_LABEL).toMatchObject({ foreground: '#2030b6', background: 'rgba(224,229,255,0.96)', border: '#2c41f6', font: 'sans' });
  });
});

describe('Vesu\'s mark', () => {
  it('keeps both art versions\' gradients: a bar from its foot up, a seven by five triangle grid', () => {
    expect(MARK_ROWS).toHaveLength(7);
    expect(MARK_COLUMNS).toHaveLength(5);
    for (const variant of ['light', 'dark'] as const) {
      const { bar, triangle } = VESU_MARK[variant];
      expect(bar[0]![0]).toBe(0);
      expect(bar.at(-1)![0]).toBe(1);
      for (let i = 1; i < bar.length; i++) expect(bar[i]![0]).toBeGreaterThan(bar[i - 1]![0]);
      expect(triangle).toHaveLength(MARK_ROWS.length);
      for (const row of triangle) expect(row).toHaveLength(MARK_COLUMNS.length);
    }
    // Sampled from vesu.xyz/img/vesu-logo-light-mobile.png and -dark-mobile.png.
    expect(VESU_MARK.light.bar[0]![1]).toBe(VESU.ink);
    expect(VESU_MARK.light.triangle[0]![0]).toBe(0xc7d149);
    expect(VESU_MARK.light.triangle[3]![0]).toBe(0xeb7700);
    expect(VESU_MARK.dark.bar[0]![1]).toBe(0xfafeff);
    expect(VESU_MARK.dark.triangle[0]![4]).toBe(0xc5fde6);
  });

  it('lays out a leaning bar and a rounded triangle a gap apart, inside the unit box', () => {
    const { bar, triangle } = vesuMarkOutlines();
    for (const [u, v] of [...bar, ...triangle]) {
      expect(u).toBeGreaterThanOrEqual(-0.5 - 1e-9);
      expect(u).toBeLessThanOrEqual(0.5 + 1e-9);
      expect(v).toBeGreaterThanOrEqual(-1e-9);
      expect(v).toBeLessThanOrEqual(1 + 1e-9);
    }
    // The bar leans right as it falls, as the logo's does.
    const barFoot = bar.filter(([, v]) => v === 0).map(([u]) => u);
    const barTop = bar.filter(([, v]) => v === 1).map(([u]) => u);
    expect(Math.min(...barFoot)).toBeGreaterThan(Math.min(...barTop));
    // The triangle's tip is rounded up to the foot line, its top flat at the top.
    const tip = Math.min(...triangle.map(([, v]) => v));
    expect(tip).toBeGreaterThan(0);
    expect(tip).toBeLessThan(0.03);
    expect(Math.max(...triangle.map(([, v]) => v))).toBeCloseTo(1, 6);
    // Convex, and wound counter-clockwise.
    for (let i = 0; i < triangle.length; i++) {
      const [ax, ay] = triangle[i]!;
      const [bx, by] = triangle[(i + 1) % triangle.length]!;
      const [cx, cy] = triangle[(i + 2) % triangle.length]!;
      expect((bx - ax) * (cy - by) - (by - ay) * (cx - bx)).toBeGreaterThanOrEqual(-1e-9);
    }
    // A clear gap between the strokes at every height.
    const barRight = (v: number) => {
      const [top] = barTop.sort((a, b) => b - a);
      const [foot] = barFoot.sort((a, b) => b - a);
      return foot! + (top! - foot!) * v;
    };
    for (const [u, v] of triangle) expect(u - barRight(v)).toBeGreaterThan(0.03);
  });

  it('paints the bar\'s stops and the triangle\'s grid exactly where they were sampled', () => {
    for (const variant of ['light', 'dark'] as const) {
      const { bar, triangle } = VESU_MARK[variant];
      // Mid-bar, at its stops.
      for (const [v, colour] of bar) expect(hex(vesuMarkColour(variant, -0.5 + 0.33 * (1 - v) + 0.1, v))).toBe(colour);
      // The triangle at a grid point: row t down from the top, column s across.
      const left = (v: number) => -0.225 + 0.33 * (1 - v);
      const right = (v: number) => 0.5 - 0.33 * (1 - v);
      for (const [r, c] of [[0, 0], [0, 4], [3, 2], [6, 1]] as const) {
        const v = 1 - MARK_ROWS[r]!;
        const u = left(v) + MARK_COLUMNS[c]! * (right(v) - left(v));
        expect(hex(vesuMarkColour(variant, u, v)), `${variant} ${r},${c}`).toBe(triangle[r]![c]);
      }
    }
  });

  it.each([
    ['z+', new Vector3(1, 0, 0)],
    ['z-', new Vector3(-1, 0, 0)],
    ['x+', new Vector3(0, 0, -1)],
    ['x-', new Vector3(0, 0, 1)],
  ] as const)('stands out of a %s face, reading the right way round from in front of it', (normal, right) => {
    const face: Face = { normal, plane: 2 };
    const bin = new GeometryBin();
    addVesuMark(bin, 'mark', face, 5, 1, 2, 0.1, 0.2, 'light');
    const geometry = bin.take('mark')!;
    const position = geometry.getAttribute('position');
    const colour = geometry.getAttribute('color');
    const out = { 'z+': new Vector3(0, 0, 1), 'z-': new Vector3(0, 0, -1), 'x+': new Vector3(1, 0, 0), 'x-': new Vector3(-1, 0, 0) }[normal];
    const point = new Vector3();
    const [bar, warm]: [number[], number[]] = [[], []];
    const paint = new Color();
    const hsl = { h: 0, s: 0, l: 0 };
    for (let i = 0; i < position.count; i++) {
      point.fromBufferAttribute(position, i);
      // Between 0.1 and 0.3 out of the plane, `size` high from its foot at 1.
      const w = point.dot(out) - 2 * (normal.endsWith('+') ? 1 : -1);
      expect(w).toBeGreaterThan(0.1 - 1e-6);
      expect(w).toBeLessThan(0.3 + 1e-6);
      expect(point.y).toBeGreaterThanOrEqual(1 - 1e-6);
      expect(point.y).toBeLessThanOrEqual(3 + 1e-6);
      const across = point.dot(right) - 5 * (right.x + right.z);
      expect(Math.abs(across)).toBeLessThanOrEqual(1 + 1e-6);
      paint.setRGB(colour.getX(i), colour.getY(i), colour.getZ(i)).getHSL(hsl, SRGBColorSpace);
      if (hsl.l < 0.06) bar.push(across);
      if (hsl.s > 0.5 && hsl.h * 360 >= 10 && hsl.h * 360 <= 40) warm.push(across);
    }
    const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
    expect(bar.length).toBeGreaterThan(0);
    expect(warm.length).toBeGreaterThan(0);
    // The ink bar on the viewer's left, the triangle's warm side to its right.
    expect(mean(bar)).toBeLessThan(mean(warm));
    // Its front faces look out of the face.
    const [a, b, c, n] = [new Vector3(), new Vector3(), new Vector3(), new Vector3()];
    let front = 0;
    for (let i = 0; i < position.count; i += 3) {
      a.fromBufferAttribute(position, i);
      b.fromBufferAttribute(position, i + 1);
      c.fromBufferAttribute(position, i + 2);
      n.subVectors(b, a).cross(c.clone().sub(a)).normalize();
      if (Math.abs(n.dot(out)) > 0.99) {
        expect(n.dot(out)).toBeGreaterThan(0);
        front += 1;
      }
    }
    expect(front).toBeGreaterThan(100);
    geometry.dispose();
    bin.dispose();
  });
});
