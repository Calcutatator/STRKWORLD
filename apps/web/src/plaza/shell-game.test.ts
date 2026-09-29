import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  SHELL_BASE_SWAP_MS,
  SHELL_CUPS,
  SHELL_MIN_SWAP_MS,
  SHELL_SWAPS,
  createShellStreak,
  cryptoRandomInt,
  planShellRound,
  shellNoteSlot,
  shellPickWins,
  shellSlots,
  shellSteps,
  shellSwapMs,
  type RandomInt,
} from './shell-game.js';

/**
 * "Where's the note?" (D-076): a fair, honest shell game. The note starts
 * under a cup the die chose, rides its cup through every swap, and a pick
 * wins exactly when it finds it.
 */

/** A die that rolls the given faces in turn. */
function rolls(...faces: number[]): RandomInt {
  let index = 0;
  return (bound) => {
    const face = faces[index % faces.length]!;
    index += 1;
    return face % bound;
  };
}

describe('the shell game rules (D-076)', () => {
  it('draws fair from crypto.getRandomValues, redrawing the uneven top of the range', () => {
    const draws = [0xffff_ffff, 0xffff_fffe, 7];
    let calls = 0;
    const fill = (array: Uint32Array): Uint32Array => {
      array[0] = draws[calls]!;
      calls += 1;
      return array;
    };
    // 2^32 mod 3 is 1, so only 0xffffffff sits in the uneven top and is drawn again.
    expect(cryptoRandomInt(3, fill)).toBe(0xffff_fffe % 3);
    expect(calls).toBe(2);
    expect(() => cryptoRandomInt(0)).toThrow(RangeError);
    // The real source, a few thousand times: every face comes up, none outside.
    const seen = new Set<number>();
    for (let i = 0; i < 3_000; i++) {
      const face = cryptoRandomInt(3);
      expect(face).toBeGreaterThanOrEqual(0);
      expect(face).toBeLessThan(3);
      seen.add(face);
    }
    expect(seen).toEqual(new Set([0, 1, 2]));
  });

  it('uses the Web Crypto source by default, not Math.random', () => {
    const source = readFileSync(new URL('./shell-game.ts', import.meta.url), 'utf8');
    expect(source).toContain('crypto.getRandomValues');
    expect(source).not.toMatch(/Math\.random/);
  });

  it('carries the note in its cup through every swap', () => {
    const round = planShellRound(rolls(1, 0, 0, 2, 1, 1, 0, 0, 0, 2, 1, 0, 1), 0);
    expect(round.noteCup).toBe(1);
    expect(round.swaps).toHaveLength(SHELL_SWAPS);
    for (const [a, b] of round.swaps) expect(a).not.toBe(b);
    let slots = [0, 1, 2];
    for (const [a, b] of round.swaps) {
      slots = slots.map((slot) => (slot === a ? b : slot === b ? a : slot));
    }
    expect(shellSlots(round)).toEqual(slots);
    expect(shellNoteSlot(round)).toBe(slots[1]);
    // Every cup still has its own slot.
    expect(new Set(shellSlots(round)).size).toBe(SHELL_CUPS);
  });

  it('wins a pick exactly when it is the slot the note ended in', () => {
    const round = planShellRound(rolls(2, 1, 0, 0, 1, 2, 0, 1, 1, 0, 0, 2, 1), 0);
    const note = shellNoteSlot(round);
    for (let slot = 0; slot < SHELL_CUPS; slot++) expect(shellPickWins(round, slot)).toBe(slot === note);
  });

  it('is fair: over every starting cup the note ends in each slot equally often', () => {
    // Fix the swaps and vary only the die's first roll, the note's cup.
    const counts = [0, 0, 0];
    for (let start = 0; start < SHELL_CUPS; start++) {
      for (let trial = 0; trial < 50; trial++) {
        const faces = [start, ...Array.from({ length: SHELL_SWAPS * 2 }, (_, i) => (i * 7 + trial) % 6)];
        counts[shellNoteSlot(planShellRound(rolls(...faces), 0))]! += 1;
      }
    }
    expect(counts).toEqual([50, 50, 50]);
  });

  it('refuses a die that rolls off the table', () => {
    expect(() => planShellRound(() => 3, 0)).toThrow(RangeError);
    expect(() => planShellRound(() => -1, 0)).toThrow(RangeError);
    expect(() => planShellRound(() => 0.5, 0)).toThrow(RangeError);
  });

  it('shuffles a little faster with every win in a row, down to a floor', () => {
    expect(shellSwapMs(0)).toBe(SHELL_BASE_SWAP_MS);
    const paces = Array.from({ length: 12 }, (_, streak) => shellSwapMs(streak));
    for (let i = 1; i < paces.length; i++) expect(paces[i]!).toBeLessThanOrEqual(paces[i - 1]!);
    expect(paces[1]!).toBeLessThan(paces[0]!);
    expect(paces[0]! - paces[1]!).toBeLessThan(80);
    expect(Math.min(...paces)).toBe(SHELL_MIN_SWAP_MS);
    expect(shellSwapMs(-3)).toBe(SHELL_BASE_SWAP_MS);
    expect(planShellRound(rolls(0), 3).swapMs).toBe(shellSwapMs(3));
  });

  it('keeps a session streak: up on a win, back to zero on a miss', () => {
    const streak = createShellStreak();
    expect(streak.store.getState()).toBe(0);
    expect(streak.record(true)).toBe(1);
    expect(streak.record(true)).toBe(2);
    expect(streak.record(false)).toBe(0);
    expect(streak.store.getState()).toBe(0);
  });

  it('shows every swap, or for reduced motion one quick fade to the same result', () => {
    const round = planShellRound(rolls(0, 1, 0, 2, 1, 0, 2, 1, 0, 2, 0, 1, 1), 2);
    const full = shellSteps(round, false);
    expect(full).toHaveLength(SHELL_SWAPS);
    expect(full.every((step) => step.kind === 'swap' && step.ms === round.swapMs)).toBe(true);
    expect(full.at(-1)).toMatchObject({ slots: shellSlots(round) });
    const reduced = shellSteps(round, true);
    expect(reduced.map((step) => step.kind)).toEqual(['fade-out', 'fade-in']);
    expect(reduced.some((step) => step.kind === 'swap')).toBe(false);
    expect(reduced[1]).toMatchObject({ slots: shellSlots(round) });
    expect(reduced.reduce((total, step) => total + step.ms, 0)).toBeLessThan(round.swapMs);
  });
});
