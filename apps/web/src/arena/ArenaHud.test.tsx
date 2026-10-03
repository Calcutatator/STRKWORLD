// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ARENA_MAX_HP, type ArenaPhase, type ArenaRingSnapshot, type GameId } from '@strkworld/shared';
import { COPY } from '../copy.js';
import { ARENA_FIGHT_FLASH_MS, ArenaHud, formatClock, keyBelongsElsewhere } from './ArenaHud.js';
import type { ArenaShellChannel } from './arena-controller.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SELF = 'g-self' as GameId;
const OTHER = 'g-other' as GameId;

const EMPTY_SLOT = { kind: 'empty', gameId: null, hp: 0, swings: 0, hits: 0, guarding: false, blocks: 0 } as const;

function ring(
  over: {
    phase?: ArenaPhase;
    round?: number;
    challenger?: GameId;
    hp?: number;
    seconds?: number;
    reason?: 'knockout' | 'timeout' | 'left' | 'disconnect';
    guarding?: boolean;
    champion?: GameId | null;
    seated?: boolean;
  } = {},
): ArenaRingSnapshot {
  const phase = over.phase ?? 'fighting';
  const busy = phase !== 'idle';
  const hp = over.hp ?? ARENA_MAX_HP;
  const reason = over.reason ?? (hp === 0 ? 'knockout' : 'timeout');
  const champion = over.champion ?? null;
  return {
    phase,
    round: over.round ?? 1,
    challenger: busy
      ? { kind: 'player', gameId: over.challenger ?? SELF, hp: ARENA_MAX_HP, swings: 0, hits: 0, guarding: over.guarding === true, blocks: 0 }
      : EMPTY_SLOT,
    opponent: busy
      ? { kind: 'dummy', gameId: null, hp, swings: 0, hits: (ARENA_MAX_HP - hp) / 10, guarding: false, blocks: 0 }
      : EMPTY_SLOT,
    secondsLeft: over.seconds ?? (phase === 'countdown' ? 3 : phase === 'fighting' ? 90 : 0),
    outcome: phase === 'ended' ? { reason, winner: reason === 'knockout' ? 'challenger' : null } : null,
    champion,
    seated: champion !== null && over.seated === true,
  };
}

function fakeChannel(initial: ArenaRingSnapshot | null, self: GameId | null = SELF) {
  let current = initial;
  const listeners = new Set<(ring: ArenaRingSnapshot | null) => void>();
  const channel = {
    ring: () => current,
    subscribe(listener: (ring: ArenaRingSnapshot | null) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    selfId: () => self,
    claim: vi.fn(),
    attack: vi.fn(),
    leave: vi.fn(),
    strike: vi.fn(),
    // D-128.
    block: vi.fn(),
    sit: vi.fn(),
    guard: vi.fn(),
    inArena: () => true,
  } satisfies ArenaShellChannel;
  return {
    channel,
    push(next: ArenaRingSnapshot | null) {
      current = next;
      for (const listener of [...listeners]) listener(next);
    },
  };
}

let container: HTMLDivElement;
let root: Root;
let time = 0;
const now = () => time;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  time = 10_000;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = '';
  vi.useRealTimers();
});

function render(channel: ArenaShellChannel, props: { coarse?: boolean; reduced?: boolean } = {}) {
  act(() => {
    root.render(
      <ArenaHud
        arena={channel}
        coarsePointer={() => props.coarse === true}
        reducedMotion={() => props.reduced === true}
        now={now}
        keyTarget={document}
      />,
    );
  });
}

const text = () => container.textContent ?? '';
const live = () => container.querySelector('[aria-live="polite"]')?.textContent ?? '';
const button = (label: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent === label) ?? null;

describe('ArenaHud', () => {
  it('renders nothing outside the arena or while the ring is idle', () => {
    const fake = fakeChannel(null);
    render(fake.channel);
    expect(container.innerHTML).toBe('');
    act(() => fake.push(ring({ phase: 'idle' })));
    expect(container.innerHTML).toBe('');
  });

  it('shows the fighter the dummy’s HP from server state, and the fight timer', () => {
    const fake = fakeChannel(ring({ hp: 70, seconds: 42 }));
    render(fake.channel);
    expect(text()).toContain(COPY.arena.dummy);
    expect(container.querySelector('[data-testid="arena-hp"]')?.textContent).toBe('70/100');
    expect(container.querySelector('[role="meter"]')?.getAttribute('aria-valuenow')).toBe('70');
    expect(container.querySelector('.arena-hud-timer')?.textContent).toBe('0:42');
    act(() => fake.push(ring({ hp: 60, seconds: 41 })));
    expect(container.querySelector('[data-testid="arena-hp"]')?.textContent).toBe('60/100');
  });

  it('shows spectators a slim bar: TRAINING BOUT · 0:42 and the HP', () => {
    const fake = fakeChannel(ring({ challenger: OTHER, hp: 50, seconds: 42 }));
    render(fake.channel);
    expect(container.querySelector('.arena-hud')?.getAttribute('data-role')).toBe('spectator');
    expect(text()).toContain(`${COPY.arena.bout} · 0:42`);
    expect(container.querySelector('[data-testid="arena-hp"]')?.textContent).toBe('50/100');
    expect(button(COPY.arena.leave)).toBeNull();
    expect(button(COPY.arena.strike)).toBeNull();
  });

  it('counts down 3 · 2 · 1 to the live region, then FIGHT!', () => {
    vi.useFakeTimers();
    const fake = fakeChannel(ring({ phase: 'countdown', seconds: 3 }));
    render(fake.channel);
    expect(container.querySelector('.arena-hud-countdown')?.textContent).toBe('3');
    expect(live()).toBe(`${COPY.arena.countdownLive} 3`);
    act(() => fake.push(ring({ phase: 'countdown', seconds: 2 })));
    expect(container.querySelector('.arena-hud-countdown')?.textContent).toBe('2');
    act(() => fake.push(ring({ phase: 'fighting', seconds: 90 })));
    expect(container.querySelector('.arena-hud-fight')?.textContent).toBe(COPY.arena.fight);
    expect(live()).toBe(COPY.arena.fight);
    act(() => {
      vi.advanceTimersByTime(ARENA_FIGHT_FLASH_MS);
    });
    expect(container.querySelector('.arena-hud-fight')).toBeNull();
  });

  it('a knockout shows VICTORY with the client-timed seconds', () => {
    const fake = fakeChannel(ring({ phase: 'countdown', seconds: 1 }));
    render(fake.channel);
    act(() => fake.push(ring({ phase: 'fighting' })));
    time += 12_400;
    act(() => fake.push(ring({ phase: 'ended', hp: 0, reason: 'knockout' })));
    expect(container.querySelector('.arena-hud-banner-title')?.textContent).toBe(COPY.arena.victory);
    expect(text()).toContain(`${COPY.arena.victoryDetail} 12.4 ${COPY.arena.seconds}`);
    expect(live()).toContain(COPY.arena.victory);
  });

  it('a timeout shows TIME to the fighter; spectators read what happened', () => {
    const fighter = fakeChannel(ring({ phase: 'ended', hp: 40, reason: 'timeout' }));
    render(fighter.channel);
    expect(container.querySelector('.arena-hud-banner-title')?.textContent).toBe(COPY.arena.time);
    expect(text()).toContain(COPY.arena.timeDetail);
    act(() => fighter.push(ring({ phase: 'ended', hp: 40, reason: 'timeout', challenger: OTHER })));
    expect(container.querySelector('.arena-hud-banner-title')?.textContent).toBe(COPY.arena.spectatorTimeout);
    act(() => fighter.push(ring({ phase: 'ended', hp: 0, reason: 'knockout', challenger: OTHER })));
    expect(container.querySelector('.arena-hud-banner-title')?.textContent).toBe(COPY.arena.spectatorWon);
    act(() => fighter.push(ring({ phase: 'ended', hp: 70, reason: 'left', challenger: OTHER })));
    expect(container.querySelector('.arena-hud-banner-title')?.textContent).toBe(COPY.arena.spectatorLeft);
    // The fighter who walked out gets no banner.
    act(() => fighter.push(ring({ phase: 'ended', hp: 70, reason: 'left' })));
    expect(container.querySelector('.arena-hud-banner')).toBeNull();
  });

  it('shows STRIKE only on a coarse pointer, only while fighting; it routes through the channel', () => {
    const fake = fakeChannel(ring());
    render(fake.channel, { coarse: false });
    expect(button(COPY.arena.strike)).toBeNull();
    render(fake.channel, { coarse: true });
    const strike = button(COPY.arena.strike);
    expect(strike).not.toBeNull();
    act(() => strike!.click());
    expect(fake.channel.strike).toHaveBeenCalledTimes(1);
    expect(fake.channel.attack).not.toHaveBeenCalled();
    act(() => fake.push(ring({ phase: 'countdown' })));
    expect(button(COPY.arena.strike)).toBeNull();
  });

  it('LEAVE RING and Esc leave the ring during the countdown and the fight', () => {
    const fake = fakeChannel(ring({ phase: 'countdown' }));
    render(fake.channel);
    act(() => button(COPY.arena.leave)!.click());
    expect(fake.channel.leave).toHaveBeenCalledTimes(1);
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(fake.channel.leave).toHaveBeenCalledTimes(2);
    act(() => fake.push(ring({ phase: 'ended', hp: 0 })));
    expect(button(COPY.arena.leave)).toBeNull();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(fake.channel.leave).toHaveBeenCalledTimes(2);
  });

  it('Esc does nothing while a text field or a panel has the keyboard', () => {
    const fake = fakeChannel(ring());
    render(fake.channel);
    const input = document.createElement('input');
    document.body.appendChild(input);
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(fake.channel.leave).not.toHaveBeenCalled();
    input.remove();
    const panel = document.createElement('section');
    panel.className = 'panel';
    document.body.appendChild(panel);
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(fake.channel.leave).not.toHaveBeenCalled();
    panel.remove();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(fake.channel.leave).toHaveBeenCalledTimes(1);
  });

  it('marks reduced motion so the countdown loses its pulse and the banner fades', () => {
    const fake = fakeChannel(ring({ phase: 'countdown' }));
    render(fake.channel, { reduced: true });
    expect(container.querySelector('.arena-hud')?.getAttribute('data-motion')).toBe('reduced');
    render(fake.channel, { reduced: false });
    expect(container.querySelector('.arena-hud')?.getAttribute('data-motion')).toBe('full');
  });

  it('formats the clock and tells a text field from the World', () => {
    expect(formatClock(90)).toBe('1:30');
    expect(formatClock(42)).toBe('0:42');
    expect(formatClock(-3)).toBe('0:00');
    const input = document.createElement('textarea');
    expect(keyBelongsElsewhere(input, null)).toBe(true);
    expect(keyBelongsElsewhere(document.body, null)).toBe(false);
  });
});

describe('ArenaHud: the block (D-128)', () => {
  const hints = () => container.querySelector('[data-testid="arena-hints"]');
  const blockButton = () => button(COPY.arena.block);

  it('shows the fighter “E STRIKE” and “Q BLOCK” on a keyboard, while the fight runs', () => {
    const fake = fakeChannel(ring());
    render(fake.channel, { coarse: false });
    expect(hints()?.textContent).toBe(`E${COPY.arena.strike}Q${COPY.arena.block}`);
    // The keys are chips, in the brand's own style.
    expect([...hints()!.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['E', 'Q']);
    // Not during the countdown, when neither key does anything.
    act(() => fake.push(ring({ phase: 'countdown' })));
    expect(hints()).toBeNull();
  });

  it('hides the key hints from spectators and from a touch screen', () => {
    const watcher = fakeChannel(ring({ challenger: OTHER }));
    render(watcher.channel, { coarse: false });
    expect(hints()).toBeNull();

    const fake = fakeChannel(ring());
    render(fake.channel, { coarse: true });
    expect(hints()).toBeNull();
  });

  it('shows BLOCK beside STRIKE on a touch screen only, while fighting', () => {
    const fake = fakeChannel(ring());
    render(fake.channel, { coarse: false });
    expect(blockButton()).toBeNull();
    render(fake.channel, { coarse: true });
    expect(blockButton()).not.toBeNull();
    // Beside STRIKE, and before it: the guard sits under the left thumb.
    const labels = [...container.querySelectorAll('.arena-hud-actions button')].map((b) => b.textContent);
    expect(labels).toEqual([COPY.arena.block, COPY.arena.strike, COPY.arena.leave]);
    act(() => fake.push(ring({ phase: 'countdown' })));
    expect(blockButton()).toBeNull();
  });

  it('holds the guard for as long as the BLOCK button is held, and lets it go on every release', () => {
    const fake = fakeChannel(ring());
    render(fake.channel, { coarse: true });
    const press = (type: string) =>
      act(() => {
        blockButton()!.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true }));
      });
    press('pointerdown');
    expect(fake.channel.guard).toHaveBeenLastCalledWith(true);
    press('pointerup');
    expect(fake.channel.guard).toHaveBeenLastCalledWith(false);
    // A cancelled gesture lowers it too. (The button also releases on
    // pointerleave and on a lost capture — a finger sliding off — which React
    // delivers through its enter/leave pairing, not a plain dispatch here.)
    press('pointerdown');
    press('pointercancel');
    expect(fake.channel.guard).toHaveBeenLastCalledWith(false);
    expect(fake.channel.guard.mock.calls).toEqual([[true], [false], [true], [false]]);
  });

  it('lights the hint and the button from the server’s guard, never from the press', () => {
    const fake = fakeChannel(ring());
    render(fake.channel, { coarse: false });
    const hint = () => hints()!.querySelector('[data-state]') as HTMLElement | null;
    expect(hints()!.querySelectorAll('[data-state="idle"]').length).toBe(1);
    act(() => fake.push(ring({ guarding: true })));
    expect(hint()?.dataset['state']).toBe('held');

    render(fake.channel, { coarse: true });
    expect(blockButton()?.dataset['state']).toBe('held');
    expect(blockButton()?.getAttribute('aria-pressed')).toBe('true');
    act(() => fake.push(ring({ guarding: false })));
    expect(blockButton()?.getAttribute('aria-pressed')).toBe('false');
  });
});
