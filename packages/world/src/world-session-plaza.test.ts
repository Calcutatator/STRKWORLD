import { describe, expect, it } from 'vitest';
import { STREET_ORIGIN_X, type ShellEvents, type WorldEvents } from '@strkworld/shared';
import { PLACEMENT_STAND, PLAZA_MONUMENT_STATION, PLAZA_PLACEMENT_STATION, PLAZA_SHELLS_STATION } from './map/plaza.js';
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

function setup(options: { claim?: boolean; placementStand?: boolean } = {}) {
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
    ...(options.placementStand ? { placementStand: true } : {}),
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

/**
 * Put the player on a street tile and let the session report it. `x` counts
 * from the street's first column, as the plaza's own layout does (D-078).
 */
function standAt(world: ReturnType<typeof setup>, x: number, y: number): void {
  (world.session as unknown as { position: { x: number; y: number } }).position = centre(STREET_ORIGIN_X + x, y);
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
    // D-117: the shared prompt, over the monument's centre.
    expect(world.last('setInteractionPrompt')).toEqual([
      { id: PLAZA_MONUMENT_STATION, label: 'POOL STATS', x: (STREET_ORIGIN_X + 5.5) * 32, y: 23.5 * 32 },
    ]);
    expect(world.events('station:activated')).toEqual([]);
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
    world.shellEmit('plaza:stats', { accounts: '2,932', valueUsd: '$1.18M', topHoldings: ['xSTRK · $453K'] });
    expect(world.last('setPlazaStats')).toEqual([
      { accounts: '2,932', valueUsd: '$1.18M', topHoldings: ['xSTRK · $453K'] },
    ]);
  });

  it('offers no plaza station without a bus, and releases the one E key on destroy', () => {
    const keyboard = fakeKeyboard();
    const headless: WorldSession = createWorldSession({ view: new Proxy({} as WorldSessionView, { get: () => () => {} }), keyboard });
    // D-117: one E key in every session; headless, the plaza offers nothing to it.
    expect(keyboard.count('keydown-E')).toBe(1);
    (headless as unknown as { position: { x: number; y: number } }).position = centre(STREET_ORIGIN_X + 5, 25);
    keyboard.hold({ up: true });
    headless.update(1);
    keyboard.hold({});
    headless.update(16);
    expect(headless.interactionPrompt).toBeNull();
    expect(headless.interact()).toBe(false);
    headless.destroy();
    expect(keyboard.count('keydown-E')).toBe(0);

    const world = setup();
    expect(world.keyboard.count('keydown-E')).toBe(1);
    world.session.destroy();
    expect(world.keyboard.count('keydown-E')).toBe(0);
    world.shellEmit('plaza:stats', { accounts: '1', valueUsd: null, topHoldings: null });
    expect(world.last('setPlazaStats')).toBeUndefined();
  });
});

describe('the placement stand by the plaza (leaderboard phase 1)', () => {
  // The pedestal is one tile at the street's x 15, y 23; its approach ring is
  // x 14-16, y 22-24, and the paved path ends on x 14 (D-122, amended 2026-10-02).
  const standX = PLACEMENT_STAND.x - STREET_ORIGIN_X;

  it('opens with E from its approach, like the plaza\'s other stations, when the Shell stands it', () => {
    const world = setup({ placementStand: true, claim: true });
    standAt(world, standX - 2, 23);
    standAt(world, standX - 1, 23);
    // D-117: the shared prompt, over the stand's centre.
    expect(world.last('setInteractionPrompt')).toEqual([{
      id: PLAZA_PLACEMENT_STATION,
      label: 'CHECK PLACEMENT',
      x: (PLACEMENT_STAND.x + PLACEMENT_STAND.width / 2) * 32,
      y: (PLACEMENT_STAND.y + PLACEMENT_STAND.height / 2) * 32,
    }]);
    expect(world.events('station:activated')).toEqual([]);
    world.keyboard.press('keydown-E');
    expect(world.events('station:activated')).toEqual([{ building: 'plaza', station: PLAZA_PLACEMENT_STATION }]);
    expect(world.session.inputSuspended).toBe(true);
    // Walking up never opened it; only E did, and nothing left the street.
    expect(world.session.area).toBe('street');
    expect(world.events('building:entered')).toEqual([]);
  });

  it('does not exist without the switch: E on its lawn does nothing', () => {
    const world = setup();
    standAt(world, standX - 1, 23);
    world.keyboard.press('keydown-E');
    expect(world.events('station:activated')).toEqual([]);
    expect(world.last('setInteractionPrompt') ?? [null]).toEqual([null]);
  });

  it('leaves the monument and the table exactly as they were', () => {
    const world = setup({ placementStand: true });
    standAt(world, 10, 23);
    world.keyboard.press('keydown-E');
    expect(world.events('station:activated')).toEqual([{ building: 'plaza', station: PLAZA_SHELLS_STATION }]);
  });
});
