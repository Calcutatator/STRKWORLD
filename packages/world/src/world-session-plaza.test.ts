import { describe, expect, it } from 'vitest';
import type { ShellEvents, WorldEvents } from '@strkworld/shared';
import { PLAZA_MONUMENT_STATION, PLAZA_SHELLS_STATION } from './map/plaza.js';
import { TILE_SIZE } from './map/street.js';
import type { MovementInput } from './street-movement.js';
import { createWorldSession, type WorldKeyboard, type WorldSession, type WorldSessionView } from './world-session.js';

/**
 * The Privacy Plaza inside the gameplay session (D-076): E on the street at
 * a station's approach, the Shell's control claim, the "plaza in view"
 * signal and the monument's figures reaching the view.
 */

const NO_KEYS: MovementInput = Object.freeze({ left: false, right: false, up: false, down: false });
const centre = (x: number, y: number) => ({ x: x * TILE_SIZE + TILE_SIZE / 2, y: y * TILE_SIZE + TILE_SIZE / 2 });

type KeyEvent = { readonly repeat: boolean; readonly target: unknown };

function fakeKeyboard() {
  const handlers = new Map<string, Set<(event: KeyEvent) => void>>();
  let pressed: MovementInput = NO_KEYS;
  const keyboard: WorldKeyboard & {
    hold(keys: Partial<MovementInput>): void;
    press(event: 'keydown-E' | 'keydown-F', repeat?: boolean): void;
    count(event: string): number;
  } = {
    enabled: true,
    get held() {
      return this.enabled ? pressed : NO_KEYS;
    },
    sprinting: false,
    disableGlobalCapture() {},
    enableGlobalCapture() {},
    resetKeys() {
      pressed = NO_KEYS;
    },
    on(event, handler) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event)!.add(handler);
      return undefined;
    },
    off(event, handler) {
      handlers.get(event)?.delete(handler);
      return undefined;
    },
    hold(keys) {
      pressed = { ...NO_KEYS, ...keys };
    },
    press(event, repeat = false) {
      for (const handler of [...(handlers.get(event) ?? [])]) handler({ repeat, target: null });
    },
    count(event) {
      return handlers.get(event)?.size ?? 0;
    },
  };
  return keyboard;
}

function setup(options: { claim?: boolean } = {}) {
  const emitted: Array<{ event: keyof WorldEvents; payload: unknown }> = [];
  const shell = new Map<keyof ShellEvents, Set<(payload: unknown) => void>>();
  const shellEmit = (event: keyof ShellEvents, payload: unknown): void => {
    for (const handler of [...(shell.get(event) ?? [])]) handler(payload);
  };
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const view = new Proxy({} as WorldSessionView, {
    get: (_target, property) => (...args: unknown[]) => {
      calls.push({ method: String(property), args });
    },
  });
  const keyboard = fakeKeyboard();
  const session = createWorldSession({
    view,
    keyboard,
    config: {
      out: {
        emit(event, payload) {
          emitted.push({ event, payload });
          // The Shell claims the controls while the activation is delivered.
          if (event === 'station:activated' && options.claim) {
            shellEmit('world:control-owner', { building: 'plaza', owner: 'shell' });
          }
        },
      },
      in: {
        on(event, handler) {
          const set = shell.get(event) ?? new Set();
          set.add(handler as (payload: unknown) => void);
          shell.set(event, set);
          return () => set.delete(handler as (payload: unknown) => void);
        },
      },
    },
  });
  return {
    session,
    keyboard,
    emitted,
    calls,
    shellEmit,
    events: (name: keyof WorldEvents) => emitted.filter((entry) => entry.event === name).map((entry) => entry.payload),
    last: (method: string) => [...calls].reverse().find((call) => call.method === method)?.args,
  };
}

/** Put the player on a street tile and let the session report it. */
function standAt(world: ReturnType<typeof setup>, x: number, y: number): void {
  (world.session as unknown as { position: { x: number; y: number } }).position = centre(x, y);
  // One tiny step reports the tile, then stand still.
  world.keyboard.hold({ up: true });
  world.session.update(1);
  world.keyboard.hold({});
  world.session.update(16);
}

describe('the Privacy Plaza in the session (D-076)', () => {
  it('opens the monument with E from its approach, after the Shell claims the controls', () => {
    const world = setup({ claim: true });
    standAt(world, 5, 26);
    standAt(world, 5, 25);
    expect(world.last('setPlazaHighlight')).toEqual([PLAZA_MONUMENT_STATION]);
    world.keyboard.press('keydown-E');
    expect(world.events('station:activated')).toEqual([{ building: 'plaza', station: PLAZA_MONUMENT_STATION }]);
    expect(world.session.inputSuspended).toBe(true);
    // While the window is open, E and movement are the Shell's.
    world.keyboard.press('keydown-E');
    expect(world.events('station:activated')).toHaveLength(1);
    world.shellEmit('world:control-owner', { building: 'plaza', owner: 'world' });
    expect(world.session.inputSuspended).toBe(false);
    // Still a street visit: no building was entered and nothing left the street.
    expect(world.session.area).toBe('street');
    expect(world.events('building:entered')).toEqual([]);
  });

  it('opens the shell game at the table, and nothing away from both stations', () => {
    const world = setup();
    standAt(world, 5, 20);
    world.keyboard.press('keydown-E');
    expect(world.events('station:activated')).toEqual([]);
    standAt(world, 10, 23);
    world.keyboard.press('keydown-E');
    world.keyboard.press('keydown-E', true);
    expect(world.events('station:activated')).toEqual([{ building: 'plaza', station: PLAZA_SHELLS_STATION }]);
    // Nobody claimed the controls, so the World kept them.
    expect(world.session.inputSuspended).toBe(false);
  });

  it('tells the Shell when the plaza comes into view and when it leaves', () => {
    const world = setup();
    standAt(world, 24, 15);
    standAt(world, 12, 17);
    standAt(world, 5, 22);
    standAt(world, 20, 15);
    expect(world.events('plaza:nearby')).toEqual([{ near: true }, { near: false }]);
  });

  it('takes "in view" back when the World goes away at the plaza', () => {
    const world = setup();
    standAt(world, 5, 22);
    world.session.destroy();
    expect(world.events('plaza:nearby')).toEqual([{ near: true }, { near: false }]);
  });

  it("hands the Shell's figures to the view", () => {
    const world = setup();
    world.shellEmit('plaza:stats', { accounts: '2,932', deposits24h: '23', held: ['2.56M STRK'] });
    expect(world.last('setPlazaStats')).toEqual([{ accounts: '2,932', deposits24h: '23', held: ['2.56M STRK'] }]);
  });

  it('adds no plaza key without a bus, and releases it on destroy', () => {
    const keyboard = fakeKeyboard();
    const headless: WorldSession = createWorldSession({ view: new Proxy({} as WorldSessionView, { get: () => () => {} }), keyboard });
    expect(keyboard.count('keydown-E')).toBe(0);
    headless.destroy();

    const world = setup();
    expect(world.keyboard.count('keydown-E')).toBe(1);
    world.session.destroy();
    expect(world.keyboard.count('keydown-E')).toBe(0);
    world.shellEmit('plaza:stats', { accounts: '1', deposits24h: '1', held: null });
    expect(world.last('setPlazaStats')).toBeUndefined();
  });
});
