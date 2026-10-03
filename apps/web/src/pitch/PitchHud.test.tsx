// @vitest-environment jsdom
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FOOTBALL_WIN_SCORE, PITCH_SLOTS, type GameId, type PitchMatchSnapshot, type PitchSlot } from '@strkworld/shared';
import { COPY } from '../copy.js';
import { PITCH_KICK_OFF_FLASH_MS, PitchHud, pitchTaken, pitchTeamName } from './PitchHud.js';
import type { PitchShellChannel } from './pitch-controller.js';

/**
 * D-135: the gated pitch's HUD. Every figure it shows is the server's, so the
 * tests drive it entirely by publishing matches down the channel.
 */

const slot = (kind: PitchSlot['kind'], gameId: GameId | null = null): PitchSlot =>
  Object.freeze({ kind, gameId: kind === 'player' ? gameId : null, x: 0, y: 0 });

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

/** A channel the test publishes down, as the controller would. */
function fakeChannel(initial: PitchMatchSnapshot | null = null) {
  const listeners = new Set<(value: PitchMatchSnapshot | null) => void>();
  let current = initial;
  const channel: PitchShellChannel = {
    match: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    gate: () => true,
    selfSlot: () => -1,
  };
  return {
    channel,
    publish(value: PitchMatchSnapshot | null) {
      current = value;
      act(() => {
        for (const listener of [...listeners]) listener(value);
      });
    },
  };
}

const previousActEnvironment = (globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
}).IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterAll(() => {
  if (previousActEnvironment === undefined) {
    delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  } else {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: previousActEnvironment });
  }
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function mount(node: React.ReactElement): HTMLDivElement {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return host;
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
});

const text = (node: HTMLElement, selector: string): string | null =>
  node.querySelector(selector)?.textContent ?? null;

describe('the pitch HUD (D-135)', () => {
  it('draws nothing with no channel, and nothing away from the pitch', () => {
    expect(mount(<PitchHud />).querySelector('.pitch-hud')).toBeNull();
    if (root) act(() => root!.unmount());
    host?.remove();
    const away = fakeChannel(null);
    expect(mount(<PitchHud pitch={away.channel} />).querySelector('.pitch-hud')).toBeNull();
  });

  it('draws nothing on an open, empty pitch: there is no match to report', () => {
    const lobby = fakeChannel(match());
    const node = mount(<PitchHud pitch={lobby.channel} reducedMotion={() => false} />);
    expect(node.querySelector('.pitch-hud')).toBeNull();
  });

  it('says what an open pitch is waiting for once someone is inside', () => {
    const lobby = fakeChannel(match({ slots: Object.freeze([slot('player', 'a'.repeat(16) as GameId), slot('empty'), slot('empty'), slot('empty')]) }));
    const node = mount(<PitchHud pitch={lobby.channel} reducedMotion={() => false} />);
    expect(text(node, '.pitch-hud-title')).toBe(COPY.pitch.waiting);
    expect(text(node, '[data-testid="pitch-filled"]')).toBe(`1 ${COPY.pitch.filled}`);
    expect(node.querySelector('.pitch-hud')?.getAttribute('data-phase')).toBe('open');
  });

  it('shows the scoreboard as STARKS against SNARKS, with the goal that wins it', () => {
    const lobby = fakeChannel(match({ phase: 'playing', starks: 2, snarks: 1 }));
    const node = mount(<PitchHud pitch={lobby.channel} reducedMotion={() => false} />);
    expect(text(node, '[data-side="starks"]')).toBe('STARKS');
    expect(text(node, '[data-side="snarks"]')).toBe('SNARKS');
    expect(text(node, '[data-testid="pitch-score"]')).toBe('2 – 1');
    expect(text(node, '.pitch-hud-target')).toBe(`${COPY.pitch.target} ${FOOTBALL_WIN_SCORE}`);
    // No countdown and no banner while the ball is in play.
    expect(node.querySelector('.pitch-hud-countdown')).toBeNull();
    expect(node.querySelector('.pitch-hud-banner')).toBeNull();
  });

  it('counts the countdown down from the server\'s own seconds', () => {
    const lobby = fakeChannel(match({ phase: 'countdown', secondsLeft: 3 }));
    const node = mount(<PitchHud pitch={lobby.channel} reducedMotion={() => false} />);
    expect(text(node, '.pitch-hud-countdown')).toBe('3');
    expect(text(node, '.pitch-hud-live')).toBe(`${COPY.pitch.countdownLive} 3`);
    lobby.publish(match({ phase: 'countdown', secondsLeft: 2 }));
    expect(text(node, '.pitch-hud-countdown')).toBe('2');
    lobby.publish(match({ phase: 'countdown', secondsLeft: 1 }));
    expect(text(node, '.pitch-hud-countdown')).toBe('1');
  });

  it('flashes KICK OFF! when a countdown gives way to play, once, and again next kick-off', () => {
    vi.useFakeTimers();
    try {
      const lobby = fakeChannel(match({ phase: 'countdown', secondsLeft: 1 }));
      const node = mount(<PitchHud pitch={lobby.channel} reducedMotion={() => false} />);
      lobby.publish(match({ phase: 'playing' }));
      expect(text(node, '.pitch-hud-kickoff')).toBe(COPY.pitch.kickOff);
      expect(text(node, '.pitch-hud-live')).toBe(COPY.pitch.kickOff);
      // It has its moment and goes.
      act(() => void vi.advanceTimersByTime(PITCH_KICK_OFF_FLASH_MS + 10));
      expect(node.querySelector('.pitch-hud-kickoff')).toBeNull();
      // A goal is not a kick-off, so nothing flashes for it.
      lobby.publish(match({ phase: 'playing', starks: 1 }));
      expect(node.querySelector('.pitch-hud-kickoff')).toBeNull();
      // The restart's own countdown, and the kick-off after it, flashes again.
      lobby.publish(match({ phase: 'countdown', starks: 1, secondsLeft: 1 }));
      lobby.publish(match({ phase: 'playing', starks: 1 }));
      expect(text(node, '.pitch-hud-kickoff')).toBe(COPY.pitch.kickOff);
    } finally {
      vi.useRealTimers();
    }
  });

  it('puts up a winner\'s banner at full time, with the final score', () => {
    const lobby = fakeChannel(match({ phase: 'playing', starks: 2, snarks: 3 }));
    const node = mount(<PitchHud pitch={lobby.channel} reducedMotion={() => false} />);
    lobby.publish(match({ phase: 'ended', winner: 'snarks', starks: 2, snarks: FOOTBALL_WIN_SCORE }));
    expect(text(node, '.pitch-hud-banner-title')).toBe(`SNARKS ${COPY.pitch.win}`);
    expect(text(node, '.pitch-hud-banner-detail')).toBe(`2 – ${FOOTBALL_WIN_SCORE}`);
    expect(node.querySelector('.pitch-hud-banner')?.getAttribute('data-side')).toBe('snarks');
    expect(text(node, '.pitch-hud-live')).toBe(`SNARKS ${COPY.pitch.win}. 2 – ${FOOTBALL_WIN_SCORE}`);
  });

  it('tells the reduced-motion preference to the markup, so the pulse can be dropped', () => {
    const lobby = fakeChannel(match({ phase: 'countdown', secondsLeft: 3 }));
    const node = mount(<PitchHud pitch={lobby.channel} reducedMotion={() => true} />);
    expect(node.querySelector('.pitch-hud')?.getAttribute('data-motion')).toBe('reduced');
  });

  it('is a labelled region, and its live text is the only thing read out', () => {
    const lobby = fakeChannel(match({ phase: 'playing', starks: 1 }));
    const node = mount(<PitchHud pitch={lobby.channel} reducedMotion={() => false} />);
    const region = node.querySelector('.pitch-hud')!;
    expect(region.getAttribute('role')).toBe('region');
    expect(region.getAttribute('aria-label')).toBe(COPY.pitch.label);
    expect(node.querySelector('.pitch-hud-live')?.getAttribute('aria-live')).toBe('polite');
    // The scoreboard, the countdown and the banner are all decorative beside it.
    expect(node.querySelector('.pitch-hud-bar')?.getAttribute('aria-hidden')).toBeNull();
    lobby.publish(match({ phase: 'countdown', secondsLeft: 2 }));
    expect(node.querySelector('.pitch-hud-countdown')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('stops drawing when the match goes away mid-game: the player walked off the street', () => {
    const lobby = fakeChannel(match({ phase: 'playing', starks: 1 }));
    const node = mount(<PitchHud pitch={lobby.channel} reducedMotion={() => false} />);
    expect(node.querySelector('.pitch-hud')).not.toBeNull();
    lobby.publish(null);
    expect(node.querySelector('.pitch-hud')).toBeNull();
  });
});

describe('the HUD\'s own helpers (D-135)', () => {
  it('names each team the way every scoreboard and banner does', () => {
    expect(pitchTeamName('starks')).toBe('STARKS');
    expect(pitchTeamName('snarks')).toBe('SNARKS');
  });

  it('counts players and dummies alike as places taken', () => {
    expect(pitchTaken(match())).toBe(0);
    expect(pitchTaken(match({ slots: Object.freeze([slot('player', 'a'.repeat(16) as GameId), slot('dummy'), slot('empty'), slot('empty')]) }))).toBe(2);
    expect(pitchTaken(match({ slots: Object.freeze(Array.from({ length: PITCH_SLOTS }, () => slot('dummy'))) }))).toBe(PITCH_SLOTS);
  });
});
