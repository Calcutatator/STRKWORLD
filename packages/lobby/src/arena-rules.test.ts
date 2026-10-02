/**
 * D-114: the arena ring's rules, with no transport. Time is an argument and
 * positions come from a table the test owns, exactly as the room passes its
 * own held positions.
 */

import { describe, expect, it } from 'vitest';
import {
  ARENA_ABORT_RESULT_MS,
  ARENA_ATTACK_MIN_INTERVAL_MS,
  ARENA_COUNTDOWN_MS,
  ARENA_DUMMY_TILE,
  ARENA_FIGHT_MS,
  ARENA_GATE_APPROACH,
  ARENA_INTENT_MIN_INTERVAL_MS,
  ARENA_MAX_HP,
  ARENA_RESULT_MS,
  ARENA_RING_RETURN,
  ARENA_RING_RETURN_FACING,
  ARENA_RING_SPAWN,
  ARENA_RING_SPAWN_FACING,
  arenaTileCentre,
  normalizeArenaRing,
  type Facing,
  type GameId,
  type PresenceArea,
} from '@strkworld/shared';
import {
  ARENA_APPROACH_SLACK_PX,
  createArenaAuthority,
  isArenaHit,
  isOnArenaApproach,
  type ArenaAuthority,
  type ArenaStance,
} from './arena-rules';

const APPROACH = arenaTileCentre({ x: ARENA_GATE_APPROACH.x, y: ARENA_GATE_APPROACH.y + 1 });
const DUMMY = arenaTileCentre(ARENA_DUMMY_TILE);
const A = 'a' as GameId;
const B = 'b' as GameId;

/** Where each test player stands; the authority reads it through `locate`. */
function table(): { stances: Map<string, ArenaStance>; locate: (key: string) => ArenaStance | null } {
  const stances = new Map<string, ArenaStance>();
  return { stances, locate: (key) => stances.get(key) ?? null };
}

function claimant(key: string, gameId: GameId, at = APPROACH, area: PresenceArea | null = 'arena') {
  return { key, gameId, area, x: at.x, y: at.y };
}

/** A ring claimed by 'a' at `now`, fighting from `now + countdown`, 'a' one tile west of the dummy, facing it. */
function fighting(now = 1000): { ring: ArenaAuthority; stances: Map<string, ArenaStance>; locate: (key: string) => ArenaStance | null; start: number } {
  const ring = createArenaAuthority();
  const { stances, locate } = table();
  expect(ring.claim(claimant('a', A), now)).toBe('applied');
  ring.advance(now);
  stances.set('a', { x: DUMMY.x - 32, y: DUMMY.y, facing: 'right' });
  const start = now + ARENA_COUNTDOWN_MS;
  ring.advance(start);
  expect(ring.phase).toBe('fighting');
  return { ring, stances, locate, start };
}

describe('the ring through a whole fight (D-114)', () => {
  it('idle → claim → countdown → fighting at 3 s → knockout after 10 hits → ended → idle at +4 s with the return', () => {
    const ring = createArenaAuthority();
    const { stances, locate } = table();
    expect(ring.phase).toBe('idle');
    expect(ring.active).toBe(false);
    expect(ring.claim(claimant('a', A), 1000)).toBe('applied');
    // The claim moves the fighter into the ring, facing the dummy.
    expect(ring.advance(1000)).toEqual([{ kind: 'place', key: 'a', tile: ARENA_RING_SPAWN, facing: ARENA_RING_SPAWN_FACING }]);
    const counting = ring.snapshot(1000);
    expect(counting).toMatchObject({ phase: 'countdown', round: 1, secondsLeft: 3, outcome: null });
    expect(counting.challenger).toEqual({ kind: 'player', gameId: A, hp: ARENA_MAX_HP, swings: 0, hits: 0 });
    expect(counting.opponent).toEqual({ kind: 'dummy', gameId: null, hp: ARENA_MAX_HP, swings: 0, hits: 0 });
    expect(ring.holdsRing('a')).toBe(true);
    expect(ring.active).toBe(true);

    ring.advance(1000 + ARENA_COUNTDOWN_MS - 1);
    expect(ring.phase).toBe('countdown');
    ring.advance(1000 + ARENA_COUNTDOWN_MS);
    expect(ring.phase).toBe('fighting');
    expect(ring.snapshot(1000 + ARENA_COUNTDOWN_MS).secondsLeft).toBe(90);

    stances.set('a', { x: DUMMY.x - 32, y: DUMMY.y, facing: 'right' });
    let now = 1000 + ARENA_COUNTDOWN_MS;
    for (let hit = 1; hit <= 10; hit += 1) {
      now += ARENA_ATTACK_MIN_INTERVAL_MS;
      expect(ring.attack('a', now, locate)).toBe('hit');
      const after = ring.snapshot(now);
      expect(after.opponent.hp).toBe(ARENA_MAX_HP - 10 * hit);
      expect(after.opponent.hits).toBe(hit);
      expect(after.challenger.swings).toBe(hit);
    }
    const ended = ring.snapshot(now);
    expect(ended.phase).toBe('ended');
    expect(ended.outcome).toEqual({ reason: 'knockout', winner: 'challenger' });
    expect(ended.secondsLeft).toBe(0);
    // Still the challenger's until the close: they stand in the ring.
    expect(ring.holdsRing('a')).toBe(true);
    expect(ring.advance(now + ARENA_RESULT_MS - 1)).toEqual([]);
    expect(ring.phase).toBe('ended');
    expect(ring.advance(now + ARENA_RESULT_MS)).toEqual([
      { kind: 'place', key: 'a', tile: ARENA_RING_RETURN, facing: ARENA_RING_RETURN_FACING },
    ]);
    const idle = ring.snapshot(now + ARENA_RESULT_MS);
    expect(idle.phase).toBe('idle');
    expect(idle.challenger.kind).toBe('empty');
    expect(idle.opponent.kind).toBe('empty');
    expect(idle.round).toBe(1);
    expect(ring.holdsRing('a')).toBe(false);
    expect(ring.active).toBe(false);
    // Every snapshot along the way passes the shared validator.
    for (const snapshot of [counting, ended, idle]) expect(normalizeArenaRing(snapshot)).toEqual(snapshot);
  });

  it('times out at 90 s with no winner, and closes 4 s later', () => {
    const { ring, start } = fighting();
    ring.advance(start + ARENA_FIGHT_MS - 1);
    expect(ring.phase).toBe('fighting');
    expect(ring.snapshot(start + ARENA_FIGHT_MS - 1).secondsLeft).toBe(1);
    ring.advance(start + ARENA_FIGHT_MS);
    expect(ring.snapshot(start + ARENA_FIGHT_MS).outcome).toEqual({ reason: 'timeout', winner: null });
    expect(ring.advance(start + ARENA_FIGHT_MS + ARENA_RESULT_MS)).toEqual([
      { kind: 'place', key: 'a', tile: ARENA_RING_RETURN, facing: ARENA_RING_RETURN_FACING },
    ]);
    expect(ring.phase).toBe('idle');
  });

  it('a late clock runs every deadline it missed, from where each was due', () => {
    const ring = createArenaAuthority();
    ring.claim(claimant('a', A), 0);
    ring.advance(0);
    // Long past the countdown, the fight and the result in one call.
    expect(ring.advance(ARENA_COUNTDOWN_MS + ARENA_FIGHT_MS + ARENA_RESULT_MS + 5)).toEqual([
      { kind: 'place', key: 'a', tile: ARENA_RING_RETURN, facing: ARENA_RING_RETURN_FACING },
    ]);
    expect(ring.phase).toBe('idle');
  });

  it('a leave ends the fight as left with no winner, closes after 1.5 s, and returns the fighter', () => {
    const { ring, start } = fighting();
    const at = start + ARENA_INTENT_MIN_INTERVAL_MS;
    expect(ring.leave('a', at)).toBe('applied');
    expect(ring.snapshot(at).outcome).toEqual({ reason: 'left', winner: null });
    expect(ring.advance(at + ARENA_ABORT_RESULT_MS - 1)).toEqual([]);
    // A leave intent comes from a fighter still standing in the ring: they go back to the gate.
    expect(ring.advance(at + ARENA_ABORT_RESULT_MS)).toEqual([
      { kind: 'place', key: 'a', tile: ARENA_RING_RETURN, facing: ARENA_RING_RETURN_FACING },
    ]);
    expect(ring.phase).toBe('idle');
  });

  it.each([
    ['left', 'left'],
    ['disconnect', 'disconnect'],
  ] as const)('a fighter gone by %s ends the fight as %s; idle after 1.5 s, with no return', (reason, expected) => {
    const { ring, start } = fighting();
    expect(ring.gone('a', reason, start + 10)).toBe(true);
    expect(ring.snapshot(start + 10).outcome).toEqual({ reason: expected, winner: null });
    expect(ring.holdsRing('a')).toBe(false);
    expect(ring.advance(start + 10 + ARENA_ABORT_RESULT_MS)).toEqual([]);
    expect(ring.phase).toBe('idle');
  });

  it('a countdown also ends on a leave or a disconnect', () => {
    const ring = createArenaAuthority();
    ring.claim(claimant('a', A), 0);
    ring.advance(0);
    expect(ring.gone('a', 'disconnect', 500)).toBe(true);
    expect(ring.snapshot(500).outcome).toEqual({ reason: 'disconnect', winner: null });
    const second = createArenaAuthority();
    second.claim(claimant('b', B), 0);
    expect(second.leave('b', ARENA_INTENT_MIN_INTERVAL_MS)).toBe('applied');
    expect(second.snapshot(ARENA_INTENT_MIN_INTERVAL_MS).outcome).toEqual({ reason: 'left', winner: null });
  });

  it('a fighter who leaves the arena during the result is not returned', () => {
    const { ring, stances, locate, start } = fighting();
    stances.set('a', { x: DUMMY.x - 32, y: DUMMY.y, facing: 'right' });
    let now = start;
    for (let n = 0; n < 10; n += 1) ring.attack('a', (now += ARENA_ATTACK_MIN_INTERVAL_MS), locate);
    expect(ring.phase).toBe('ended');
    ring.gone('a', 'left', now + 100);
    // Still a knockout: the result stands.
    expect(ring.snapshot(now + 100).outcome).toEqual({ reason: 'knockout', winner: 'challenger' });
    expect(ring.advance(now + ARENA_RESULT_MS)).toEqual([]);
    expect(ring.phase).toBe('idle');
  });

  it('gone for someone who holds no slot changes nothing', () => {
    const { ring, start } = fighting();
    expect(ring.gone('stranger', 'disconnect', start + 1)).toBe(false);
    expect(ring.phase).toBe('fighting');
  });
});

describe('claims (D-114)', () => {
  it('two claims in one turn: exactly one challenger, and the second is busy', () => {
    const ring = createArenaAuthority();
    // Either end of the approach, which runs north to south outside the west gate.
    const left = arenaTileCentre({ x: ARENA_GATE_APPROACH.x, y: ARENA_GATE_APPROACH.y });
    const right = arenaTileCentre({
      x: ARENA_GATE_APPROACH.x + ARENA_GATE_APPROACH.width - 1,
      y: ARENA_GATE_APPROACH.y + ARENA_GATE_APPROACH.height - 1,
    });
    // The room handles one message at a time; both arrive at the same instant.
    expect(ring.claim(claimant('a', A, left), 1000)).toBe('applied');
    expect(ring.claim(claimant('b', B, right), 1000)).toBe('busy');
    const snapshot = ring.snapshot(1000);
    expect(snapshot.challenger.gameId).toBe(A);
    expect(snapshot.round).toBe(1);
    expect(ring.advance(1000).map((event) => event.key)).toEqual(['a']);
  });

  it('is busy in countdown, fighting and ended, including from the challenger', () => {
    const { ring, stances, locate, start } = fighting(0);
    // Countdown was checked by the race above; fighting:
    expect(ring.claim(claimant('b', B), start)).toBe('busy');
    expect(ring.claim(claimant('a', A), start + 1)).toBe('busy');
    stances.set('a', { x: DUMMY.x - 32, y: DUMMY.y, facing: 'right' });
    let now = start;
    for (let n = 0; n < 10; n += 1) ring.attack('a', (now += ARENA_ATTACK_MIN_INTERVAL_MS), locate);
    expect(ring.phase).toBe('ended');
    expect(ring.claim(claimant('c', 'c' as GameId), now)).toBe('busy');
    const counting = createArenaAuthority();
    counting.claim(claimant('a', A), 0);
    expect(counting.claim(claimant('b', B), 1)).toBe('busy');
  });

  it('is rejected off the approach (beyond its slack) or from outside the arena', () => {
    const ring = createArenaAuthority();
    const sand = arenaTileCentre({ x: 20, y: 8 });
    expect(ring.claim(claimant('a', A, sand), 0)).toBe('rejected');
    expect(ring.claim(claimant('b', B, APPROACH, 'street'), 0)).toBe('rejected');
    expect(ring.claim(claimant('c', 'c' as GameId, APPROACH, null), 0)).toBe('rejected');
    expect(ring.phase).toBe('idle');
    // The approach's pixel edges, slack included.
    const minX = 64 + ARENA_GATE_APPROACH.x * 32 - ARENA_APPROACH_SLACK_PX;
    const minY = 64 + ARENA_GATE_APPROACH.y * 32 - ARENA_APPROACH_SLACK_PX;
    expect(isOnArenaApproach(minX, minY)).toBe(true);
    expect(isOnArenaApproach(minX - 1, minY)).toBe(false);
    expect(isOnArenaApproach(minX, minY - 1)).toBe(false);
    expect(isOnArenaApproach(Number.NaN, minY)).toBe(false);
  });

  it('holds claims and leaves to one shared 900 ms floor per session', () => {
    const ring = createArenaAuthority();
    const sand = arenaTileCentre({ x: 20, y: 8 });
    expect(ring.claim(claimant('a', A, sand), 0)).toBe('rejected');
    // A refused claim still spent the floor.
    expect(ring.claim(claimant('a', A), ARENA_INTENT_MIN_INTERVAL_MS - 1)).toBe('throttled');
    expect(ring.claim(claimant('a', A), ARENA_INTENT_MIN_INTERVAL_MS)).toBe('applied');
    expect(ring.leave('a', ARENA_INTENT_MIN_INTERVAL_MS + 1)).toBe('throttled');
    expect(ring.phase).toBe('countdown');
    expect(ring.leave('a', 2 * ARENA_INTENT_MIN_INTERVAL_MS)).toBe('applied');
  });

  it('a leave from someone without a slot is absent, and after the end is rejected', () => {
    const { ring, start } = fighting();
    expect(ring.leave('stranger', start)).toBe('absent');
    expect(ring.leave('a', start + 1000)).toBe('applied');
    // Past the shared floor, still inside the 1.5 s result.
    expect(ring.leave('a', start + 1000 + ARENA_INTENT_MIN_INTERVAL_MS + 50)).toBe('rejected');
  });

  it('round wraps at 65536', () => {
    const ring = createArenaAuthority({ round: 0xffff });
    expect(ring.snapshot(0).round).toBe(0xffff);
    ring.claim(claimant('a', A), 0);
    expect(ring.snapshot(0).round).toBe(0);
    expect(normalizeArenaRing(ring.snapshot(0))).not.toBeNull();
    ring.advance(0);
    ring.gone('a', 'disconnect', 1);
    ring.advance(1 + ARENA_ABORT_RESULT_MS);
    ring.claim(claimant('b', B), 2 + ARENA_ABORT_RESULT_MS);
    expect(ring.snapshot(2 + ARENA_ABORT_RESULT_MS).round).toBe(1);
  });
});

describe('attacks (D-114)', () => {
  it('in the countdown change no HP and bump no swings, but consume the floor', () => {
    const ring = createArenaAuthority();
    const { stances, locate } = table();
    ring.claim(claimant('a', A), 0);
    stances.set('a', { x: DUMMY.x - 32, y: DUMMY.y, facing: 'right' });
    expect(ring.attack('a', 100, locate)).toBe('rejected');
    expect(ring.snapshot(100).opponent).toMatchObject({ hp: ARENA_MAX_HP, hits: 0 });
    expect(ring.snapshot(100).challenger.swings).toBe(0);
    expect(ring.attack('a', 100 + ARENA_ATTACK_MIN_INTERVAL_MS - 1, locate)).toBe('throttled');
  });

  it('from someone holding no slot are absent and change nothing', () => {
    const { ring, locate, start } = fighting();
    expect(ring.attack('stranger', start + 1, locate)).toBe('absent');
    expect(ring.snapshot(start + 1).opponent.hp).toBe(ARENA_MAX_HP);
  });

  it.each([
    ['orthogonal, 32 px', { x: DUMMY.x, y: DUMMY.y - 32, facing: 'down' as Facing }, true],
    ['diagonal, 45 px', { x: DUMMY.x + 32, y: DUMMY.y - 32, facing: 'down' as Facing }, true],
    ['52 px, the reach', { x: DUMMY.x, y: DUMMY.y - 52, facing: 'down' as Facing }, true],
    ['53 px', { x: DUMMY.x, y: DUMMY.y - 53, facing: 'down' as Facing }, false],
    ['facing away', { x: DUMMY.x, y: DUMMY.y - 32, facing: 'up' as Facing }, false],
    ['side-on, beside it', { x: DUMMY.x + 32, y: DUMMY.y, facing: 'down' as Facing }, false],
    ['diagonal, facing across it (cos 0.71)', { x: DUMMY.x + 32, y: DUMMY.y - 32, facing: 'left' as Facing }, true],
    ['diagonal, facing past it (cos −0.71)', { x: DUMMY.x + 32, y: DUMMY.y - 32, facing: 'right' as Facing }, false],
    ['at 75° (cos 0.26), inside the arc', { x: DUMMY.x + 40 * Math.sin((75 * Math.PI) / 180), y: DUMMY.y - 40 * Math.cos((75 * Math.PI) / 180), facing: 'down' as Facing }, true],
    ['at 76° (cos 0.24), outside it', { x: DUMMY.x + 40 * Math.sin((76 * Math.PI) / 180), y: DUMMY.y - 40 * Math.cos((76 * Math.PI) / 180), facing: 'down' as Facing }, false],
    ['point-blank, facing away', { x: DUMMY.x, y: DUMMY.y - 20, facing: 'up' as Facing }, true],
  ])('%s: hit %s', (_label, stance, expected) => {
    expect(isArenaHit(stance, DUMMY)).toBe(expected);
    const { ring, stances, locate, start } = fighting();
    stances.set('a', stance);
    expect(ring.attack('a', start + 1, locate)).toBe(expected ? 'hit' : 'miss');
    const after = ring.snapshot(start + 1);
    expect(after.opponent.hp).toBe(expected ? ARENA_MAX_HP - 10 : ARENA_MAX_HP);
    // Hit or miss, the swing is counted for spectators to animate.
    expect(after.challenger.swings).toBe(1);
  });

  it('holds to a 400 ms floor, and a throttled attack changes nothing (a spam of them lands one hit per floor)', () => {
    const { ring, locate, start } = fighting();
    let hits = 0;
    // A swing every 10 ms for a second.
    for (let t = 0; t < 1000; t += 10) {
      const outcome = ring.attack('a', start + t, locate);
      if (outcome === 'hit') hits += 1;
      else expect(outcome).toBe('throttled');
    }
    // At 0, 400 and 800 ms.
    expect(hits).toBe(3);
    const after = ring.snapshot(start + 1000);
    expect(after.opponent.hp).toBe(ARENA_MAX_HP - 30);
    expect(after.challenger.swings).toBe(3);
  });

  it('never reads a payload: the attack takes a key and the caller’s held stance, nothing else', () => {
    const { ring, stances, locate, start } = fighting();
    // A hostile stance object with an extra field, a getter and a prototype:
    // only `locate`'s x, y and facing matter, and they are the room's own.
    const proto = { damage: 1000, hp: 0 };
    const stance = Object.create(proto, {
      x: { value: DUMMY.x - 32, enumerable: true },
      y: { value: DUMMY.y, enumerable: true },
      facing: { value: 'right', enumerable: true },
      damage: { get: () => 9999, enumerable: true },
    }) as ArenaStance;
    stances.set('a', stance);
    expect(ring.attack('a', start, locate)).toBe('hit');
    expect(ring.snapshot(start).opponent.hp).toBe(ARENA_MAX_HP - 10);
  });

  it('misses when the attacker cannot be located', () => {
    const { ring, stances, locate, start } = fighting();
    stances.delete('a');
    expect(ring.attack('a', start, locate)).toBe('miss');
    expect(ring.snapshot(start).opponent.hp).toBe(ARENA_MAX_HP);
  });
});
