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

function ring(over: { phase?: ArenaPhase; round?: number; challenger?: GameId; hp?: number; seconds?: number; reason?: 'knockout' | 'timeout' | 'left' | 'disconnect' } = {}): ArenaRingSnapshot {
  const phase = over.phase ?? 'fighting';
  const busy = phase !== 'idle';
  const hp = over.hp ?? ARENA_MAX_HP;
  const reason = over.reason ?? (hp === 0 ? 'knockout' : 'timeout');
  return {
    phase,
    round: over.round ?? 1,
    challenger: busy ? { kind: 'player', gameId: over.challenger ?? SELF, hp: ARENA_MAX_HP, swings: 0, hits: 0 } : { kind: 'empty', gameId: null, hp: 0, swings: 0, hits: 0 },
    opponent: busy ? { kind: 'dummy', gameId: null, hp, swings: 0, hits: (ARENA_MAX_HP - hp) / 10 } : { kind: 'empty', gameId: null, hp: 0, swings: 0, hits: 0 },
    secondsLeft: over.seconds ?? (phase === 'countdown' ? 3 : phase === 'fighting' ? 90 : 0),
    outcome: phase === 'ended' ? { reason, winner: reason === 'knockout' ? 'challenger' : null } : null,
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
