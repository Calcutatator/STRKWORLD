// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShellEvents, WorldEvents } from '@strkworld/shared';
import { createEventBus } from '../../bus/event-bus.js';
import { COPY } from '../../copy.js';
import { attachDebugTap, type DebugTap } from '../../debug/debug-tap.js';
import { PlazaProvider } from '../../plaza/PlazaProvider.js';
import { SHELL_FADE_MS, SHELL_SWAPS, shellSwapMs, type RandomInt } from '../../plaza/shell-game.js';
import { SHELL_SHOW_MS, ShellGamePanel } from './ShellGamePanel.js';

/**
 * "Where's the note?" played through the screen (D-076): hide the note,
 * watch the shuffle, pick a cup, win or lose, and the session streak.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  const owner = root;
  root = null;
  if (owner) act(() => owner.unmount());
  container?.remove();
  container = null;
  attachDebugTap(null);
  vi.useRealTimers();
});

/** A die that rolls through fixed faces, over and over. */
function die(): RandomInt {
  const faces = [1, 0, 1, 2, 0, 1, 1, 0, 0, 2, 1, 1, 0, 2, 2, 0, 1, 0, 0, 1];
  let index = 0;
  return (bound) => faces[index++ % faces.length]! % bound;
}

function mount(options: { reducedMotion?: boolean } = {}): void {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  const world = createEventBus<WorldEvents>();
  const shell = createEventBus<ShellEvents>();
  act(() => {
    root!.render(
      <PlazaProvider world={world} shell={shell} policy={null}>
        <ShellGamePanel onClose={() => {}} random={die()} reducedMotion={options.reducedMotion ?? false} />
      </PlazaProvider>,
    );
  });
}

function button(label: string): HTMLButtonElement {
  const found = [...container!.querySelectorAll('button')].find((candidate) => candidate.textContent === label);
  if (!found) throw new Error(`No button labelled ${label}`);
  return found;
}

const status = (): string => container!.querySelector('.shell-status')!.textContent ?? '';
const streak = (): string => container!.querySelector('[data-testid="shell-streak"]')!.textContent ?? '';
const table = (): HTMLElement => container!.querySelector('.shell-table') as HTMLElement;
const picks = (): HTMLButtonElement[] => [...container!.querySelectorAll<HTMLButtonElement>('.shell-pick')];
/** The slot the note sits in: the table knows, even while the cups hide it. */
const noteSlot = (): number => Number((container!.querySelector('.shell-note') as HTMLElement).style.getPropertyValue('--slot'));

function click(target: HTMLElement): void {
  act(() => {
    target.click();
  });
}

function wait(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** Each step books the next as it renders, so time passes one step at a time. */
function shuffle(swapMs: number): void {
  for (let step = 0; step < SHELL_SWAPS; step++) wait(swapMs);
}

describe("Where's the note? (D-076)", () => {
  it('shows the note, shuffles in sight, then lets the player pick; the right cup wins', () => {
    const results: unknown[] = [];
    attachDebugTap({ plazaShells: (result: unknown) => results.push(result) } as unknown as DebugTap);
    mount();
    expect(status()).toBe(COPY.plaza.shells.intro);
    expect(container!.textContent).toContain(COPY.plaza.shells.pool);
    expect(container!.textContent).toContain(COPY.plaza.shells.fun);
    expect(picks().every((pick) => pick.disabled)).toBe(true);

    click(button(COPY.plaza.shells.start));
    expect(status()).toBe(COPY.plaza.shells.watch);
    expect(container!.querySelector('.shell-note')!.getAttribute('data-shown')).toBe('true');
    expect(container!.querySelectorAll('.shell-cup[data-lifted="true"]')).toHaveLength(1);

    wait(SHELL_SHOW_MS);
    expect(status()).toBe(COPY.plaza.shells.shuffling);
    expect(container!.querySelector('.shell-note')!.getAttribute('data-shown')).toBe('false');
    expect(table().style.getPropertyValue('--shell-swap-ms')).toBe(`${shellSwapMs(0)}ms`);
    // Two cups move each step, one in front of the other.
    expect(container!.querySelectorAll('.shell-cup[data-moving="front"]')).toHaveLength(1);
    expect(container!.querySelectorAll('.shell-cup[data-moving="back"]')).toHaveLength(1);
    // No pick while the cups are moving.
    expect(picks().every((pick) => pick.disabled)).toBe(true);

    shuffle(shellSwapMs(0));
    expect(status()).toBe(COPY.plaza.shells.pick);
    expect(picks().every((pick) => !pick.disabled)).toBe(true);
    const right = noteSlot();
    click(button(`${COPY.plaza.shells.cup} ${right + 1}`));
    expect(status()).toBe(COPY.plaza.shells.win);
    expect(streak()).toBe('1');
    expect(results).toEqual(['win']);
  });

  it('quickens the next shuffle with the streak, and a wrong cup ends the streak', () => {
    const results: unknown[] = [];
    attachDebugTap({ plazaShells: (result: unknown) => results.push(result) } as unknown as DebugTap);
    mount();
    click(button(COPY.plaza.shells.start));
    wait(SHELL_SHOW_MS);
    shuffle(shellSwapMs(0));
    click(button(`${COPY.plaza.shells.cup} ${noteSlot() + 1}`));
    expect(streak()).toBe('1');

    click(button(COPY.plaza.shells.again));
    wait(SHELL_SHOW_MS);
    expect(table().style.getPropertyValue('--shell-swap-ms')).toBe(`${shellSwapMs(1)}ms`);
    expect(shellSwapMs(1)).toBeLessThan(shellSwapMs(0));
    shuffle(shellSwapMs(1));
    const right = noteSlot();
    const wrong = (right + 1) % 3;
    click(button(`${COPY.plaza.shells.cup} ${wrong + 1}`));
    expect(status()).toBe(`${COPY.plaza.shells.loseLead} ${right + 1}.`);
    expect(streak()).toBe('0');
    // Both cups lift: the empty one picked, and the one with the note.
    expect(container!.querySelectorAll('.shell-cup[data-lifted="true"]')).toHaveLength(2);
    expect(results).toEqual(['win', 'lose']);
  });

  it('fades instead of shuffling for a player who asked for less motion, with the same honest outcome', () => {
    mount({ reducedMotion: true });
    expect(table().getAttribute('data-motion')).toBe('reduced');
    click(button(COPY.plaza.shells.start));
    wait(SHELL_SHOW_MS / 2);
    expect(status()).toBe(COPY.plaza.shells.shuffling);
    expect(container!.querySelectorAll('.shell-cup[data-faded="true"]')).toHaveLength(3);
    expect(container!.querySelectorAll('.shell-cup[data-moving="front"]')).toHaveLength(0);
    wait(SHELL_FADE_MS);
    expect(container!.querySelectorAll('.shell-cup[data-faded="true"]')).toHaveLength(0);
    wait(SHELL_FADE_MS);
    expect(status()).toBe(COPY.plaza.shells.pick);
    click(button(`${COPY.plaza.shells.cup} ${noteSlot() + 1}`));
    expect(status()).toBe(COPY.plaza.shells.win);
  });

  it("keeps a keyboard player's focus in the game: on the cups to pick, then on Play again", () => {
    mount();
    click(button(COPY.plaza.shells.start));
    // The start button has gone, so focus fell to the page.
    expect(document.activeElement).toBe(document.body);
    wait(SHELL_SHOW_MS);
    shuffle(shellSwapMs(0));
    expect(document.activeElement).toBe(picks()[0]);
    click(button(`${COPY.plaza.shells.cup} ${noteSlot() + 1}`));
    expect(document.activeElement).toBe(button(COPY.plaza.shells.again));
    // Focus the player put somewhere else stays there.
    const elsewhere = document.createElement('input');
    document.body.append(elsewhere);
    click(button(COPY.plaza.shells.again));
    elsewhere.focus();
    wait(SHELL_SHOW_MS);
    shuffle(shellSwapMs(1));
    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it('leaves no timer running once the window closes', () => {
    mount();
    click(button(COPY.plaza.shells.start));
    act(() => root!.unmount());
    root = null;
    expect(vi.getTimerCount()).toBe(0);
  });
});
