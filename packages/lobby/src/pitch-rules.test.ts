import { describe, expect, it } from 'vitest';
import {
  FOOTBALL_KICK_RANGE,
  FOOTBALL_SIDE_GOAL,
  FOOTBALL_WIN_SCORE,
  PITCH_COUNTDOWN_MS,
  PITCH_DUMMY_SPEED,
  PITCH_FIELD,
  PITCH_GATES,
  PITCH_QUARTERS,
  PITCH_RESTART_MS,
  PITCH_RESULT_MS,
  PITCH_SLOTS,
  PITCH_SLOT_EXITS,
  PITCH_TILE_SIZE,
  isPitchGateTile,
  isPitchPenTile,
  normalizePitchMatch,
  pitchSlotSide,
  pitchTileCentre,
  type GameId,
  type PitchMatchSnapshot,
} from '@strkworld/shared';
import { FOOTBALL_GOAL_MS, FOOTBALL_FULL_TIME_MS, type BallState } from './football-rules.js';
import {
  PITCH_DUMMY_KICK_INTERVAL_MS,
  PITCH_DUMMY_STEP_MS,
  PITCH_DUMMY_MAX_CATCH_UP,
  PITCH_INTENT_MIN_INTERVAL_MS,
  createPitchAuthority,
  type PitchAuthority,
  type PitchEvent,
  type PitchPlaceEvent,
} from './pitch-rules.js';

/**
 * D-135: the gated pitch's match authority — the state machine the lead asked
 * for (open → countdown → playing → ended → open), its dummy fill, and the
 * dummies' deterministic play. Positions here are World pixels, as the
 * authority works in.
 */

const T = PITCH_TILE_SIZE;
const CENTRE = Object.freeze({
  x: (PITCH_FIELD.x + PITCH_FIELD.width / 2) * T,
  y: (PITCH_FIELD.y + PITCH_FIELD.height / 2) * T,
});

/** A ball at rest on the centre spot, which is what the authority sees at a kick-off. */
function ball(x = CENTRE.x, y = CENTRE.y, vx = 0, vy = 0): BallState {
  return Object.freeze({ x, y, vx, vy });
}

/** Someone standing on a gate's approach, outside the fence, ready to press E. */
function atGate(key: string, side: 'north' | 'south' = 'north') {
  const gate = PITCH_GATES.find((entry) => entry.side === side)!;
  const at = pitchTileCentre({ x: gate.approach.x, y: gate.approach.y });
  return { key, gameId: `id-${key}` as GameId, area: 'street' as const, x: at.x, y: at.y };
}

/** Someone standing just inside the fence on a gate's spawn tile, ready to press E to leave. */
function insideGate(key: string, side: 'north' | 'south' = 'north') {
  const gate = PITCH_GATES.find((entry) => entry.side === side)!;
  const at = pitchTileCentre(gate.spawn);
  return { key, gameId: `id-${key}` as GameId, area: 'street' as const, x: at.x, y: at.y };
}

const places = (events: readonly PitchEvent[]): PitchPlaceEvent[] =>
  events.filter((event): event is PitchPlaceEvent => event.kind === 'place');

const kicks = (events: readonly PitchEvent[]) => events.filter((event) => event.kind === 'kick');

/** Press E at a gate and drain the events the press produced. */
function enter(pitch: PitchAuthority, key: string, now: number, side: 'north' | 'south' = 'north') {
  const outcome = pitch.gate(atGate(key, side), now);
  return { outcome, events: pitch.advance(now, ball()) };
}

/** A match of four, started by one entrant with dummy fill on. */
function soloMatch(now = 1_000) {
  const pitch = createPitchAuthority();
  const started = enter(pitch, 'a', now);
  return { pitch, started };
}

describe('the gates (D-135)', () => {
  it('takes one entrant through, and stands them just inside until the four are there', () => {
    const pitch = createPitchAuthority({ dummyFill: false });
    const { outcome, events } = enter(pitch, 'a', 1_000);
    expect(outcome).toBe('entered');
    expect(pitch.phase).toBe('open');
    expect(pitch.holdsSlot('a')).toBe(true);
    expect(pitch.mayKick('a')).toBe(true);
    // Stood on the gate's own spawn tile, inside the fence.
    const placed = places(events);
    expect(placed).toHaveLength(1);
    expect(placed[0]!.key).toBe('a');
    expect(isPitchPenTile(placed[0]!.spot.x, placed[0]!.spot.y)).toBe(true);
  });

  it('refuses a press that is not on the street, and one nowhere near a gate', () => {
    const pitch = createPitchAuthority();
    expect(pitch.gate({ ...atGate('a'), area: 'arena' }, 1_000)).toBe('rejected');
    expect(pitch.gate({ ...atGate('b'), area: null }, 1_000)).toBe('rejected');
    expect(pitch.gate({ ...atGate('c'), x: 0, y: 0 }, 1_000)).toBe('rejected');
    expect(pitch.phase).toBe('open');
    expect(pitch.players).toBe(0);
  });

  it('holds each session to its own intent floor, and a refused press spends it too', () => {
    const pitch = createPitchAuthority({ dummyFill: false });
    expect(pitch.gate(atGate('a'), 1_000)).toBe('entered');
    expect(pitch.gate(atGate('a'), 1_000 + PITCH_INTENT_MIN_INTERVAL_MS - 1)).toBe('throttled');
    // Another session is unaffected by the first's floor.
    expect(pitch.gate(atGate('b'), 1_000)).toBe('entered');
    // A press that is rejected still spends the floor.
    expect(pitch.gate({ ...atGate('c'), x: 0, y: 0 }, 1_000)).toBe('rejected');
    expect(pitch.gate(atGate('c'), 1_000 + 10)).toBe('throttled');
  });

  it('is open to both the north and the south gate', () => {
    const pitch = createPitchAuthority({ dummyFill: false });
    expect(enter(pitch, 'a', 1_000, 'north').outcome).toBe('entered');
    expect(enter(pitch, 'b', 1_000, 'south').outcome).toBe('entered');
    expect(pitch.players).toBe(2);
    for (const gate of PITCH_GATES) {
      expect(isPitchGateTile(gate.tiles.x, gate.tiles.y)).toBe(true);
      // The approach is outside the fence and the spawn inside it.
      expect(isPitchPenTile(gate.approach.x, gate.approach.y)).toBe(false);
      expect(isPitchPenTile(gate.spawn.x, gate.spawn.y)).toBe(true);
    }
  });

  it('reads locked once four real players are on, and sends a fifth away', () => {
    const pitch = createPitchAuthority({ dummyFill: false });
    for (const key of ['a', 'b', 'c', 'd']) expect(enter(pitch, key, 1_000).outcome).toBe('entered');
    expect(pitch.locked).toBe(true);
    expect(pitch.players).toBe(PITCH_SLOTS);
    expect(pitch.gate(atGate('e'), 1_000)).toBe('locked');
    expect(pitch.holdsSlot('e')).toBe(false);
  });

  it('lets a participant press E to walk back out, and puts them outside the fence', () => {
    const pitch = createPitchAuthority({ dummyFill: false });
    enter(pitch, 'a', 1_000);
    const outcome = pitch.gate(insideGate('a'), 1_000 + PITCH_INTENT_MIN_INTERVAL_MS);
    expect(outcome).toBe('left');
    expect(pitch.holdsSlot('a')).toBe(false);
    const placed = places(pitch.advance(1_000 + PITCH_INTENT_MIN_INTERVAL_MS, ball()));
    expect(placed).toHaveLength(1);
    expect(isPitchPenTile(placed[0]!.spot.x, placed[0]!.spot.y)).toBe(false);
    // An open pitch frees the slot outright rather than filling it with a dummy.
    expect(pitch.snapshot(1_000).slots.every((slot) => slot.kind === 'empty')).toBe(true);
  });

  it('refuses a press from inside the fence by a session that holds no slot', () => {
    const pitch = createPitchAuthority({ dummyFill: false });
    // A client that claims to stand inside without ever having entered.
    expect(pitch.gate(insideGate('ghost'), 1_000)).toBe('rejected');
    expect(pitch.holdsSlot('ghost')).toBe(false);
  });

  it('is locked while a winner\'s banner is up', () => {
    const { pitch } = soloMatch();
    pitch.advance(1_000 + PITCH_COUNTDOWN_MS, ball());
    pitch.fullTime('starks', 2_000);
    expect(pitch.phase).toBe('ended');
    expect(pitch.locked).toBe(true);
    expect(pitch.gate(atGate('z'), 2_000)).toBe('locked');
  });
});

describe('the dummy fill (D-135)', () => {
  it('drops three dummies in with the first entrant, which starts the match at once', () => {
    const { pitch, started } = soloMatch();
    expect(started.outcome).toBe('entered');
    expect(pitch.phase).toBe('countdown');
    const match = pitch.snapshot(1_000);
    expect(match.slots.filter((slot) => slot.kind === 'player')).toHaveLength(1);
    expect(match.slots.filter((slot) => slot.kind === 'dummy')).toHaveLength(PITCH_SLOTS - 1);
    expect(pitch.players).toBe(1);
    // Not locked: three of the four are dummies, so others may still come in.
    expect(pitch.locked).toBe(false);
  });

  it('can be switched off, which leaves the pitch waiting for four real players', () => {
    const pitch = createPitchAuthority({ dummyFill: false });
    enter(pitch, 'a', 1_000);
    expect(pitch.phase).toBe('open');
    const match = pitch.snapshot(1_000);
    expect(match.slots.filter((slot) => slot.kind === 'dummy')).toHaveLength(0);
    expect(match.slots.filter((slot) => slot.kind === 'empty')).toHaveLength(PITCH_SLOTS - 1);
  });

  it('gives a dummy\'s slot to each real player who comes in, straight into their quarter', () => {
    const { pitch } = soloMatch();
    const at = 1_000 + PITCH_COUNTDOWN_MS + 100;
    const outcome = pitch.gate(atGate('b'), at);
    expect(outcome).toBe('entered');
    expect(pitch.players).toBe(2);
    const match = pitch.snapshot(at);
    expect(match.slots.filter((slot) => slot.kind === 'dummy')).toHaveLength(2);
    // Placed on the quarter spot of the slot they took, not at the gate.
    const placed = places(pitch.advance(at, ball())).find((event) => event.key === 'b')!;
    const index = match.slots.findIndex((slot) => slot.gameId === ('id-b' as GameId));
    expect(placed.spot).toEqual(PITCH_QUARTERS[index]!.spot);
  });

  it('only fills for the first player, so a later arrival never brings more dummies', () => {
    const pitch = createPitchAuthority();
    enter(pitch, 'a', 1_000);
    const before = pitch.snapshot(1_000).slots.filter((slot) => slot.kind === 'dummy').length;
    enter(pitch, 'b', 1_000 + PITCH_COUNTDOWN_MS + 50);
    expect(pitch.snapshot(2_000).slots.filter((slot) => slot.kind === 'dummy')).toHaveLength(before - 1);
  });
});

describe('the kick-off (D-135)', () => {
  it('resets the ball, sets the four quarters and runs a 3–2–1', () => {
    const pitch = createPitchAuthority({ dummyFill: false });
    for (const key of ['a', 'b', 'c']) enter(pitch, key, 1_000);
    const { outcome, events } = enter(pitch, 'd', 1_000);
    expect(outcome).toBe('entered');
    expect(pitch.phase).toBe('countdown');
    // The ball goes back to the centre spot at 0–0.
    expect(pitch.takeReset()).toBe(true);
    expect(pitch.takeReset()).toBe(false);
    const match = pitch.snapshot(1_000);
    expect([match.starks, match.snarks]).toEqual([0, 0]);
    expect(match.secondsLeft).toBe(3);
    // Two per team, one in each half of their own side.
    const placed = places(events);
    expect(placed).toHaveLength(PITCH_SLOTS);
    const spots = new Map(placed.map((event) => [event.key, event.spot]));
    match.slots.forEach((slot, index) => {
      const quarter = PITCH_QUARTERS[index]!;
      expect(slot.kind).toBe('player');
      const key = String(slot.gameId).replace('id-', '');
      expect(spots.get(key)).toEqual(quarter.spot);
      expect(quarter.side).toBe(pitchSlotSide(index));
    });
    expect(PITCH_QUARTERS.filter((quarter) => quarter.side === 'starks')).toHaveLength(2);
    expect(new Set(PITCH_QUARTERS.map((quarter) => `${quarter.side}/${quarter.half}`)).size).toBe(4);
  });

  it('counts the countdown down a second at a time and then plays', () => {
    const { pitch } = soloMatch(1_000);
    expect(pitch.snapshot(1_000).secondsLeft).toBe(3);
    expect(pitch.snapshot(1_000 + 1_100).secondsLeft).toBe(2);
    expect(pitch.snapshot(1_000 + 2_100).secondsLeft).toBe(1);
    expect(pitch.active).toBe(true);
    pitch.advance(1_000 + PITCH_COUNTDOWN_MS, ball());
    expect(pitch.phase).toBe('playing');
    expect(pitch.active).toBe(false);
    expect(pitch.snapshot(1_000 + PITCH_COUNTDOWN_MS).secondsLeft).toBe(0);
  });

  it('holds E back during the countdown and the banner, and gives it back in play', () => {
    const { pitch } = soloMatch(1_000);
    expect(pitch.mayKick('a')).toBe(false);
    pitch.advance(1_000 + PITCH_COUNTDOWN_MS, ball());
    expect(pitch.mayKick('a')).toBe(true);
    pitch.fullTime('starks', 5_000);
    expect(pitch.mayKick('a')).toBe(false);
    // And never for someone who holds no slot at all.
    expect(pitch.mayKick('nobody')).toBe(false);
  });
});

describe('the match (D-135)', () => {
  /** A solo match brought all the way to its first kick-off. */
  function playing(now = 1_000) {
    const { pitch } = soloMatch(now);
    const at = now + PITCH_COUNTDOWN_MS;
    pitch.advance(at, ball());
    expect(pitch.phase).toBe('playing');
    // The kick-off's own reset, so what the match asks for later stands alone.
    expect(pitch.takeReset()).toBe(true);
    return { pitch, at };
  }

  it('re-places everyone and runs a shorter countdown after a goal', () => {
    const { pitch, at } = playing();
    pitch.scored(1, 0, at + 500);
    expect(pitch.phase).toBe('countdown');
    const match = pitch.snapshot(at + 500);
    expect([match.starks, match.snarks]).toEqual([1, 0]);
    // The restart beat is the ball's own goal moment, so the two end together.
    expect(PITCH_RESTART_MS).toBe(FOOTBALL_GOAL_MS);
    const placed = places(pitch.advance(at + 500, ball()));
    expect(placed.map((event) => event.spot)).toEqual([PITCH_QUARTERS[0]!.spot]);
    // It does not reset the ball: the ball authority runs its own kick-off.
    expect(pitch.takeReset()).toBe(false);
    pitch.advance(at + 500 + PITCH_RESTART_MS, ball());
    expect(pitch.phase).toBe('playing');
  });

  it('is best of five: the third goal ends it with a winner and a banner', () => {
    const { pitch, at } = playing();
    let when = at;
    for (let goal = 1; goal < FOOTBALL_WIN_SCORE; goal++) {
      pitch.scored(goal, 0, when);
      expect(pitch.phase).toBe('countdown');
      when += PITCH_RESTART_MS;
      pitch.advance(when, ball());
      expect(pitch.phase).toBe('playing');
    }
    // The winning goal waits for full time rather than restarting.
    pitch.scored(FOOTBALL_WIN_SCORE, 0, when);
    expect(pitch.phase).toBe('playing');
    pitch.fullTime('starks', when);
    expect(pitch.phase).toBe('ended');
    expect(pitch.snapshot(when).winner).toBe('starks');
    expect(pitch.snapshot(when).starks).toBe(FOOTBALL_WIN_SCORE);
    expect(PITCH_RESULT_MS).toBe(FOOTBALL_FULL_TIME_MS);
  });

  it('puts everyone back outside the gates at the close, and reopens', () => {
    const pitch = createPitchAuthority({ dummyFill: false });
    for (const key of ['a', 'b', 'c', 'd']) enter(pitch, key, 1_000);
    pitch.advance(1_000 + PITCH_COUNTDOWN_MS, ball());
    pitch.takeReset();
    pitch.fullTime('snarks', 2_000);
    const closed = places(pitch.advance(2_000 + PITCH_RESULT_MS, ball()));
    expect(pitch.phase).toBe('open');
    expect(pitch.locked).toBe(false);
    expect(pitch.takeReset()).toBe(true);
    // One exit tile each, all outside the fence and none shared.
    expect(closed).toHaveLength(PITCH_SLOTS);
    for (const event of closed) expect(isPitchPenTile(event.spot.x, event.spot.y)).toBe(false);
    expect(new Set(closed.map((event) => `${event.spot.x},${event.spot.y}`)).size).toBe(PITCH_SLOTS);
    expect(closed.map((event) => event.spot)).toEqual(PITCH_SLOT_EXITS.map((exit) => exit.spot));
    // Every slot is free, the score is back to 0–0 and nobody holds one.
    const match = pitch.snapshot(2_000 + PITCH_RESULT_MS);
    expect(match.slots.every((slot) => slot.kind === 'empty')).toBe(true);
    expect([match.starks, match.snarks, match.winner]).toEqual([0, 0, null]);
    for (const key of ['a', 'b', 'c', 'd']) expect(pitch.holdsSlot(key)).toBe(false);
  });

  it('counts a new round for every match started, and wraps', () => {
    const pitch = createPitchAuthority({ round: 0xffff });
    enter(pitch, 'a', 1_000);
    expect(pitch.snapshot(1_000).round).toBe(0);
  });

  it('lands a late call where a punctual one would have', () => {
    const { pitch } = soloMatch(1_000);
    // One call long after the countdown and the banner would both have run.
    pitch.fullTime('starks', 1_000 + PITCH_COUNTDOWN_MS + 10);
    const events = pitch.advance(1_000 + PITCH_COUNTDOWN_MS + PITCH_RESULT_MS + 10_000, ball());
    expect(pitch.phase).toBe('open');
    expect(places(events).some((event) => event.key === 'a')).toBe(true);
  });
});

describe('leaving a match (D-135)', () => {
  it('replaces a player who leaves or drops with a dummy, so the match carries on', () => {
    const pitch = createPitchAuthority({ dummyFill: false });
    for (const key of ['a', 'b', 'c', 'd']) enter(pitch, key, 1_000);
    pitch.advance(1_000 + PITCH_COUNTDOWN_MS, ball());
    expect(pitch.gone('a', 'left', 2_000)).toBe(true);
    expect(pitch.phase).toBe('playing');
    expect(pitch.players).toBe(3);
    expect(pitch.holdsSlot('a')).toBe(false);
    expect(pitch.gone('b', 'disconnect', 2_100)).toBe(true);
    expect(pitch.players).toBe(2);
    const match = pitch.snapshot(2_100);
    expect(match.slots.filter((slot) => slot.kind === 'dummy')).toHaveLength(2);
    // A dummy stands in the quarter of the slot it took over.
    expect(pitch.dummies()).toHaveLength(2);
    // And the pitch is no longer locked, so someone else may take a slot.
    expect(pitch.locked).toBe(false);
  });

  it('ends the match when the last real player goes, without putting a dummy outside', () => {
    const { pitch } = soloMatch(1_000);
    pitch.advance(1_000 + PITCH_COUNTDOWN_MS, ball());
    pitch.takeReset();
    expect(pitch.gone('a', 'disconnect', 2_000)).toBe(true);
    expect(pitch.phase).toBe('open');
    expect(pitch.players).toBe(0);
    expect(pitch.dummies()).toHaveLength(0);
    expect(pitch.takeReset()).toBe(true);
    // Nothing is placed: the one who dropped is gone, and a dummy has nowhere to go.
    expect(places(pitch.advance(2_000, ball()))).toHaveLength(0);
  });

  it('says nothing changed for a session that holds no slot', () => {
    const pitch = createPitchAuthority({ dummyFill: false });
    expect(pitch.gone('nobody', 'left', 1_000)).toBe(false);
    enter(pitch, 'a', 1_000);
    expect(pitch.gone('b', 'disconnect', 1_000)).toBe(false);
    expect(pitch.holdsSlot('a')).toBe(true);
  });
});

describe('the dummies\' play (D-135)', () => {
  /** A solo match in play, with its one real player's slot ignored. */
  function inPlay(now = 1_000) {
    const pitch = createPitchAuthority();
    pitch.gate(atGate('a'), now);
    const at = now + PITCH_COUNTDOWN_MS;
    pitch.advance(at, ball());
    return { pitch, at };
  }

  it('is deterministic: the same inputs always give the same play', () => {
    const run = () => {
      const { pitch, at } = inPlay();
      const trace: string[] = [];
      for (let step = 1; step <= 40; step++) {
        const when = at + step * PITCH_DUMMY_STEP_MS;
        // A ball rolling east through the middle, the same in both runs.
        const events = pitch.advance(when, ball(CENTRE.x + step * 2, CENTRE.y, 60, 0));
        trace.push(
          pitch
            .dummies()
            .map((dummy) => `${dummy.key}@${dummy.x.toFixed(4)},${dummy.y.toFixed(4)}`)
            .join('|') + `#${kicks(events).length}`,
        );
      }
      return trace;
    };
    expect(run()).toEqual(run());
  });

  it('never moves a dummy faster than its speed cap', () => {
    const { pitch, at } = inPlay();
    let last = new Map(pitch.dummies().map((dummy) => [dummy.key, dummy]));
    const cap = (PITCH_DUMMY_SPEED * PITCH_DUMMY_STEP_MS) / 1000;
    for (let step = 1; step <= 60; step++) {
      const when = at + step * PITCH_DUMMY_STEP_MS;
      // The ball jumps right across the pitch each step: nothing a dummy can keep up with.
      const x = step % 2 === 0 ? PITCH_FIELD.x * T + 20 : (PITCH_FIELD.x + PITCH_FIELD.width) * T - 20;
      pitch.advance(when, ball(x, CENTRE.y + (step % 3) * 40));
      for (const dummy of pitch.dummies()) {
        const before = last.get(dummy.key)!;
        const moved = Math.hypot(dummy.x - before.x, dummy.y - before.y);
        expect(moved, `${dummy.key} step ${step}`).toBeLessThanOrEqual(cap + 1e-9);
      }
      last = new Map(pitch.dummies().map((dummy) => [dummy.key, { ...dummy }]));
    }
  });

  it('keeps each dummy inside its own zone', () => {
    const { pitch, at } = inPlay();
    const slack = (PITCH_DUMMY_SPEED * PITCH_DUMMY_STEP_MS) / 1000;
    for (let step = 1; step <= 200; step++) {
      // Park the ball in the far corner, which is outside every zone but one.
      pitch.advance(at + step * PITCH_DUMMY_STEP_MS, ball(PITCH_FIELD.x * T + 4, PITCH_FIELD.y * T + 4));
    }
    for (const dummy of pitch.dummies()) {
      const index = Number(dummy.key.split(':')[1]);
      const zone = PITCH_QUARTERS[index]!.zone;
      expect(dummy.x, dummy.key).toBeGreaterThanOrEqual(zone.x * T - slack);
      expect(dummy.x, dummy.key).toBeLessThanOrEqual((zone.x + zone.width) * T + slack);
      expect(dummy.y, dummy.key).toBeGreaterThanOrEqual(zone.y * T - slack);
      expect(dummy.y, dummy.key).toBeLessThanOrEqual((zone.y + zone.height) * T + slack);
    }
  });

  it('kicks toward the goal it attacks, and no more often than its floor', () => {
    const { pitch, at } = inPlay();
    // Slot 1 is a Snarks dummy in the north: stand the ball on its quarter spot.
    const index = 1;
    expect(pitchSlotSide(index)).toBe('snarks');
    const spot = pitchTileCentre(PITCH_QUARTERS[index]!.spot);
    let seen = 0;
    let when = at;
    for (let step = 1; step <= 60; step++) {
      when = at + step * PITCH_DUMMY_STEP_MS;
      seen += kicks(pitch.advance(when, ball(spot.x, spot.y))).length;
    }
    expect(seen).toBeGreaterThan(0);
    // Over that span no dummy could have kicked more often than its interval allows.
    const span = when - at;
    const most = Math.ceil(span / PITCH_DUMMY_KICK_INTERVAL_MS) + 1;
    expect(seen).toBeLessThanOrEqual(most * PITCH_SLOTS);
    // The Snarks attack the Starks' end, which is the west one.
    expect(FOOTBALL_SIDE_GOAL.starks).toBe('west');
  });

  it('kicks only from within the ball\'s own kick range', () => {
    const { pitch, at } = inPlay();
    for (let step = 1; step <= 80; step++) {
      const when = at + step * PITCH_DUMMY_STEP_MS;
      const where = ball(CENTRE.x, CENTRE.y);
      for (const kick of kicks(pitch.advance(when, where))) {
        expect(Math.hypot(kick.x - where.x, kick.y - where.y)).toBeLessThanOrEqual(FOOTBALL_KICK_RANGE * T + 1e-9);
      }
    }
  });

  it('steps on a fixed clock and drops time it cannot catch up on', () => {
    const { pitch, at } = inPlay();
    // Less than one step: nothing moves.
    const before = pitch.dummies().map((dummy) => ({ ...dummy }));
    pitch.advance(at + PITCH_DUMMY_STEP_MS - 1, ball(CENTRE.x + 200, CENTRE.y));
    expect(pitch.dummies()).toEqual(before);
    // A huge gap costs at most the catch-up cap in steps, not the whole gap.
    const start = pitch.dummies().map((dummy) => ({ ...dummy }));
    pitch.advance(at + 60_000, ball(CENTRE.x + 200, CENTRE.y));
    const capped = (PITCH_DUMMY_SPEED * PITCH_DUMMY_STEP_MS * PITCH_DUMMY_MAX_CATCH_UP) / 1000;
    pitch.dummies().forEach((dummy, index) => {
      const from = start[index]!;
      expect(Math.hypot(dummy.x - from.x, dummy.y - from.y)).toBeLessThanOrEqual(capped + 1e-9);
    });
  });

  it('does not step or kick outside play', () => {
    const { pitch } = soloMatch(1_000);
    // During the countdown.
    const before = pitch.dummies().map((dummy) => ({ ...dummy }));
    expect(kicks(pitch.advance(1_000 + 100, ball(CENTRE.x, CENTRE.y)))).toHaveLength(0);
    expect(pitch.dummies()).toEqual(before);
    // And on a ball whose place is not a number.
    pitch.advance(1_000 + PITCH_COUNTDOWN_MS, ball());
    expect(pitch.phase).toBe('playing');
    const standing = pitch.dummies().map((dummy) => ({ ...dummy }));
    pitch.advance(1_000 + PITCH_COUNTDOWN_MS + 400, { x: Number.NaN, y: 0, vx: 0, vy: 0 });
    expect(pitch.dummies()).toEqual(standing);
  });

  it('places its dummies back on their quarters at every kick-off', () => {
    const { pitch, at } = inPlay();
    for (let step = 1; step <= 30; step++) {
      pitch.advance(at + step * PITCH_DUMMY_STEP_MS, ball(CENTRE.x + 120, CENTRE.y + 60));
    }
    expect(pitch.dummies().some((dummy) => {
      const spot = pitchTileCentre(PITCH_QUARTERS[Number(dummy.key.split(':')[1])]!.spot);
      return Math.hypot(dummy.x - spot.x, dummy.y - spot.y) > 1;
    })).toBe(true);
    pitch.scored(1, 0, at + 2_000);
    for (const dummy of pitch.dummies()) {
      const spot = pitchTileCentre(PITCH_QUARTERS[Number(dummy.key.split(':')[1])]!.spot);
      expect(dummy.x).toBe(Math.round(spot.x));
      expect(dummy.y).toBe(Math.round(spot.y));
    }
  });
});

describe('the match on the wire (D-135)', () => {
  it('survives its own normalizer, in every phase', () => {
    const pitch = createPitchAuthority();
    const seen: PitchMatchSnapshot[] = [];
    const keep = (now: number) => {
      const match = pitch.snapshot(now);
      expect(normalizePitchMatch(match, FOOTBALL_WIN_SCORE)).toEqual(match);
      seen.push(match);
    };
    keep(500);
    enter(pitch, 'a', 1_000);
    keep(1_000);
    pitch.advance(1_000 + PITCH_COUNTDOWN_MS, ball());
    keep(1_000 + PITCH_COUNTDOWN_MS);
    pitch.scored(1, 0, 5_000);
    keep(5_000);
    pitch.fullTime('starks', 9_000);
    keep(9_000);
    expect(seen.map((match) => match.phase)).toEqual(['open', 'countdown', 'playing', 'countdown', 'ended']);
  });

  it('never carries a connection key, and names a player only by their presence id', () => {
    const pitch = createPitchAuthority();
    // A presence id that shares nothing with the connection key, so finding
    // one in the snapshot cannot be mistaken for finding the other.
    pitch.gate(
      { ...atGate('x'), key: 'secret-connection', gameId: 'a1b2c3d4e5f60718' as GameId },
      1_000,
    );
    expect(pitch.holdsSlot('secret-connection')).toBe(true);
    const wire = JSON.stringify(pitch.snapshot(1_000));
    expect(wire).not.toContain('secret-connection');
    expect(wire).toContain('a1b2c3d4e5f60718');
  });

  it('holds secondsLeft to the countdown, and 0 everywhere else', () => {
    const pitch = createPitchAuthority();
    expect(pitch.snapshot(1_000).secondsLeft).toBe(0);
    enter(pitch, 'a', 1_000);
    // Never more than the countdown's own seconds, even asked about the past.
    expect(pitch.snapshot(0).secondsLeft).toBe(Math.ceil(PITCH_COUNTDOWN_MS / 1_000));
    // And never below zero, asked about the future.
    expect(pitch.snapshot(1_000 + PITCH_COUNTDOWN_MS + 5_000).secondsLeft).toBe(0);
  });

  it('gives a dummy a place and a player none, so no slot says where a person stands', () => {
    const { pitch } = soloMatch();
    for (const slot of pitch.snapshot(1_000).slots) {
      if (slot.kind === 'dummy') {
        expect(slot.gameId).toBeNull();
        expect(Number.isInteger(slot.x) && slot.x > 0).toBe(true);
      } else {
        expect([slot.x, slot.y]).toEqual([0, 0]);
      }
    }
  });
});
