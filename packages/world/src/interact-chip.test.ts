// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import type { EventBus, ShellEvents, WorldEvents } from '@strkworld/shared';
import { INTERACT_CHIP_FADE_MS, createInteractChip, isTouchScreen } from './interact-chip.js';
import { createWorldSession, type WorldKeyboard, type WorldSessionView } from './world-session.js';
import { BANK_ROOM_DEFINITION, FIXED_ROOM_TILE_SIZE } from './fixed-room.js';
import { createStreetMap, tileToWorld } from './map/street.js';
import { ROOM_ORIGIN } from './world-layout.js';

/**
 * D-123: the key chip. It names what E would use ("[E] SHIELD") while the
 * session focuses a station, steps aside whenever E would do nothing, and on
 * a touch screen it is the tap button that does what E does.
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

const SHIELD = { id: 'bank:shielding', label: 'SHIELD', x: 0, y: 0 } as const;

/** A session in the Bank with its chip, as the engine wires them: the chip shows the session's prompt. */
function bankSession(touch: boolean, status: 'available' | 'locked' = 'available') {
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
  const chip = createInteractChip({ mount: parent, touch, onPress: () => session.interact() });
  const view = new Proxy({} as WorldSessionView, {
    get: (_target, key) => (key === 'setInteractionPrompt' ? (prompt: never) => chip.show(prompt) : () => {}),
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
    stations: [{ station: 'bank:shielding', label: 'SHIELD', status }],
  });
  const shield = BANK_ROOM_DEFINITION.stations[0]!;
  internals.position = {
    x: ROOM_ORIGIN.x + shield.x * FIXED_ROOM_TILE_SIZE + FIXED_ROOM_TILE_SIZE / 2,
    y: ROOM_ORIGIN.y + (shield.y + 1) * FIXED_ROOM_TILE_SIZE + FIXED_ROOM_TILE_SIZE / 2,
  };
  session.update(16);
  const activated = () => emitted.filter(({ event }) => event === 'station:activated').map(({ payload }) => payload);
  return {
    session,
    chip,
    shellEmit,
    activated,
    finish() {
      session.destroy();
      chip.destroy();
    },
  };
}

describe('the key chip (D-123)', () => {
  it('reads a touch screen from a coarse pointer, or touch points without a fine one', () => {
    expect(isTouchScreen(media({ '(pointer: coarse)': true }))).toBe(true);
    expect(isTouchScreen(media({}, 5))).toBe(true);
    expect(isTouchScreen(media({ '(any-pointer: fine)': true }, 5))).toBe(false);
    expect(isTouchScreen(media({}))).toBe(false);
    expect(isTouchScreen({ matchMedia: () => { throw new Error('no media'); } } as never)).toBe(false);
  });

  it('reads "[E] label" in the brand system, low and centred, and fades in and out', () => {
    const parent = mount();
    const chip = createInteractChip({ mount: parent, touch: false, onPress: vi.fn() });
    const element = chip.element;
    expect(element.parentNode).toBe(parent);
    expect(element.dataset['shown']).toBe('false');
    expect(element.style.opacity).toBe('0');
    expect(element.getAttribute('aria-hidden')).toBe('true');
    // Centred low on the screen, above the HUD's bottom band; never in the tab order.
    expect(element.style.left).toBe('50%');
    expect(element.style.bottom).toContain('56px');
    expect(element.tabIndex).toBe(-1);

    chip.show(SHIELD);
    expect(chip.visible).toBe(true);
    expect(element.dataset['shown']).toBe('true');
    expect(element.style.opacity).toBe('1');
    expect(element.style.visibility).toBe('visible');
    expect(element.style.transition).toContain(`opacity ${INTERACT_CHIP_FADE_MS}ms`);
    const [key, words] = [...element.children] as HTMLElement[];
    expect(key!.textContent).toBe('E');
    expect(words!.textContent).toBe('SHIELD');
    expect(element.getAttribute('aria-label')).toBe('SHIELD (E)');
    // The keycap is Silkscreen on an Ember block with an Outline border; the words are VT323.
    expect(key!.style.font).toContain('Silkscreen');
    expect(key!.style.background).toContain('#f56a16');
    expect(key!.style.border).toContain('#24120a');
    expect(element.style.font).toContain('VT323');

    // Fading out keeps its words, and hides only once the fade is over.
    chip.show(null);
    expect(element.dataset['shown']).toBe('false');
    expect(element.style.opacity).toBe('0');
    expect(element.style.transition).toContain(`visibility 0s linear ${INTERACT_CHIP_FADE_MS}ms`);
    expect(words!.textContent).toBe('SHIELD');
    chip.destroy();
    expect(element.parentNode).toBeNull();
  });

  it('does not fade for a player who asked for less motion', () => {
    const chip = createInteractChip({ mount: mount(), touch: false, onPress: vi.fn(), reducedMotion: () => true });
    chip.show(SHIELD);
    expect(chip.element.style.transition).toBe('none');
    chip.destroy();
  });

  it('is a hint the pointer passes through on a desktop, and a tap target on a touch screen', () => {
    const onPress = vi.fn();
    const desktop = createInteractChip({ mount: mount(), touch: false, onPress });
    desktop.show(SHIELD);
    expect(desktop.element.style.pointerEvents).toBe('none');
    desktop.element.click();
    expect(onPress).not.toHaveBeenCalled();
    desktop.destroy();

    const phone = createInteractChip({ mount: mount(), touch: true, onPress });
    // A tap on a hidden chip does nothing.
    phone.element.click();
    expect(onPress).not.toHaveBeenCalled();
    expect(phone.element.style.pointerEvents).toBe('none');
    phone.show(SHIELD);
    expect(phone.element.style.pointerEvents).toBe('auto');
    expect(phone.element.style.minHeight).toBe('48px');
    phone.element.focus();
    phone.element.click();
    expect(onPress).toHaveBeenCalledOnce();
    // The keyboard goes straight back to the World.
    expect(document.activeElement).not.toBe(phone.element);
    phone.destroy();
  });

  it('steps aside while a text field has focus, where E types a letter', () => {
    const onPress = vi.fn();
    const chip = createInteractChip({ mount: mount(), touch: true, onPress });
    chip.show(SHIELD);
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    expect(chip.visible).toBe(false);
    expect(chip.element.dataset['shown']).toBe('false');
    chip.element.click();
    expect(onPress).not.toHaveBeenCalled();
    input.blur();
    expect(chip.visible).toBe(true);
    expect(chip.element.dataset['shown']).toBe('true');
    input.remove();
    chip.destroy();
  });

  it('shows the counter the player stands at, and a tap opens it through the session, exactly as E would', () => {
    const world = bankSession(true);
    expect(world.activated()).toEqual([]);
    expect(world.chip.visible).toBe(true);
    expect(world.chip.element.textContent).toBe('ESHIELD');
    world.chip.element.click();
    expect(world.activated()).toEqual([{ building: 'bank', station: 'bank:shielding' }]);
    world.finish();
  });

  it('hides while a panel holds the controls, and while a fight suspends the stations', () => {
    const world = bankSession(true);
    expect(world.chip.visible).toBe(true);
    // A panel (or Menu Mode) claims the keyboard.
    world.shellEmit('world:control-owner', { building: 'bank', owner: 'shell' });
    world.session.update(16);
    expect(world.chip.visible).toBe(false);
    world.chip.element.click();
    expect(world.activated()).toEqual([]);
    world.shellEmit('world:control-owner', { building: 'bank', owner: 'world' });
    world.session.update(16);
    expect(world.chip.visible).toBe(true);
    // The combat yield (D-117).
    const release = world.session.interactions.suspend('combat');
    world.session.update(16);
    expect(world.chip.visible).toBe(false);
    release();
    world.session.update(16);
    expect(world.chip.visible).toBe(true);
    world.finish();
  });

  it('shows nothing at a locked counter', () => {
    const world = bankSession(true, 'locked');
    expect(world.chip.shown).toBeNull();
    expect(world.chip.visible).toBe(false);
    world.chip.element.click();
    expect(world.activated()).toEqual([]);
    world.finish();
  });
});
