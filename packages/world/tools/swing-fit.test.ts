import { describe, expect, it } from 'vitest';
import { AVATAR_SPRITE_KEYS } from '../src/avatar-state.js';
import { avatarSeatedContact } from '../src/three/avatar-figure.js';
import { ROOF_SWING_SEAT, SWING_HANG, SWING_RIDER_DROP, SWING_SEAT } from '../src/three/roof-swing.js';
import { findAllSwingFit, findSwingFit, formatFit, swingPoses } from './swing-fit.js';

/**
 * D-133 (2026-10-03): every character fits the swing.
 *
 * The lead's complaint was that they did not: one rider height suited the
 * middle of the sixteen looks and left the small ones sunk and the large ones
 * hovering. The fix is D-127's seat system: the swing hands the figure its own
 * `SeatPlace` and the figure raises itself onto it by its own measured seated
 * contact. This is the check that it worked — across all sixteen, cosy and
 * battle-dressed, looking straight ahead and at each end of the look-around,
 * against the level-thigh seated pose that ships.
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
    // The seat used to drop every look the same distance. The spread of what
    // the sixteen actually need is what made that wrong, and it is still
    // there — the figure now absorbs it, so the swing does not have to.
    const contacts = AVATAR_SPRITE_KEYS.map((key) => avatarSeatedContact(key));
    expect(Math.max(...contacts) - Math.min(...contacts)).toBeGreaterThan(0.03);
    // Every look's contact is below its own ground plane, which is why the
    // swing's seat surface can be that plane and still seat all sixteen.
    for (const contact of contacts) expect(contact).toBeLessThan(ROOF_SWING_SEAT.surface);
    // The rider's drop is the board's top face, with nothing per-look in it.
    expect(SWING_RIDER_DROP).toBe(SWING_HANG + ROOF_SWING_SEAT.surface);
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
    // Sunk far enough that something which is *not* allowed to rest on the
    // board — a hand, rather than the hips or the thighs — is inside it, the
    // intersection check has teeth too.
    const buried = findSwingFit(key, { offsetY: -0.5 });
    expect(buried.some((finding) => finding.check === 'intersect')).toBe(true);
  }, CHECK_TIMEOUT_MS);
});

describe('the swing is a seat like any other (D-127/D-133)', () => {
  it('describes the board as a SeatPlace the figure can rise onto', () => {
    // The surface is the rider's own ground plane: the figure's seated
    // underside hangs below that plane, so every look lands on the board
    // without the swing knowing anything about builds.
    expect(ROOF_SWING_SEAT.surface).toBe(0);
    expect(ROOF_SWING_SEAT.front).toBe(SWING_SEAT.boardFront);
    // A seat the sitter is placed on, not one they stand in front of.
    expect(ROOF_SWING_SEAT.back ?? 0).toBe(0);
  });

  it('the seat the check reads is the seat the builder builds', () => {
    // One table, two readers (three/roof-swing.ts): the plank is a plank, the
    // backrest is behind the rider and the rail is in front of them.
    expect(SWING_SEAT.boardFront).toBeGreaterThan(SWING_SEAT.boardBack);
    expect(SWING_SEAT.backrestBack).toBeLessThanOrEqual(SWING_SEAT.boardBack);
    expect(SWING_SEAT.backrestFront).toBeLessThan(0);
    expect(SWING_SEAT.railBack).toBeGreaterThan(SWING_SEAT.boardFront);
    // The board carries the whole of a level-thigh sit, and the rail stands
    // clear in front of it rather than under a hanging knee.
    expect(SWING_SEAT.boardFront - SWING_SEAT.boardBack).toBeGreaterThan(0.6);
    expect(SWING_SEAT.railLow).toBeGreaterThan(0);
    expect(SWING_SEAT.hangerX).toBeGreaterThan(SWING_SEAT.halfWidth);
  });
});
