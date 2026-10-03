import { describe, expect, it } from 'vitest';
import {
  FOOTBALL_WIN_SCORE,
  PITCH_GATES,
  PITCH_SLOTS,
  pitchTileCentre,
  type GameId,
  type PitchMatchSnapshot,
  type PitchSlot,
} from '@strkworld/shared';
import { PITCH_ENTER_PROMPT, PITCH_LEAVE_PROMPT, PITCH_LOCKED_TEXT } from './map/pitch.js';
import { TILE_SIZE } from './map/street.js';
import {
  PITCH_GATE_TARGET_ID,
  isPitchLocked,
  normalizePitchFrame,
  pitchGateTargets,
} from './pitch-channel.js';

/**
 * D-135: the pitch's two gates as stations on the shared press-E system
 * (D-117). The World decides nothing about who plays — it draws the chip the
 * match implies and sends the press.
 */

const slot = (kind: PitchSlot['kind'], id = 'abcdef0123456789'): PitchSlot =>
  Object.freeze({ kind, gameId: kind === 'player' ? (id as GameId) : null, x: 0, y: 0 });

function match(over: Partial<PitchMatchSnapshot> = {}): PitchMatchSnapshot {
  return Object.freeze({
    phase: 'open' as const,
    round: 1,
    slots: Object.freeze(Array.from({ length: PITCH_SLOTS }, () => slot('empty'))),
    starks: 0,
    snarks: 0,
    secondsLeft: 0,
    winner: null,
    ...over,
  });
}

/** The pixel centre of a gate's approach tile, where E is pressed from. */
function approach(side: 'north' | 'south') {
  const gate = PITCH_GATES.find((entry) => entry.side === side)!;
  return pitchTileCentre({ x: gate.approach.x, y: gate.approach.y });
}

/** The pixel centre of a gate's inside tile, where a participant presses E to leave. */
function inside(side: 'north' | 'south') {
  const gate = PITCH_GATES.find((entry) => entry.side === side)!;
  return pitchTileCentre(gate.spawn);
}

function targetsAt(
  current: PitchMatchSnapshot | null,
  at: { x: number; y: number },
  playing = false,
): { labels: string[]; press: () => void; presses: () => number } {
  let count = 0;
  const list = pitchGateTargets(current, at, playing, () => {
    count += 1;
  }, TILE_SIZE);
  return {
    labels: list.map((target) => target.label),
    press: () => list.forEach((target) => target.activate()),
    presses: () => count,
  };
}

describe('the pitch gates as stations (D-135)', () => {
  it('offers ENTER PITCH on either gate\'s approach while the pitch is open', () => {
    for (const side of ['north', 'south'] as const) {
      const offered = targetsAt(match(), approach(side));
      expect(offered.labels, side).toEqual([PITCH_ENTER_PROMPT]);
      offered.press();
      expect(offered.presses(), side).toBe(1);
    }
  });

  it('offers nothing away from either gate', () => {
    // The centre spot, well inside the fence but nowhere near a gate.
    expect(targetsAt(match(), pitchTileCentre({ x: 14, y: 15 })).labels).toEqual([]);
    // And off the pitch square entirely.
    expect(targetsAt(match(), { x: 0, y: 0 }).labels).toEqual([]);
  });

  it('offers nothing at all with no match: offline, both gates stay shut', () => {
    const offered = targetsAt(null, approach('north'));
    expect(offered.labels).toEqual([]);
    offered.press();
    expect(offered.presses()).toBe(0);
  });

  it('offers LEAVE PITCH from inside a gate to someone who is playing', () => {
    const playing = match({ phase: 'playing', slots: Object.freeze([slot('player'), slot('dummy'), slot('dummy'), slot('dummy')]) });
    const offered = targetsAt(playing, inside('south'), true);
    expect(offered.labels).toEqual([PITCH_LEAVE_PROMPT]);
    offered.press();
    expect(offered.presses()).toBe(1);
  });

  it('reads IN PLAY once every place is taken by a real player, and sends no press', () => {
    const full = match({
      phase: 'playing',
      slots: Object.freeze(['a', 'b', 'c', 'd'].map((id) => slot('player', `${id}0000000000000`))),
    });
    expect(isPitchLocked(full)).toBe(true);
    const offered = targetsAt(full, approach('north'));
    expect(offered.labels).toEqual([PITCH_LOCKED_TEXT]);
    // The chip still shows — saying why the gate will not open is the point —
    // but pressing it sends nothing.
    offered.press();
    expect(offered.presses()).toBe(0);
  });

  it('reads IN PLAY while a winner\'s banner is up, whatever the places hold', () => {
    const ended = match({
      phase: 'ended',
      winner: 'starks',
      starks: FOOTBALL_WIN_SCORE,
      slots: Object.freeze([slot('player'), slot('dummy'), slot('dummy'), slot('dummy')]),
    });
    expect(isPitchLocked(ended)).toBe(true);
    expect(targetsAt(ended, approach('north')).labels).toEqual([PITCH_LOCKED_TEXT]);
  });

  it('is still open while a dummy holds a place, which is how a real player joins a match', () => {
    const running = match({
      phase: 'playing',
      slots: Object.freeze([slot('player'), slot('player', 'b000000000000000'), slot('player', 'c000000000000000'), slot('dummy')]),
    });
    expect(isPitchLocked(running)).toBe(false);
    expect(targetsAt(running, approach('south')).labels).toEqual([PITCH_ENTER_PROMPT]);
  });

  it('is one station wherever it is pressed, measured to the gate\'s own tiles', () => {
    const [target] = pitchGateTargets(match(), approach('north'), false, () => {}, TILE_SIZE);
    expect(target!.id).toBe(PITCH_GATE_TARGET_ID);
    const gate = PITCH_GATES[0]!;
    expect(target!.rect).toEqual({
      x: gate.tiles.x * TILE_SIZE,
      y: gate.tiles.y * TILE_SIZE,
      width: gate.tiles.width * TILE_SIZE,
      height: gate.tiles.height * TILE_SIZE,
    });
    // Both gates answer under the same id, so only one can ever be focused.
    const south = pitchGateTargets(match(), approach('south'), false, () => {}, TILE_SIZE);
    expect(south[0]!.id).toBe(PITCH_GATE_TARGET_ID);
  });
});

describe('normalizePitchFrame (D-135)', () => {
  it('passes a real match and refuses anything else', () => {
    expect(normalizePitchFrame(match())).toEqual(match());
    for (const value of [null, undefined, 0, 'open', [], { phase: 'open' }]) {
      expect(normalizePitchFrame(value), String(value)).toBeNull();
    }
  });

  it('refuses a score past the winning one, so a bad frame never opens a gate', () => {
    expect(normalizePitchFrame(match({ starks: FOOTBALL_WIN_SCORE + 1 }))).toBeNull();
  });
});
