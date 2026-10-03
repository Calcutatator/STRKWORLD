/**
 * D-131: the lookout swing's lock, with no transport. One person at a time on
 * a public roof — so the interesting cases are the second claimant, and every
 * way a ride can end before its twenty seconds are up.
 *
 * Time is an argument and positions come from the caller, exactly as the room
 * passes its own held positions.
 */

import { describe, expect, it } from 'vitest';
import {
  SWING_COOLDOWN_MS,
  SWING_INTENT_MIN_INTERVAL_MS,
  SWING_RIDE_MS,
  SWING_SEAT_FACING,
  SWING_SEAT_TILE,
  SWING_STEP_OFF_FACING,
  SWING_STEP_OFF_TILE,
  roofTileCentre,
  type GameId,
  type PresenceArea,
} from '@strkworld/shared';
import { createSwingAuthority, type SwingAuthority, type SwingClaimant } from './swing-rules';

const A = 'aaaa' as GameId;
const B = 'bbbb' as GameId;
/** The middle of the deck row in front of the frame. */
const APPROACH = roofTileCentre({ x: 3, y: 4 });
/** A deck tile well away from the swing. */
const AWAY = roofTileCentre({ x: 1, y: 1 });

function claimant(
  key: string,
  gameId: GameId,
  at = APPROACH,
  area: PresenceArea | null = 'roof',
): SwingClaimant {
  return { key, gameId, area, x: at.x, y: at.y };
}

/** A swing 'a' is riding from `now`, with the mount event already drained. */
function ridden(now = 10_000): { swing: SwingAuthority; start: number } {
  const swing = createSwingAuthority();
  expect(swing.claim(claimant('a', A), now)).toBe('applied');
  expect(swing.advance(now)).toHaveLength(1);
  return { swing, start: now };
}

/** Past both sessions' intent floors, so a throttle never masks a real answer. */
const later = (t: number) => t + SWING_INTENT_MIN_INTERVAL_MS;

describe('claiming the swing (D-131)', () => {
  it('seats the first claimant and tells the caller to stand them on the seat', () => {
    const swing = createSwingAuthority();
    expect(swing.claim(claimant('a', A), 1000)).toBe('applied');
    expect(swing.phase).toBe('riding');
    expect(swing.holdsSeat('a')).toBe(true);
    expect(swing.advance(1000)).toEqual([
      { kind: 'place', key: 'a', tile: SWING_SEAT_TILE, facing: SWING_SEAT_FACING },
    ]);
  });

  it('counts the round up per accepted claim, so a new value is a new ride', () => {
    const swing = createSwingAuthority();
    expect(swing.snapshot(0).round).toBe(0);
    swing.claim(claimant('a', A), 1000);
    expect(swing.snapshot(1000).round).toBe(1);
  });

  it('wraps the round at 16 bits, since the wire carries it as uint16', () => {
    const swing = createSwingAuthority({ round: 0xffff });
    swing.claim(claimant('a', A), 1000);
    expect(swing.snapshot(1000).round).toBe(0);
  });

  it('names the rider only by the ephemeral presence id, never the connection key', () => {
    const { swing, start } = ridden();
    const snapshot = swing.snapshot(start);
    expect(snapshot.riderId).toBe(A);
    expect(JSON.stringify(snapshot)).not.toContain('"a"');
  });

  it('counts the seconds left down through the ride, and holds 0 off it', () => {
    const { swing, start } = ridden();
    expect(swing.snapshot(start).secondsLeft).toBe(20);
    expect(swing.snapshot(start + 10_000).secondsLeft).toBe(10);
    expect(swing.snapshot(start + SWING_RIDE_MS).secondsLeft).toBe(0);
  });

  // -- first claim wins ------------------------------------------------------

  it('answers the second claimant busy, and changes nothing: the first claim wins', () => {
    const { swing, start } = ridden();
    expect(swing.claim(claimant('b', B), later(start))).toBe('busy');
    expect(swing.snapshot(start).riderId).toBe(A);
    expect(swing.holdsSeat('a')).toBe(true);
    expect(swing.holdsSeat('b')).toBe(false);
    // Nothing is queued: no second rider is seated when the ride ends.
    expect(swing.advance(later(start))).toEqual([]);
  });

  it('is still busy through the cooldown, so nobody claims into the step-off', () => {
    const { swing, start } = ridden();
    const over = start + SWING_RIDE_MS;
    expect(swing.claim(claimant('b', B), over)).toBe('busy');
    expect(swing.phase).toBe('cooldown');
    // Only once the cooldown has closed is it free again.
    expect(swing.claim(claimant('b', B), over + SWING_COOLDOWN_MS)).toBe('applied');
  });

  // -- who may claim ---------------------------------------------------------

  it('refuses a claim from anywhere but the roof', () => {
    const swing = createSwingAuthority();
    expect(swing.claim(claimant('a', A, APPROACH, 'street'), 1000)).toBe('rejected');
    expect(swing.claim(claimant('b', B, APPROACH, null), 1000)).toBe('rejected');
    expect(swing.phase).toBe('idle');
  });

  it('refuses a claim from a roof tile that is not the approach', () => {
    const swing = createSwingAuthority();
    expect(swing.claim(claimant('a', A, AWAY), 1000)).toBe('rejected');
    expect(swing.phase).toBe('idle');
  });

  it('throttles a flood to one intent per floor, and spends the floor on a refusal too', () => {
    const swing = createSwingAuthority();
    expect(swing.claim(claimant('a', A, AWAY), 1000)).toBe('rejected');
    // The floor is spent even though the claim was refused.
    expect(swing.claim(claimant('a', A), 1000)).toBe('throttled');
    expect(swing.claim(claimant('a', A), 1000 + SWING_INTENT_MIN_INTERVAL_MS)).toBe('applied');
  });

  it('holds each session to its own floor', () => {
    const swing = createSwingAuthority();
    expect(swing.claim(claimant('a', A, AWAY), 1000)).toBe('rejected');
    // 'b' has its own floor, so it is answered on the merits.
    expect(swing.claim(claimant('b', B), 1000)).toBe('applied');
  });
});

describe('ending a ride (D-131)', () => {
  it('ends on the deadline as a timeout, then cools down and goes idle', () => {
    const { swing, start } = ridden();
    const over = start + SWING_RIDE_MS;
    expect(swing.advance(over - 1)).toEqual([]);
    expect(swing.phase).toBe('riding');
    // The ride runs out: cooldown, nobody on the seat, the reason recorded.
    expect(swing.advance(over)).toEqual([]);
    expect(swing.phase).toBe('cooldown');
    expect(swing.snapshot(over)).toMatchObject({ phase: 'cooldown', riderId: null, reason: 'timeout' });
    expect(swing.holdsSeat('a')).toBe(false);
    // The cooldown closes by standing the rider back on the step-off tile.
    expect(swing.advance(over + SWING_COOLDOWN_MS)).toEqual([
      { kind: 'place', key: 'a', tile: SWING_STEP_OFF_TILE, facing: SWING_STEP_OFF_FACING },
    ]);
    expect(swing.phase).toBe('idle');
    expect(swing.snapshot(over + SWING_COOLDOWN_MS)).toMatchObject({ riderId: null, reason: null });
  });

  it('runs a long gap straight through to idle, landing where punctual calls would have', () => {
    const { swing, start } = ridden();
    // One late call, a whole ride and cooldown after the claim.
    const events = swing.advance(start + SWING_RIDE_MS + SWING_COOLDOWN_MS);
    expect(swing.phase).toBe('idle');
    expect(events).toEqual([
      { kind: 'place', key: 'a', tile: SWING_STEP_OFF_TILE, facing: SWING_STEP_OFF_FACING },
    ]);
  });

  it('ends early on the rider\'s leave (Esc, or the HUD), as left', () => {
    const { swing, start } = ridden();
    const at = later(start);
    expect(swing.leave('a', at)).toBe('applied');
    expect(swing.phase).toBe('cooldown');
    expect(swing.snapshot(at).reason).toBe('left');
    // They are still on the roof, so the cooldown still puts them down.
    expect(swing.advance(at + SWING_COOLDOWN_MS)).toEqual([
      { kind: 'place', key: 'a', tile: SWING_STEP_OFF_TILE, facing: SWING_STEP_OFF_FACING },
    ]);
  });

  it('ignores a leave from anyone but the rider', () => {
    const { swing, start } = ridden();
    expect(swing.leave('b', later(start))).toBe('absent');
    expect(swing.phase).toBe('riding');
    expect(swing.holdsSeat('a')).toBe(true);
  });

  it('ignores a leave when nobody is riding', () => {
    const swing = createSwingAuthority();
    expect(swing.leave('a', 1000)).toBe('absent');
    expect(swing.phase).toBe('idle');
  });

  it('shares the intent floor with claim, so leave cannot be flooded either', () => {
    const { swing, start } = ridden();
    // The claim at `start` spent 'a''s floor.
    expect(swing.leave('a', start)).toBe('throttled');
    expect(swing.phase).toBe('riding');
  });

  it('ends on a disconnect, and puts nobody down: they have gone', () => {
    const { swing, start } = ridden();
    const at = later(start);
    expect(swing.gone('a', 'disconnect', at)).toBe(true);
    expect(swing.phase).toBe('cooldown');
    expect(swing.snapshot(at).reason).toBe('disconnect');
    expect(swing.advance(at + SWING_COOLDOWN_MS)).toEqual([]);
    expect(swing.phase).toBe('idle');
  });

  it('ends when the rider leaves the roof, and puts nobody down there either', () => {
    const { swing, start } = ridden();
    const at = later(start);
    expect(swing.gone('a', 'left', at)).toBe(true);
    expect(swing.phase).toBe('cooldown');
    expect(swing.snapshot(at).reason).toBe('left');
    expect(swing.advance(at + SWING_COOLDOWN_MS)).toEqual([]);
  });

  it('reports no change when someone who is not the rider goes', () => {
    const { swing, start } = ridden();
    expect(swing.gone('b', 'disconnect', later(start))).toBe(false);
    expect(swing.phase).toBe('riding');
  });

  it('drops the step-off when a rider leaves during the cooldown', () => {
    const { swing, start } = ridden();
    const over = start + SWING_RIDE_MS;
    swing.advance(over);
    expect(swing.phase).toBe('cooldown');
    // They walk off the roof before the cooldown closes: nothing places them.
    expect(swing.gone('a', 'left', over + 1)).toBe(true);
    expect(swing.advance(over + SWING_COOLDOWN_MS)).toEqual([]);
  });

  it('frees the swing for the next claimant after every ending', () => {
    for (const end of ['timeout', 'left', 'disconnect'] as const) {
      const { swing, start } = ridden();
      const at = later(start);
      if (end === 'timeout') swing.advance(start + SWING_RIDE_MS);
      else if (end === 'left') swing.leave('a', at);
      else swing.gone('a', 'disconnect', at);
      const free = start + SWING_RIDE_MS + SWING_COOLDOWN_MS * 2;
      expect(swing.claim(claimant('b', B), free), end).toBe('applied');
      expect(swing.snapshot(free).riderId).toBe(B);
    }
  });

  it('forgets a disconnected session\'s floor, so a reconnect is not throttled', () => {
    const swing = createSwingAuthority();
    expect(swing.claim(claimant('a', A, AWAY), 1000)).toBe('rejected');
    swing.gone('a', 'disconnect', 1000);
    expect(swing.claim(claimant('a', A), 1000)).toBe('applied');
  });
});

describe('the swing\'s clock (D-131)', () => {
  it('is active exactly while a deadline is pending, so an idle swing costs nothing', () => {
    const swing = createSwingAuthority();
    expect(swing.active).toBe(false);
    swing.claim(claimant('a', A), 1000);
    expect(swing.active).toBe(true);
    swing.advance(1000 + SWING_RIDE_MS);
    expect(swing.active).toBe(true); // cooling down
    swing.advance(1000 + SWING_RIDE_MS + SWING_COOLDOWN_MS);
    expect(swing.active).toBe(false);
  });

  it('starts idle, frozen, and with nothing to do', () => {
    const swing = createSwingAuthority();
    expect(swing.snapshot(0)).toEqual({
      phase: 'idle', round: 0, riderId: null, secondsLeft: 0, reason: null,
    });
    expect(Object.isFrozen(swing.snapshot(0))).toBe(true);
    expect(swing.advance(0)).toEqual([]);
  });

  it('refuses a time that is not a finite, non-negative number', () => {
    const swing = createSwingAuthority();
    expect(swing.claim(claimant('a', A), Number.NaN)).toBe('throttled');
    expect(swing.claim(claimant('b', B), -1)).toBe('throttled');
    expect(swing.phase).toBe('idle');
  });
});
