import { afterAll, describe, expect, it } from 'vitest';
import { AVATAR_SPRITE_KEYS } from '../src/avatar-state.js';
import { avatarSeatedContact, disposeAvatarFigureCache } from '../src/three/avatar-figure.js';
import { PLAZA_BENCH_PROFILE, BLEACHER_PROFILE, LOUNGE_PROFILE } from '../src/seats.js';
import { CLIP_TOLERANCE } from './avatar-clipping.js';
import {
  SEAT_CLIP_TOLERANCE,
  SEAT_REST_TOLERANCE,
  benchSolids,
  findAvatarSeating,
  findSeatFindings,
  formatSeatFinding,
  seatTypes,
} from './avatar-seat.js';

const CHECK_TIMEOUT_MS = 120_000;

afterAll(() => {
  disposeAvatarFigureCache();
});

describe('seated avatars on benches (tools/avatar-seat.ts)', () => {
  it('checks all five kinds of seat in the World', () => {
    expect(seatTypes().map((seat) => seat.name)).toEqual([
      'plaza bench',
      'pitch bleacher',
      'bridge lounge',
      'arena tier',
      'arena throne',
    ]);
    // One pixel at the street camera, as the clipping audit uses.
    expect(SEAT_REST_TOLERANCE).toBe(CLIP_TOLERANCE);
    expect(SEAT_CLIP_TOLERANCE).toBe(CLIP_TOLERANCE);
  });

  it('takes each bench type from the geometry it is drawn to', () => {
    const [plaza, pitch, bridge] = seatTypes();
    // The plaza's slats are 0.4 to 0.45 high, 0.2 to 0.65 in from the back, and
    // the sitter sits 0.425 in: the seat ends 0.225 ahead of them.
    expect(plaza!.place.surface).toBe(PLAZA_BENCH_PROFILE.surface);
    expect(plaza!.place.front).toBeCloseTo(0.225, 6);
    expect(plaza!.solids).toHaveLength(2);
    expect(plaza!.solids[0]!.maxZ).toBeCloseTo(0.225, 6);
    // A bleacher's plank is 0.08 on a 0.3 step, and the step is a third solid.
    expect(pitch!.place.surface).toBe(BLEACHER_PROFILE.surface);
    expect(pitch!.solids).toHaveLength(2);
    expect(pitch!.solids[1]).toMatchObject({ minY: 0, maxY: BLEACHER_PROFILE.standing });
    // The Bridge lounge's cushion is 0.46 high with its back behind the sitter.
    expect(bridge!.place.surface).toBe(LOUNGE_PROFILE.surface);
    expect(bridge!.solids[1]!.maxZ).toBeLessThan(0);
  });

  it('derives a bench with no back and no step as one solid', () => {
    const solids = benchSolids(
      { ...PLAZA_BENCH_PROFILE, restFront: null, restBottom: null, restTop: null },
      0.425,
    );
    expect(solids).toHaveLength(1);
  });

  it.each(AVATAR_SPRITE_KEYS)(
    '%s: sits on every bench, nothing through the slats, the back or the step',
    (key) => {
      expect(findAvatarSeating(key).map(formatSeatFinding)).toEqual([]);
    },
    CHECK_TIMEOUT_MS,
  );

  it('a seated figure rests just below the plane its feet stand on, so it clears every seat', () => {
    // Level thighs hang a little under that plane, so the rise onto a bench is
    // slightly more than the seat's own height. A positive contact would mean a
    // figure that cannot sit on anything lower than itself.
    for (const key of AVATAR_SPRITE_KEYS) {
      expect(avatarSeatedContact(key)).toBeLessThan(0);
      expect(avatarSeatedContact(key)).toBeGreaterThan(-0.2);
    }
  });

  it('catches a sitter left on the ground: the bug D-127 shipped with', () => {
    const plaza = seatTypes()[0]!;
    // Told nothing about the seat, the figure takes the pose on the floor: its
    // backside ends up a seat's height below the slats it is supposed to be on.
    const sunk = findSeatFindings('avatar-1', plaza, null);
    const rest = sunk.find((finding) => finding.check === 'rest');
    expect(rest?.depth).toBeLessThan(-0.4);
    expect(formatSeatFinding(rest!)).toContain('below the seat top');
  });

  it('catches legs that would hang through the slats instead of past the edge', () => {
    const plaza = seatTypes()[0]!;
    // The same bench with its seat surface run out to a tile deep: the thighs
    // now lie over it rather than past its edge, which is only safe because
    // they are level — pull the surface up over them and it is a finding.
    const deep = findSeatFindings('avatar-4', {
      ...plaza,
      solids: [{ minY: plaza.place.surface, maxY: plaza.place.surface + 0.2, minZ: -0.2, maxZ: 0.6 }],
    });
    expect(deep.map((finding) => finding.check)).toContain('through');
  });
});
