// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { EventBus, ShellEvents, WorldEvents } from '@strkworld/shared';
import { createTouchInteractButton, isTouchScreen } from './touch-interact.js';
import { createWorldSession, type WorldKeyboard, type WorldSessionView } from './world-session.js';
import { BANK_ROOM_DEFINITION, FIXED_ROOM_TILE_SIZE } from './fixed-room.js';
import { createStreetMap, tileToWorld } from './map/street.js';
import { ROOM_ORIGIN } from './world-layout.js';

/**
 * D-117: on a touch screen the "E · …" prompt is a button, and a tap does
 * what E does.
 */

function mount(): HTMLElement {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return element;
}

function media(matches: Record<string, boolean>, maxTouchPoints = 0) {
  return {
    matchMedia: (query: string) => ({ matches: matches[query] === true }) as MediaQueryList,
    navigator: { maxTouchPoints },
  };
}

describe('the touch interact button (D-117)', () => {
  it('reads a touch screen from a coarse pointer, or touch points without a fine one', () => {
    expect(isTouchScreen(media({ '(pointer: coarse)': true }))).toBe(true);
    expect(isTouchScreen(media({}, 5))).toBe(true);
    expect(isTouchScreen(media({ '(any-pointer: fine)': true }, 5))).toBe(false);
    expect(isTouchScreen(media({}))).toBe(false);
    expect(isTouchScreen({ matchMedia: () => { throw new Error('no media'); } } as never)).toBe(false);
  });

  it('shows the prompt\'s words while a station is focused, and a tap presses E', () => {
    const parent = mount();
    const onPress = vi.fn();
    const button = createTouchInteractButton({ mount: parent, onPress });
    expect(button.element.parentNode).toBe(parent);
    expect(button.element.hidden).toBe(true);
    // A tap on a hidden button does nothing.
    button.element.click();
    expect(onPress).not.toHaveBeenCalled();

    button.show({ id: 'bank:shielding', label: 'SHIELD', x: 0, y: 0 });
    expect(button.element.hidden).toBe(false);
    expect(button.element.textContent).toBe('ESHIELD');
    expect(button.element.getAttribute('aria-label')).toBe('SHIELD (E)');
    button.element.focus();
    button.element.click();
    expect(onPress).toHaveBeenCalledOnce();
    // The keyboard goes straight back to the World.
    expect(document.activeElement).not.toBe(button.element);

    button.show(null);
    expect(button.element.hidden).toBe(true);
    button.destroy();
    expect(button.element.parentNode).toBeNull();
  });

  it('opens a counter from a tap, through the session, exactly as E would', () => {
    const parent = mount();
    const emitted: Array<{ event: keyof WorldEvents; payload: unknown }> = [];
    const shell = new Map<string, Set<(payload: unknown) => void>>();
    const config = {
      out: { emit: (event: keyof WorldEvents, payload: unknown) => void emitted.push({ event, payload }) } as Pick<EventBus<WorldEvents>, 'emit'>,
      in: {
        on: (event: string, listener: (payload: unknown) => void) => {
          const set = shell.get(event) ?? new Set();
          set.add(listener);
          shell.set(event, set);
          return () => set.delete(listener);
        },
      } as unknown as Pick<EventBus<ShellEvents>, 'on'>,
    };
    const shellEmit = (event: string, payload: unknown): void => {
      for (const listener of shell.get(event) ?? []) listener(payload);
    };
    let session!: ReturnType<typeof createWorldSession>;
    const button = createTouchInteractButton({ mount: parent, onPress: () => session.interact() });
    const view = new Proxy({} as WorldSessionView, {
      get: (_target, key) => (key === 'setInteractionPrompt' ? (prompt: never) => button.show(prompt) : () => {}),
    });
    const keyboard: WorldKeyboard = {
      enabled: true,
      held: { left: false, right: false, up: false, down: false },
      sprinting: false,
      on: () => keyboard,
      off: () => keyboard,
      resetKeys: () => {},
      disableGlobalCapture: () => {},
      enableGlobalCapture: () => {},
    } as unknown as WorldKeyboard;
    session = createWorldSession({ config, view, keyboard });
    const street = createStreetMap();
    const door = street.doors.find((candidate) => candidate.building === 'bank')!;
    const internals = session as unknown as { position: { x: number; y: number } };
    internals.position = tileToWorld(door.x, door.y);
    session.update(16);
    expect(session.area).toBe('bank');
    shellEmit('world:stations', {
      building: 'bank',
      stations: [{ station: 'bank:shielding', label: 'SHIELD', status: 'available' }],
    });
    const shield = BANK_ROOM_DEFINITION.stations[0]!;
    internals.position = {
      x: ROOM_ORIGIN.x + shield.x * FIXED_ROOM_TILE_SIZE + FIXED_ROOM_TILE_SIZE / 2,
      y: ROOM_ORIGIN.y + (shield.y + 1) * FIXED_ROOM_TILE_SIZE + FIXED_ROOM_TILE_SIZE / 2,
    };
    session.update(16);
    expect(emitted.filter(({ event }) => event === 'station:activated')).toEqual([]);
    expect(button.element.hidden).toBe(false);
    expect(button.element.textContent).toBe('ESHIELD');

    button.element.click();
    expect(emitted.filter(({ event }) => event === 'station:activated').map(({ payload }) => payload)).toEqual([
      { building: 'bank', station: 'bank:shielding' },
    ]);
    session.destroy();
    button.destroy();
  });
});
