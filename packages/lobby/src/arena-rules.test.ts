/**
 * D-114: the arena ring's rules, with no transport. Time is an argument and
 * positions come from a table the test owns, exactly as the room passes its
 * own held positions.
 */

import { describe, expect, it } from 'vitest';
import {
  ARENA_ABORT_RESULT_MS,
  ARENA_ATTACK_MIN_INTERVAL_MS,
  ARENA_BLOCK_MIN_INTERVAL_MS,
  ARENA_BOX,
  ARENA_BOX_SEAT_FACING,
  ARENA_BOX_STAND,
  ARENA_BOX_STAND_FACING,
  ARENA_COUNTDOWN_MS,
  ARENA_DUMMY_TILE,
  ARENA_FIGHT_MS,
  ARENA_GATE_APPROACH,
  ARENA_GUARD_RECOVERY_MS,
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
  isAtArenaBox,
  isOnArenaApproach,
  isOnArenaThrone,
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
    expect(counting.challenger).toEqual({ kind: 'player', gameId: A, hp: ARENA_MAX_HP, swings: 0, hits: 0, guarding: false, blocks: 0 });
    expect(counting.opponent).toEqual({ kind: 'dummy', gameId: null, hp: ARENA_MAX_HP, swings: 0, hits: 0, guarding: false, blocks: 0 });
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

/**
 * D-128: the block (Q) and the emperor's box. Still no transport: the block
 * is two calls and a boolean on the slot, and the champion is a key the
 * authority holds and a presence id it publishes.
 */

const BOX = arenaTileCentre(ARENA_BOX_STAND);

function boxClaimant(key: string, gameId: GameId, at = BOX, area: PresenceArea | null = 'arena') {
  return { key, gameId, area, x: at.x, y: at.y };
}

/** A ring where 'b' holds the opponent slot: a target that guards and swings back. */
function sparring(now = 1000) {
  const ring = createArenaAuthority({ opponent: { key: 'b', gameId: B } });
  const { stances, locate } = table();
  expect(ring.claim(claimant('a', A), now)).toBe('applied');
  ring.advance(now);
  // Both in reach of each other, each facing the other.
  stances.set('a', { x: DUMMY.x - 32, y: DUMMY.y, facing: 'right' });
  stances.set('b', { x: DUMMY.x, y: DUMMY.y, facing: 'left' });
  const start = now + ARENA_COUNTDOWN_MS;
  ring.advance(start);
  expect(ring.phase).toBe('fighting');
  return { ring, stances, locate, start };
}

describe('the block (D-128)', () => {
  it('raises and lowers the guard, and only while the ring is fighting', () => {
    const ring = createArenaAuthority();
    const { locate } = table();
    // Nobody holds a slot yet.
    expect(ring.block('a', true, 1000)).toBe('absent');
    expect(ring.claim(claimant('a', A), 1000)).toBe('applied');
    ring.advance(1000);
    // A countdown is not a fight: no guard goes up during it. (The refused
    // start above spent the floor, so this one waits it out first.)
    const counting = 1000 + ARENA_BLOCK_MIN_INTERVAL_MS;
    expect(ring.block('a', true, counting)).toBe('rejected');
    expect(ring.snapshot(counting).challenger.guarding).toBe(false);
    const start = 1000 + ARENA_COUNTDOWN_MS;
    ring.advance(start);
    expect(ring.block('a', true, start)).toBe('applied');
    expect(ring.snapshot(start).challenger.guarding).toBe(true);
    // Twice over changes nothing.
    expect(ring.block('a', true, start + ARENA_BLOCK_MIN_INTERVAL_MS)).toBe('rejected');
    expect(ring.block('a', false, start + 100)).toBe('applied');
    expect(ring.snapshot(start + 100).challenger.guarding).toBe(false);
    // Lowering a guard that is already down changes nothing either.
    expect(ring.block('a', false, start + 110)).toBe('rejected');
    expect(locate('a')).toBeNull();
  });

  it('holds a start to its floor, and never throttles a release', () => {
    const { ring, start } = fighting();
    expect(ring.block('a', true, start)).toBe('applied');
    expect(ring.block('a', false, start + 10)).toBe('applied');
    // Inside the floor, the next start is dropped — but a release always goes.
    expect(ring.block('a', true, start + 20)).toBe('throttled');
    expect(ring.snapshot(start + 20).challenger.guarding).toBe(false);
    expect(ring.block('a', true, start + ARENA_BLOCK_MIN_INTERVAL_MS)).toBe('applied');
    expect(ring.block('a', false, start + ARENA_BLOCK_MIN_INTERVAL_MS + 1)).toBe('applied');
    expect(ring.snapshot(start + ARENA_BLOCK_MIN_INTERVAL_MS + 1).challenger.guarding).toBe(false);
  });

  it('refuses a swing while the guard is up, and through the recovery after it drops', () => {
    const { ring, locate, start } = fighting();
    expect(ring.block('a', true, start)).toBe('applied');
    expect(ring.attack('a', start + ARENA_ATTACK_MIN_INTERVAL_MS, locate)).toBe('guarding');
    // Refused outright: no swing counted and no damage.
    expect(ring.snapshot(start).challenger.swings).toBe(0);
    expect(ring.snapshot(start).opponent.hp).toBe(ARENA_MAX_HP);
    // The guard comes down a little before the next swing is due, so the
    // recovery is what refuses it rather than the attack floor.
    const nextSwing = start + 2 * ARENA_ATTACK_MIN_INTERVAL_MS;
    const dropped = nextSwing - ARENA_GUARD_RECOVERY_MS / 2;
    expect(ring.block('a', false, dropped)).toBe('applied');
    expect(ring.attack('a', nextSwing, locate)).toBe('guarding');
    expect(ring.snapshot(nextSwing).challenger.swings).toBe(0);
    // Out of the recovery, and past the attack floor: the swing lands.
    const ready = nextSwing + ARENA_ATTACK_MIN_INTERVAL_MS;
    expect(ready - dropped).toBeGreaterThan(ARENA_GUARD_RECOVERY_MS);
    expect(ring.attack('a', ready, locate)).toBe('hit');
    expect(ring.snapshot(ready).opponent.hp).toBe(ARENA_MAX_HP - 10);
  });

  it('a simulated attacker hitting a guarding fighter deals 0 and sparks a block instead', () => {
    const { ring, locate, start } = sparring();
    expect(ring.snapshot(start).opponent).toMatchObject({ kind: 'player', gameId: B, hp: ARENA_MAX_HP });
    // The challenger guards; the opponent swings into it.
    expect(ring.block('a', true, start)).toBe('applied');
    expect(ring.attack('b', start, locate)).toBe('blocked');
    const blocked = ring.snapshot(start);
    expect(blocked.challenger.hp).toBe(ARENA_MAX_HP);
    expect(blocked.challenger.blocks).toBe(1);
    // A blocked hit is not a hit: the hit counter, which drives the damage
    // number, does not move. The attacker's swing still counts.
    expect(blocked.challenger.hits).toBe(0);
    expect(blocked.opponent.swings).toBe(1);
    // Guard down: the same swing now takes HP and bumps hits, not blocks.
    expect(ring.block('a', false, start + 10)).toBe('applied');
    const next = start + ARENA_ATTACK_MIN_INTERVAL_MS;
    expect(ring.attack('b', next, locate)).toBe('hit');
    const landed = ring.snapshot(next);
    expect(landed.challenger.hp).toBe(ARENA_MAX_HP - 10);
    expect(landed.challenger.hits).toBe(1);
    expect(landed.challenger.blocks).toBe(1);
  });

  it('a guard never survives the fight it was raised in', () => {
    const { ring, start } = fighting();
    expect(ring.block('a', true, start)).toBe('applied');
    expect(ring.leave('a', start + ARENA_INTENT_MIN_INTERVAL_MS)).toBe('applied');
    expect(ring.snapshot(start).challenger.guarding).toBe(false);
  });

  it('a slot that holds nobody never publishes a guard', () => {
    const ring = createArenaAuthority();
    const idle = ring.snapshot(0);
    expect(idle.challenger.guarding).toBe(false);
    expect(idle.opponent.guarding).toBe(false);
    // The wire validator agrees: only a player slot may guard.
    expect(normalizeArenaRing(idle)).not.toBeNull();
  });
});

describe('the emperor’s box and the champion (D-128)', () => {
  /** Knock the dummy out: ten hits, each a full attack floor apart. */
  function winFight(ring: ArenaAuthority, locate: (key: string) => ArenaStance | null, start: number, key = 'a'): number {
    let at = start;
    for (let i = 0; i < ARENA_MAX_HP / 10; i += 1) {
      expect(ring.attack(key, at, locate)).toBe('hit');
      at += ARENA_ATTACK_MIN_INTERVAL_MS;
    }
    return at;
  }

  it('crowns the winner of a knockout, and only a knockout', () => {
    const { ring, locate, start } = fighting();
    expect(ring.snapshot(start).champion).toBeNull();
    const end = winFight(ring, locate, start);
    const won = ring.snapshot(end);
    expect(won.outcome).toEqual({ reason: 'knockout', winner: 'challenger' });
    expect(won.champion).toBe(A);
    expect(won.seated).toBe(false);
    // A timeout crowns nobody, and leaves the standing champion alone.
    const second = createArenaAuthority();
    const table2 = table();
    expect(second.claim(claimant('c', 'c' as GameId), 1000)).toBe('applied');
    second.advance(1000 + ARENA_COUNTDOWN_MS + ARENA_FIGHT_MS);
    expect(second.snapshot(1000).champion).toBeNull();
    expect(table2.locate('c')).toBeNull();
  });

  it('seats only the champion, from the box’s approach, and nobody else', () => {
    const { ring, locate, start } = fighting();
    const end = winFight(ring, locate, start);
    // Out of the result phase, so the winner is back at the gate and idle.
    const idle = end + ARENA_RESULT_MS;
    ring.advance(idle);
    expect(ring.phase).toBe('idle');
    // Someone who never won cannot use the box.
    expect(ring.seat(boxClaimant('z', 'z' as GameId), idle)).toBe('rejected');
    expect(ring.snapshot(idle).seated).toBe(false);
    // The champion, but away from the box: refused.
    expect(ring.seat(boxClaimant('a', A, APPROACH), idle + ARENA_INTENT_MIN_INTERVAL_MS)).toBe('rejected');
    // The champion, but not live in the arena: refused.
    expect(ring.seat(boxClaimant('a', A, BOX, null), idle + 2 * ARENA_INTENT_MIN_INTERVAL_MS)).toBe('rejected');
    // The champion at the box: seated, and moved onto the throne.
    const at = idle + 3 * ARENA_INTENT_MIN_INTERVAL_MS;
    expect(ring.seat(boxClaimant('a', A), at)).toBe('applied');
    expect(ring.advance(at)).toEqual([{ kind: 'place', key: 'a', tile: ARENA_BOX, facing: ARENA_BOX_SEAT_FACING }]);
    expect(ring.snapshot(at)).toMatchObject({ champion: A, seated: true });
    expect(ring.holdsSeat('a')).toBe(true);
    expect(ring.holdsSeat('z')).toBe(false);
    // E again stands them up, beside the box.
    const up = at + ARENA_INTENT_MIN_INTERVAL_MS;
    expect(ring.seat(boxClaimant('a', A), up)).toBe('applied');
    expect(ring.advance(up)).toEqual([{ kind: 'place', key: 'a', tile: ARENA_BOX_STAND, facing: ARENA_BOX_STAND_FACING }]);
    expect(ring.snapshot(up)).toMatchObject({ champion: A, seated: false });
  });

  it('holds the seat press to the intent floor it shares with claim', () => {
    const { ring, locate, start } = fighting();
    const end = winFight(ring, locate, start);
    const idle = end + ARENA_RESULT_MS;
    ring.advance(idle);
    expect(ring.seat(boxClaimant('a', A), idle)).toBe('applied');
    expect(ring.seat(boxClaimant('a', A), idle + 1)).toBe('throttled');
    // Throttled means nothing happened: they are still on the throne.
    expect(ring.snapshot(idle + 1).seated).toBe(true);
  });

  it('a new winner takes the box and puts the seated old champion down beside it', () => {
    const first = fighting();
    const end = winFight(first.ring, first.locate, first.start);
    const ring = first.ring;
    const idle = end + ARENA_RESULT_MS;
    ring.advance(idle);
    expect(ring.seat(boxClaimant('a', A), idle)).toBe('applied');
    ring.advance(idle);
    expect(ring.snapshot(idle)).toMatchObject({ champion: A, seated: true });
    // 'b' claims the ring and wins it.
    const second = idle + ARENA_INTENT_MIN_INTERVAL_MS;
    expect(ring.claim(claimant('b', B), second)).toBe('applied');
    first.stances.set('b', { x: DUMMY.x - 32, y: DUMMY.y, facing: 'right' });
    const fightFrom = second + ARENA_COUNTDOWN_MS;
    ring.advance(fightFrom);
    const crowned = winFight(ring, first.locate, fightFrom, 'b');
    const now = ring.snapshot(crowned);
    expect(now.champion).toBe(B);
    expect(now.seated).toBe(false);
    expect(ring.holdsSeat('a')).toBe(false);
    // The lead's rule: the deposed champion is lifted out of the seat and
    // stood on the sand beside the box.
    expect(ring.advance(crowned)).toEqual([
      { kind: 'place', key: 'a', tile: ARENA_BOX_STAND, facing: ARENA_BOX_STAND_FACING },
    ]);
  });

  it('a champion who wins again keeps the box and stays in the seat', () => {
    const { ring, stances, locate, start } = fighting();
    const end = winFight(ring, locate, start);
    const idle = end + ARENA_RESULT_MS;
    ring.advance(idle);
    expect(ring.seat(boxClaimant('a', A), idle)).toBe('applied');
    ring.advance(idle);
    const second = idle + ARENA_INTENT_MIN_INTERVAL_MS;
    expect(ring.claim(claimant('a', A), second)).toBe('applied');
    // Claiming the ring empties the throne behind them.
    expect(ring.snapshot(second)).toMatchObject({ champion: A, seated: false });
    stances.set('a', { x: DUMMY.x - 32, y: DUMMY.y, facing: 'right' });
    const fightFrom = second + ARENA_COUNTDOWN_MS;
    ring.advance(fightFrom);
    const crowned = winFight(ring, locate, fightFrom);
    expect(ring.snapshot(crowned).champion).toBe(A);
  });

  it('clears the champion and the seat when they leave the arena or drop', () => {
    for (const reason of ['left', 'disconnect'] as const) {
      const { ring, locate, start } = fighting();
      const end = winFight(ring, locate, start);
      const idle = end + ARENA_RESULT_MS;
      ring.advance(idle);
      expect(ring.seat(boxClaimant('a', A), idle)).toBe('applied');
      ring.advance(idle);
      expect(ring.snapshot(idle)).toMatchObject({ champion: A, seated: true });
      // The champion goes. The box is nobody's, and nobody is sitting in it.
      expect(ring.gone('a', reason, idle + 1)).toBe(true);
      expect(ring.snapshot(idle + 1)).toMatchObject({ champion: null, seated: false });
      expect(ring.holdsSeat('a')).toBe(false);
      // And they cannot sit again on the way out.
      expect(ring.seat(boxClaimant('a', A), idle + ARENA_INTENT_MIN_INTERVAL_MS + 1)).toBe('rejected');
    }
  });

  it('lowers the seat when the champion walks off the throne’s tile', () => {
    const { ring, locate, start } = fighting();
    const end = winFight(ring, locate, start);
    const idle = end + ARENA_RESULT_MS;
    ring.advance(idle);
    expect(ring.seat(boxClaimant('a', A), idle)).toBe('applied');
    ring.advance(idle);
    expect(ring.unseat('z')).toBe(false);
    expect(ring.unseat('a')).toBe(true);
    expect(ring.snapshot(idle)).toMatchObject({ champion: A, seated: false });
    // Nobody is placed: they walked there themselves.
    expect(ring.advance(idle)).toEqual([]);
    expect(ring.unseat('a')).toBe(false);
  });

  it('refuses the box to the fighter in the ring, champion or not', () => {
    const { ring, locate, start } = fighting();
    const end = winFight(ring, locate, start);
    const idle = end + ARENA_RESULT_MS;
    ring.advance(idle);
    const second = idle + ARENA_INTENT_MIN_INTERVAL_MS;
    expect(ring.claim(claimant('a', A), second)).toBe('applied');
    ring.advance(second);
    expect(ring.seat(boxClaimant('a', A), second + ARENA_INTENT_MIN_INTERVAL_MS)).toBe('rejected');
    expect(ring.snapshot(second).seated).toBe(false);
  });

  it('puts the champion’s presence id on the wire and nothing else about them', () => {
    const { ring, locate, start } = fighting();
    const end = winFight(ring, locate, start);
    const snapshot = ring.snapshot(end);
    // The validator accepts it, and the only thing naming the champion is
    // the ephemeral presence id peers in the arena already hold.
    expect(normalizeArenaRing(snapshot)).toEqual(snapshot);
    expect(JSON.stringify(snapshot)).not.toContain('"a"'.replace('a', 'key'));
    expect(Object.keys(snapshot).sort()).toEqual(
      ['challenger', 'champion', 'opponent', 'outcome', 'phase', 'round', 'seated', 'secondsLeft'],
    );
  });

  it('at the box: the approach, the throne’s own tile and the slack, but not the sand beyond', () => {
    expect(isAtArenaBox(BOX.x, BOX.y)).toBe(true);
    const seat = arenaTileCentre(ARENA_BOX);
    expect(isAtArenaBox(seat.x, seat.y)).toBe(true);
    expect(isOnArenaThrone(seat.x, seat.y)).toBe(true);
    expect(isOnArenaThrone(BOX.x, BOX.y)).toBe(false);
    // The lobby's slack, and a tile further out than that.
    expect(isAtArenaBox(BOX.x, BOX.y + 16 + ARENA_APPROACH_SLACK_PX)).toBe(true);
    expect(isAtArenaBox(BOX.x, BOX.y + 32 + ARENA_APPROACH_SLACK_PX)).toBe(false);
    expect(isAtArenaBox(Number.NaN, BOX.y)).toBe(false);
    expect(isAtArenaBox(BOX.x, Number.POSITIVE_INFINITY)).toBe(false);
  });
});
