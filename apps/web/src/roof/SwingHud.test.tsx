// @vitest-environment jsdom
/**
 * D-133: the lookout swing's one HUD hint. The World draws the ride; the
 * Shell adds only the way out. So what is pinned here is who sees the hint
 * (the rider, and nobody else) and that Esc and the button take the same
 * path — plus that the hint is game copy, with no money or name in it.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GameId, RoofSwingSnapshot } from '@strkworld/shared';
import { COPY } from '../copy.js';
import { SwingHud } from './SwingHud.js';
import type { SwingShellChannel } from './swing-controller.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SELF = 'g-self' as GameId;
const OTHER = 'g-other' as GameId;

const idle = (): RoofSwingSnapshot =>
  Object.freeze({ phase: 'idle', round: 1, riderId: null, secondsLeft: 0, reason: null });
const riding = (riderId: GameId): RoofSwingSnapshot =>
  Object.freeze({ phase: 'riding', round: 2, riderId, secondsLeft: 12, reason: null });
const cooling = (): RoofSwingSnapshot =>
  Object.freeze({ phase: 'cooldown', round: 2, riderId: null, secondsLeft: 0, reason: 'timeout' });

function fakeChannel(initial: RoofSwingSnapshot | null, self: GameId | null = SELF) {
  let current = initial;
  const listeners = new Set<() => void>();
  const presses: number[] = [];
  const channel = {
    swing: () => current,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    selfId: () => self,
    claim: () => {},
    leave: () => {},
    press: () => void presses.push(1),
    onRoof: () => true,
  } as unknown as SwingShellChannel;
  return {
    channel,
    presses,
    set(next: RoofSwingSnapshot | null) {
      current = next;
      for (const listener of listeners) listener();
    },
  };
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render(node: React.ReactNode): void {
  act(() => root.render(node));
}

const hint = () => host.querySelector('.swing-hud-hint');

function press(key: string, target?: EventTarget): void {
  act(() => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true });
    (target ?? document).dispatchEvent(event);
  });
}

describe('the lookout swing\'s HUD hint (D-133)', () => {
  it('shows "Esc to get off" to the rider', () => {
    const fake = fakeChannel(riding(SELF));
    render(<SwingHud swing={fake.channel} />);
    expect(hint()?.textContent).toBe(COPY.swing.getOff);
    expect(COPY.swing.getOff).toBe('Esc to get off');
  });

  it('shows nothing to a spectator watching somebody else ride', () => {
    const fake = fakeChannel(riding(OTHER));
    render(<SwingHud swing={fake.channel} />);
    expect(hint()).toBeNull();
  });

  it('shows nothing while the swing is idle or cooling down', () => {
    for (const state of [idle(), cooling(), null]) {
      const fake = fakeChannel(state);
      render(<SwingHud swing={fake.channel} />);
      expect(hint()).toBeNull();
    }
  });

  it('shows nothing when there is no swing channel at all (off the roof)', () => {
    render(<SwingHud />);
    expect(hint()).toBeNull();
  });

  it('shows nothing when this client\'s own id is unknown', () => {
    const fake = fakeChannel(riding(SELF), null);
    render(<SwingHud swing={fake.channel} />);
    expect(hint()).toBeNull();
  });

  it('appears when the ride starts and goes when it ends', () => {
    const fake = fakeChannel(idle());
    render(<SwingHud swing={fake.channel} />);
    expect(hint()).toBeNull();
    act(() => fake.set(riding(SELF)));
    expect(hint()).not.toBeNull();
    act(() => fake.set(cooling()));
    expect(hint()).toBeNull();
  });

  it('gets the rider off on Esc', () => {
    const fake = fakeChannel(riding(SELF));
    render(<SwingHud swing={fake.channel} />);
    press('Escape');
    expect(fake.presses).toHaveLength(1);
  });

  it('gets the rider off on the button, for a touch screen', () => {
    const fake = fakeChannel(riding(SELF));
    render(<SwingHud swing={fake.channel} />);
    act(() => {
      (hint() as HTMLButtonElement).click();
    });
    expect(fake.presses).toHaveLength(1);
  });

  it('ignores every key but Esc', () => {
    const fake = fakeChannel(riding(SELF));
    render(<SwingHud swing={fake.channel} />);
    for (const key of ['e', 'Enter', ' ', 'w']) press(key);
    expect(fake.presses).toEqual([]);
  });

  it('leaves Esc alone when a text field has the key', () => {
    const fake = fakeChannel(riding(SELF));
    render(<SwingHud swing={fake.channel} />);
    const input = document.createElement('input');
    document.body.append(input);
    press('Escape', input);
    expect(fake.presses).toEqual([]);
    input.remove();
  });

  it('listens for Esc only while this client is the rider', () => {
    const fake = fakeChannel(riding(OTHER));
    render(<SwingHud swing={fake.channel} />);
    press('Escape');
    expect(fake.presses).toEqual([]);
    // Once they are the rider, the key works.
    act(() => fake.set(riding(SELF)));
    press('Escape');
    expect(fake.presses).toHaveLength(1);
    // And the listener goes with the ride.
    act(() => fake.set(cooling()));
    press('Escape');
    expect(fake.presses).toHaveLength(1);
  });

  it('marks the hint reduced when the motion setting asks for it', () => {
    const fake = fakeChannel(riding(SELF));
    render(<SwingHud swing={fake.channel} reducedMotion={() => true} />);
    expect(host.querySelector('.swing-hud')?.getAttribute('data-motion')).toBe('reduced');
    render(<SwingHud swing={fake.channel} reducedMotion={() => false} />);
    expect(host.querySelector('.swing-hud')?.getAttribute('data-motion')).toBe('full');
  });

  it('names the region for a screen reader', () => {
    const fake = fakeChannel(riding(SELF));
    render(<SwingHud swing={fake.channel} />);
    const region = host.querySelector('.swing-hud');
    expect(region?.getAttribute('role')).toBe('region');
    expect(region?.getAttribute('aria-label')).toBe(COPY.swing.label);
  });

  it('is game copy: no money, address or name anywhere in it', () => {
    const words = `${COPY.swing.label} ${COPY.swing.getOff}`.toLowerCase();
    for (const forbidden of ['0x', 'balance', 'wallet', 'strk', 'address', 'fee', '$']) {
      expect(words).not.toContain(forbidden);
    }
  });
});

describe('the hint tells the rider they can look around (D-133, 2026-10-03)', () => {
  it('reads "◀ ▶ look around · Esc to get off", in that order', () => {
    const fake = fakeChannel(riding(SELF));
    render(<SwingHud swing={fake.channel} />);
    const region = host.querySelector('.swing-hud')!;
    expect(region.textContent).toBe(`${COPY.swing.look}${COPY.swing.getOff}`);
    expect(COPY.swing.hint).toBe('◀ ▶ look around · Esc to get off');
    expect(COPY.swing.hint.startsWith(COPY.swing.look)).toBe(true);
    expect(COPY.swing.hint.endsWith(COPY.swing.getOff)).toBe(true);
    // The look half is not a button: the keys and the drag do the looking.
    expect(host.querySelector('.swing-hud-look')?.tagName).toBe('SPAN');
    expect(host.querySelectorAll('button')).toHaveLength(1);
  });

  it('still shows nobody else the hint, look and all', () => {
    const fake = fakeChannel(riding(OTHER));
    render(<SwingHud swing={fake.channel} />);
    expect(host.querySelector('.swing-hud-look')).toBeNull();
  });
});
