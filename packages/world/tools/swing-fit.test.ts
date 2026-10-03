import { describe, expect, it } from 'vitest';
import { AVATAR_SPRITE_KEYS } from '../src/avatar-state.js';
import { disposeAvatarFigureCache } from '../src/three/avatar-figure.js';
import { seatedFit, resetSeatedFits } from '../src/three/avatar-seating.js';
import { SWING_HANG, SWING_RIDER_DROP, SWING_SEAT } from '../src/three/roof-swing.js';
import { findAllSwingFit, findSwingFit, formatFit, swingPoses } from './swing-fit.js';

/**
 * D-133 (2026-10-03): every character fits the swing.
 *
 * The lead's complaint was that they did not: one rider height suited the
 * middle of the sixteen looks and left the small ones sunk and the large ones
 * hovering. The fix is to measure each look (`avatar-seating.ts`) and place
 * the rider from what is measured, and this is the check that it worked —
 * across all sixteen, cosy and battle-dressed, looking straight ahead and at
 * each end of the look-around.
 */

const CHECK_TIMEOUT_MS = 120_000;

describe('every look sits on the swing (D-133)', () => {
  it('finds nothing wrong with any of the sixteen, in any head pose', () => {
    const findings = findAllSwingFit();
    expect(findings.map(formatFit)).toEqual([]);
  }, CHECK_TIMEOUT_MS);

  it('checks all sixteen looks in three poses, so neither outfit is skipped', () => {
    expect(AVATAR_SPRITE_KEYS).toHaveLength(16);
    expect(swingPoses().map((pose) => pose.name)).toEqual(['ahead', 'looking left', 'looking right']);
    // Both halves of each pair: the cosy look and its battle outfit.
    expect(AVATAR_SPRITE_KEYS).toContain('avatar-1');
    expect(AVATAR_SPRITE_KEYS).toContain('avatar-9');
  });

  it('would catch a rider placed at one height for everybody: the old bug', () => {
    // The seat used to drop every look the same distance. Measured against
    // the smallest and largest, that is exactly what this check now refuses.
    const drops = AVATAR_SPRITE_KEYS.map((key) => seatedFit(key).hipDrop);
    const spread = Math.max(...drops) - Math.min(...drops);
    expect(spread).toBeGreaterThan(0.15);
    // The shipped fallback sits inside the range it stands in for.
    expect(SWING_RIDER_DROP - SWING_HANG).toBeGreaterThan(Math.min(...drops));
    expect(SWING_RIDER_DROP - SWING_HANG).toBeLessThan(Math.max(...drops));
  });

  it('reports a rider who hovers, and one who is sunk into the board', () => {
    // The check's own teeth: place the figure off its measured height and it
    // complains, in both directions.
    const key = AVATAR_SPRITE_KEYS[0]!;
    expect(findSwingFit(key)).toEqual([]);
    const hovering = findSwingFit(key, { offsetY: 0.15 });
    expect(hovering.some((finding) => finding.check === 'seated')).toBe(true);
    const sunk = findSwingFit(key, { offsetY: -0.15 });
    expect(sunk.some((finding) => finding.check === 'seated')).toBe(true);
    // Sunk that far, the body is through the plank as well as off it.
    expect(sunk.some((finding) => finding.check === 'intersect')).toBe(true);
  }, CHECK_TIMEOUT_MS);
});

describe('what the measurement says about each look (D-133)', () => {
  it('measures a seated hip height for every look, in a sane range', () => {
    for (const key of AVATAR_SPRITE_KEYS) {
      const fit = seatedFit(key);
      expect(fit.hipDrop, key).toBeGreaterThan(0.05);
      expect(fit.hipDrop, key).toBeLessThan(0.4);
      // The legs hang below the hips, and the knees reach out in front.
      expect(fit.footDrop, key).toBeGreaterThan(fit.hipDrop * 0.5);
      expect(fit.kneeReach, key).toBeGreaterThan(0.1);
      // And the head is above the body, not inside it.
      expect(fit.headTop, key).toBeGreaterThan(0.6);
    }
  });

  it('bigger builds sit higher: the measurement follows the body, not the key', () => {
    // avatar-6 is a small build, avatar-15 a large one (avatar-looks.ts).
    expect(seatedFit('avatar-6').hipDrop).toBeLessThan(seatedFit('avatar-1').hipDrop);
    expect(seatedFit('avatar-15').hipDrop).toBeGreaterThan(seatedFit('avatar-1').hipDrop);
  });

  it('measures each look once and keeps it', () => {
    resetSeatedFits();
    const first = seatedFit('avatar-2');
    expect(seatedFit('avatar-2')).toBe(first);
    resetSeatedFits();
    expect(seatedFit('avatar-2')).not.toBe(first);
    expect(seatedFit('avatar-2').hipDrop).toBeCloseTo(first.hipDrop, 9);
    disposeAvatarFigureCache();
  });

  it('the seat the check reads is the seat the builder builds', () => {
    // One table, two readers (three/roof-swing.ts): the plank is a plank, the
    // backrest is behind the rider and the rail is in front of them.
    expect(SWING_SEAT.boardFront).toBeGreaterThan(SWING_SEAT.boardBack);
    expect(SWING_SEAT.backrestBack).toBeLessThanOrEqual(SWING_SEAT.boardBack);
    expect(SWING_SEAT.backrestFront).toBeLessThan(0);
    expect(SWING_SEAT.railBack).toBeGreaterThan(SWING_SEAT.boardFront);
    expect(SWING_SEAT.barHigh).toBeLessThan(-SWING_SEAT.boardThickness);
    expect(SWING_SEAT.hangerX).toBeGreaterThan(SWING_SEAT.halfWidth);
  });
});
