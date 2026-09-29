import { createStore, type ReadableStore } from '../store/store.js';

/**
 * "Where's the note?" (D-076): the Privacy Plaza's shell game, as pure rules.
 *
 * Client-only and for fun: no money, no wallet, no backend, no lobby, and
 * nothing kept past this page's life. The rules are honest. The note starts
 * under a cup chosen with `crypto.getRandomValues`, every shuffle step swaps
 * two positions with the note travelling in its cup, and a pick wins exactly
 * when it is the slot the note ended in. The shuffle quickens a little with
 * the streak.
 */

export const SHELL_CUPS = 3;
/** Swaps in one shuffle. */
export const SHELL_SWAPS = 6;
/** One swap's length with no streak, and the fastest it gets. */
export const SHELL_BASE_SWAP_MS = 520;
export const SHELL_MIN_SWAP_MS = 240;
/** Each win in a row makes the next shuffle this much quicker. */
export const SHELL_SPEEDUP = 0.9;
/** The reduced-motion shuffle: a quick fade out and back in, in place of the swaps. */
export const SHELL_FADE_MS = 160;

/** A uniform integer in `[0, bound)`. */
export type RandomInt = (bound: number) => number;

/**
 * A fair die from `crypto.getRandomValues`: 32 random bits, redrawn while
 * they fall in the uneven top of the range, so every outcome is exactly
 * equally likely.
 */
export function cryptoRandomInt(
  bound: number,
  fill: (array: Uint32Array) => Uint32Array = (array) => globalThis.crypto.getRandomValues(array),
): number {
  if (!Number.isSafeInteger(bound) || bound < 1 || bound > 2 ** 32) throw new RangeError('A die needs a whole number of sides.');
  const range = 2 ** 32;
  const limit = range - (range % bound);
  const draw = new Uint32Array(1);
  for (let tries = 0; tries < 1_000; tries++) {
    fill(draw);
    const value = draw[0]!;
    if (value < limit) return value % bound;
  }
  throw new Error('The random source never produced a fair draw.');
}

/** One round: where the note starts, the swaps (slot pairs) and their pace. */
export interface ShellRound {
  /** The cup, by identity, that hides the note. Cup `i` starts in slot `i`. */
  readonly noteCup: number;
  readonly swaps: readonly (readonly [number, number])[];
  readonly swapMs: number;
}

/** A little faster with every win in a row, never below the floor. */
export function shellSwapMs(streak: number): number {
  const wins = Number.isSafeInteger(streak) && streak > 0 ? streak : 0;
  return Math.max(SHELL_MIN_SWAP_MS, Math.round(SHELL_BASE_SWAP_MS * SHELL_SPEEDUP ** wins));
}

export function planShellRound(random: RandomInt, streak: number): ShellRound {
  const noteCup = die(random, SHELL_CUPS);
  const swaps: (readonly [number, number])[] = [];
  for (let i = 0; i < SHELL_SWAPS; i++) {
    const a = die(random, SHELL_CUPS);
    const b = (a + 1 + die(random, SHELL_CUPS - 1)) % SHELL_CUPS;
    swaps.push(Object.freeze([a, b] as const));
  }
  return Object.freeze({ noteCup, swaps: Object.freeze(swaps), swapMs: shellSwapMs(streak) });
}

/** Each cup's slot after the first `done` swaps: index is the cup, value its slot. */
export function shellSlots(round: ShellRound, done: number = round.swaps.length): readonly number[] {
  const slots = Array.from({ length: SHELL_CUPS }, (_, cup) => cup);
  for (const [a, b] of round.swaps.slice(0, Math.max(0, done))) {
    for (let cup = 0; cup < SHELL_CUPS; cup++) {
      if (slots[cup] === a) slots[cup] = b;
      else if (slots[cup] === b) slots[cup] = a;
    }
  }
  return Object.freeze(slots);
}

/** The slot the note ends in. */
export function shellNoteSlot(round: ShellRound): number {
  return shellSlots(round)[round.noteCup]!;
}

/** A pick, by slot, wins exactly when the note ended there. */
export function shellPickWins(round: ShellRound, slot: number): boolean {
  return slot === shellNoteSlot(round);
}

/** What the table shows while it shuffles: every swap, or for reduced motion one quick fade. */
export type ShellStep =
  | { readonly kind: 'swap'; readonly slots: readonly number[]; readonly lifted: readonly [number, number]; readonly ms: number }
  | { readonly kind: 'fade-out'; readonly ms: number }
  | { readonly kind: 'fade-in'; readonly slots: readonly number[]; readonly ms: number };

export function shellSteps(round: ShellRound, reducedMotion: boolean): readonly ShellStep[] {
  if (reducedMotion) {
    return Object.freeze([
      Object.freeze({ kind: 'fade-out' as const, ms: SHELL_FADE_MS }),
      Object.freeze({ kind: 'fade-in' as const, slots: shellSlots(round), ms: SHELL_FADE_MS }),
    ]);
  }
  return Object.freeze(round.swaps.map((pair, index) => {
    const before = shellSlots(round, index);
    // The two cups on the move: one passes in front, one behind.
    const moving = [before.indexOf(pair[0]), before.indexOf(pair[1])] as const;
    return Object.freeze({ kind: 'swap' as const, slots: shellSlots(round, index + 1), lifted: moving, ms: round.swapMs });
  }));
}

/** The streak lives for this page only, in memory. */
export interface ShellStreak {
  readonly store: ReadableStore<number>;
  record(win: boolean): number;
}

export function createShellStreak(): ShellStreak {
  const store = createStore(0);
  return Object.freeze({
    store,
    record(win: boolean): number {
      const next = win ? store.getState() + 1 : 0;
      store.setState(next);
      return next;
    },
  });
}

function die(random: RandomInt, bound: number): number {
  const value = random(bound);
  if (!Number.isSafeInteger(value) || value < 0 || value >= bound) throw new RangeError('The random source rolled off the die.');
  return value;
}
