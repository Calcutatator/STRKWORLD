import { describe, expect, it } from 'vitest';
import { CLIMB_FROM_PHASE, SANDBOX_AREA, SANDBOX_BURST_HEIGHT, type SandboxSnapshot, type SandboxTile } from '@strkworld/shared';
import { JUMP_AIR_MS, JUMP_COOLDOWN_MS } from './jump.js';
import { TILE_SIZE } from './map/street.js';
import type { SandboxChannel } from './sandbox-channel.js';
import type { MovementInput } from './street-movement.js';
import {
  createWorldSession,
  type WorldKeyboard,
  type WorldSession,
  type WorldSessionView,
} from './world-session.js';

/**
 * The block sandbox inside the gameplay session (D-060). The ported
 * StreetScene suite never supplies a sandbox; this file covers what one adds.
 */

const X = SANDBOX_AREA.x + 4;
const Y = 14;
const NO_KEYS: MovementInput = Object.freeze({ left: false, right: false, up: false, down: false });
const centre = (tileX: number, tileY: number) => ({
  x: tileX * TILE_SIZE + TILE_SIZE / 2,
  y: tileY * TILE_SIZE + TILE_SIZE / 2,
});
const stack = (x: number, y: number, height: number) => ({
  x,
  y,
  colours: Array.from({ length: height }, () => 1),
});

function fakeChannel(initial: SandboxSnapshot = { columns: [], carrying: null }) {
  let snapshot = initial;
  const listeners = new Set<(snapshot: SandboxSnapshot) => void>();
  const drops = new Set<(tile: SandboxTile) => void>();
  const bursts = new Set<(tile: SandboxTile) => void>();
  const resyncs = new Set<(position: { x: number; y: number }) => void>();
  const picks: SandboxTile[] = [];
  const places: SandboxTile[] = [];
  const channel: SandboxChannel = {
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot);
      return () => listeners.delete(listener);
    },
    subscribeDrops(listener) {
      drops.add(listener);
      return () => drops.delete(listener);
    },
    subscribeBursts(listener) {
      bursts.add(listener);
      return () => bursts.delete(listener);
    },
    subscribeResync(listener) {
      resyncs.add(listener);
      return () => resyncs.delete(listener);
    },
    pick: (tile) => picks.push({ x: tile.x, y: tile.y }),
    place: (tile) => places.push({ x: tile.x, y: tile.y }),
  };
  return {
    channel,
    picks,
    places,
    publish(next: SandboxSnapshot) {
      snapshot = next;
      for (const listener of [...listeners]) listener(next);
    },
    drop(tile: SandboxTile) {
      for (const listener of [...drops]) listener(tile);
    },
    burst(tile: SandboxTile) {
      for (const listener of [...bursts]) listener(tile);
    },
    resync(position: unknown) {
      for (const listener of [...resyncs]) listener(position as { x: number; y: number });
    },
    get listeners() {
      return listeners.size + drops.size + bursts.size + resyncs.size;
    },
  };
}

type KeyEvent = { readonly repeat: boolean; readonly target: unknown };

function fakeKeyboard() {
  const handlers = new Map<string, Set<(event: KeyEvent) => void>>();
  let pressed: MovementInput = NO_KEYS;
  const keyboard: WorldKeyboard & {
    hold(keys: Partial<MovementInput>): void;
    press(event: 'keydown-E' | 'keydown-F' | 'keydown-Space', repeat?: boolean): void;
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

/** A view that records every call, sandbox methods included. */
function recordingView() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const view = new Proxy({} as WorldSessionView, {
    get: (_target, property) => (...args: unknown[]) => {
      calls.push({ method: String(property), args });
    },
  });
  return {
    view,
    calls,
    last(method: string): unknown[] | undefined {
      return [...calls].reverse().find((call) => call.method === method)?.args;
    },
    count(method: string): number {
      return calls.filter((call) => call.method === method).length;
    },
  };
}

function setup(initial?: SandboxSnapshot) {
  const sandbox = fakeChannel(initial);
  const keyboard = fakeKeyboard();
  const recording = recordingView();
  const session = createWorldSession({ view: recording.view, keyboard, sandbox: sandbox.channel });
  return { sandbox, keyboard, recording, session };
}

function place(session: WorldSession, position: { x: number; y: number }): void {
  (session as unknown as { position: { x: number; y: number } }).position = { ...position };
}

function suspend(session: WorldSession): void {
  (session as unknown as { inputGate: { suspend(): void } }).inputGate.suspend();
}

/** Face a direction with one short step, then stand still. */
function face(world: ReturnType<typeof setup>, direction: keyof MovementInput): void {
  world.keyboard.hold({ [direction]: true });
  world.session.update(1);
  world.keyboard.hold({});
  world.session.update(16);
}

describe('WorldSession block sandbox (D-060)', () => {
  it('replays the shared stacks and carried colour into the view, then follows changes', () => {
    const world = setup({ columns: [stack(X, Y, 2)], carrying: 5 });
    expect(world.recording.last('setSandboxColumns')).toEqual([[stack(X, Y, 2)]]);
    expect(world.recording.last('setCarried')).toEqual([5]);
    world.sandbox.publish({ columns: [], carrying: null });
    expect(world.recording.last('setSandboxColumns')).toEqual([[]]);
    expect(world.recording.last('setCarried')).toEqual([null]);
  });

  it('adds nothing without a sandbox channel: E does nothing there and no sandbox calls', () => {
    const keyboard = fakeKeyboard();
    const recording = recordingView();
    const session = createWorldSession({ view: recording.view, keyboard });
    place(session, centre(X, Y));
    session.update(16);
    // D-117: the session's one E key, with no sandbox action behind it.
    expect(keyboard.count('keydown-E')).toBe(1);
    expect(session.interact()).toBe(false);
    expect(recording.count('setSandboxColumns')).toBe(0);
    expect(recording.count('setSandboxAim')).toBe(0);
  });

  it('aims at the faced tile inside the sandbox and clears the aim outside it', () => {
    const world = setup({ columns: [stack(X + 1, Y, 1)], carrying: null });
    place(world.session, centre(X, Y));
    face(world, 'right');
    expect(world.recording.last('setSandboxAim')?.[0]).toMatchObject({
      tile: { x: X + 1, y: Y },
      mode: 'pick',
      valid: true,
    });
    place(world.session, centre(20, 14));
    world.session.update(16);
    expect(world.recording.last('setSandboxAim')).toEqual([null]);
  });

  it('picks the faced block with E, and places when carrying', () => {
    const world = setup({ columns: [stack(X + 1, Y, 1)], carrying: null });
    place(world.session, centre(X, Y));
    face(world, 'right');
    world.keyboard.press('keydown-E');
    expect(world.sandbox.picks).toEqual([{ x: X + 1, y: Y }]);

    world.sandbox.publish({ columns: [], carrying: 3 });
    world.keyboard.press('keydown-E');
    expect(world.sandbox.places).toEqual([{ x: X + 1, y: Y }]);
  });

  it('sends nothing for an invalid aim, a held repeat or a suspended gate', () => {
    const world = setup({ columns: [stack(X + 1, Y, 3)], carrying: null });
    place(world.session, centre(X, Y));
    face(world, 'right');
    world.keyboard.press('keydown-E');
    expect(world.sandbox.picks).toEqual([]);

    world.sandbox.publish({ columns: [stack(X + 1, Y, 1)], carrying: null });
    world.keyboard.press('keydown-E', true);
    expect(world.sandbox.picks).toEqual([]);

    suspend(world.session);
    world.keyboard.press('keydown-E');
    expect(world.sandbox.picks).toEqual([]);
  });

  it('walks into a one-block stack as into a wall: no auto-climb (D-106)', () => {
    const world = setup({ columns: [stack(X + 1, Y, 1)], carrying: null });
    place(world.session, centre(X, Y));
    world.keyboard.hold({ right: true });
    for (let frame = 0; frame < 60; frame += 1) world.session.update(16);
    expect(world.session.elevation).toBe(0);
    expect(world.session.player.x).toBeLessThanOrEqual((X + 1) * TILE_SIZE - 12);
    expect(world.recording.count('setPlayerElevation')).toBe(0);
  });

  it('jumps up onto a one-block stack near the peak and reports the new elevation (D-106)', () => {
    const world = setup({ columns: [stack(X + 1, Y, 1)], carrying: null });
    // Pressed against the stack, then Space.
    place(world.session, { x: (X + 1) * TILE_SIZE - 12, y: centre(X, Y).y });
    world.keyboard.hold({ right: true });
    world.session.update(16);
    world.keyboard.press('keydown-Space');
    // Before the window opens (35% of the air time), the stack is still a wall.
    let elapsed = 0;
    for (; elapsed + 16 < CLIMB_FROM_PHASE * JUMP_AIR_MS; elapsed += 16) world.session.update(16);
    expect(world.session.elevation).toBe(0);
    // By 40% of the air time the body is on the stack.
    for (; elapsed < 0.4 * JUMP_AIR_MS; elapsed += 16) world.session.update(16);
    expect(world.session.elevation).toBe(1);
    expect(world.recording.last('setPlayerElevation')).toEqual([1]);
    // Landed on top, standing still, it stays there.
    world.keyboard.hold({});
    for (let frame = 0; frame < 30; frame += 1) world.session.update(16);
    expect(world.session.elevation).toBe(1);
  });

  it('climbs when the jump started before reaching the stack, while still in the air', () => {
    const world = setup({ columns: [stack(X + 2, Y, 1)], carrying: null });
    place(world.session, centre(X, Y));
    world.keyboard.hold({ right: true });
    world.keyboard.press('keydown-Space');
    for (let frame = 0; frame < 30; frame += 1) world.session.update(16);
    expect(world.session.elevation).toBe(1);
  });

  it('is not carried up by a jump that has already landed', () => {
    const world = setup({ columns: [stack(X + 3, Y, 1)], carrying: null });
    place(world.session, centre(X, Y));
    world.keyboard.press('keydown-Space');
    // Land first, standing still, then walk in.
    for (let frame = 0; frame < Math.ceil(JUMP_AIR_MS / 16) + 2; frame += 1) world.session.update(16);
    expect(world.session.jump).not.toBe('airborne');
    world.keyboard.hold({ right: true });
    for (let frame = 0; frame < 60; frame += 1) world.session.update(16);
    expect(world.session.elevation).toBe(0);
  });

  it('is stopped by a stack two blocks higher, jump or not', () => {
    const world = setup({ columns: [stack(X + 1, Y, 2)], carrying: null });
    place(world.session, centre(X, Y));
    world.keyboard.hold({ right: true });
    for (let frame = 0; frame < 60; frame += 1) {
      if (frame % 45 === 5) world.keyboard.press('keydown-Space');
      world.session.update(16);
    }
    expect(world.session.elevation).toBe(0);
    expect(world.session.player.x).toBeLessThanOrEqual((X + 1) * TILE_SIZE - 12);
  });

  it('climbs one block per jump: a staircase takes a jump per step, and two-block steps need the block below', () => {
    const world = setup({ columns: [stack(X + 1, Y, 1), stack(X + 2, Y, 2)], carrying: null });
    place(world.session, { x: (X + 1) * TILE_SIZE - 12, y: centre(X, Y).y });
    world.keyboard.hold({ right: true });
    world.keyboard.press('keydown-Space');
    // The whole jump and its cooldown, so the next press takes off.
    for (let frame = 0; frame < Math.ceil((JUMP_AIR_MS + JUMP_COOLDOWN_MS) / 16) + 1; frame += 1) world.session.update(16);
    // One jump, one step: stopped at the foot of the second.
    expect(world.session.elevation).toBe(1);
    expect(world.session.player.x).toBeLessThanOrEqual((X + 2) * TILE_SIZE - 12);
    world.keyboard.press('keydown-Space');
    for (let frame = 0; frame < 30; frame += 1) world.session.update(16);
    expect(world.session.elevation).toBe(2);
  });

  it('steps down without a jump, as before', () => {
    const world = setup({ columns: [stack(X, Y, 1)], carrying: null });
    place(world.session, centre(X, Y));
    world.session.update(16);
    expect(world.session.elevation).toBe(1);
    world.keyboard.hold({ right: true });
    for (let frame = 0; frame < 20; frame += 1) world.session.update(16);
    expect(world.session.elevation).toBe(0);
  });

  it('stands where the lobby holds the player after a refused climb, and does not retry in that jump', () => {
    const world = setup({ columns: [stack(X + 1, Y, 1), stack(X + 1, Y + 1, 1)], carrying: null });
    place(world.session, { x: (X + 1) * TILE_SIZE - 12, y: centre(X, Y).y });
    world.keyboard.hold({ right: true });
    world.session.update(16);
    world.keyboard.press('keydown-Space');
    for (let frame = 0; frame < Math.ceil((0.4 * JUMP_AIR_MS) / 16); frame += 1) world.session.update(16);
    expect(world.session.elevation).toBe(1);
    const held = { x: (X + 1) * TILE_SIZE - 12, y: centre(X, Y).y };
    world.sandbox.resync(held);
    expect(world.session.player).toEqual(held);
    expect(world.session.elevation).toBe(0);
    expect(world.recording.last('setPlayerPosition')).toEqual([held, false]);
    // Still airborne, still walking into the stack: no second climb this jump.
    for (let frame = 0; frame < 10; frame += 1) world.session.update(16);
    expect(world.session.elevation).toBe(0);
    // Junk and far-away resyncs: junk ignored, a far one snaps.
    world.sandbox.resync({ x: Number.NaN, y: 0 });
    world.sandbox.resync(null);
    expect(world.session.elevation).toBe(0);
    world.sandbox.resync(centre(X - 6, Y));
    expect(world.session.player).toEqual(centre(X - 6, Y));
    expect(world.recording.last('setPlayerPosition')).toEqual([centre(X - 6, Y), true]);
  });

  it('walks in through the gate, but not through the wall beside it', () => {
    const gate = setup();
    place(gate.session, centre(SANDBOX_AREA.x - 3, Y));
    gate.keyboard.hold({ right: true });
    for (let frame = 0; frame < 90; frame += 1) gate.session.update(16);
    expect(gate.session.player.x).toBeGreaterThan((SANDBOX_AREA.x + 1) * TILE_SIZE);

    const wall = setup();
    place(wall.session, centre(SANDBOX_AREA.x - 3, 5));
    wall.keyboard.hold({ right: true });
    for (let frame = 0; frame < 90; frame += 1) wall.session.update(16);
    expect(wall.session.player.x).toBeLessThanOrEqual((SANDBOX_AREA.x - 1) * TILE_SIZE - 12);
  });

  it('rises with a stack that grows under a standing player', () => {
    const world = setup();
    place(world.session, centre(X, Y));
    world.session.update(16);
    world.sandbox.publish({ columns: [stack(X, Y, 1)], carrying: null });
    expect(world.session.elevation).toBe(1);
  });

  it('forwards valid sky drops and ignores malformed ones', () => {
    const world = setup();
    world.sandbox.drop({ x: X, y: 2 });
    world.sandbox.drop({ x: 1, y: 2 });
    expect(world.recording.count('sandboxDrop')).toBe(1);
    expect(world.recording.last('sandboxDrop')).toEqual([{ x: X, y: 2 }]);
  });

  it('forwards valid bursts and ignores malformed ones (D-071)', () => {
    const world = setup();
    world.sandbox.burst({ x: X, y: 2 });
    world.sandbox.burst({ x: 1, y: 2 });
    world.sandbox.burst({ x: X + 0.5, y: 2 });
    expect(world.recording.count('sandboxBurst')).toBe(1);
    expect(world.recording.last('sandboxBurst')).toEqual([{ x: X, y: 2 }]);
    expect(world.recording.count('sandboxDrop')).toBe(0);
  });

  it.each(['burst first', 'board first'] as const)(
    'drops a player on a burst pillar to the ground through the usual fall, %s (D-071)',
    (order) => {
      const pillar = stack(X, Y, SANDBOX_BURST_HEIGHT);
      const world = setup({ columns: [pillar, stack(X + 1, Y, 3)], carrying: null });
      place(world.session, centre(X, Y));
      world.session.update(16);
      expect(world.session.elevation).toBe(SANDBOX_BURST_HEIGHT);
      world.recording.calls.length = 0;

      if (order === 'burst first') {
        world.sandbox.burst({ x: X, y: Y });
        // The hint only animates: the player stands where the state says.
        expect(world.session.elevation).toBe(SANDBOX_BURST_HEIGHT);
      }
      world.sandbox.publish({ columns: [], carrying: null });
      if (order === 'board first') world.sandbox.burst({ x: X, y: Y });

      expect(world.session.elevation).toBe(0);
      const methods = world.recording.calls.map((call) => call.method);
      expect(methods.filter((method) => ['sandboxBurst', 'setSandboxColumns', 'setPlayerElevation'].includes(method))).toEqual(
        order === 'burst first'
          ? ['sandboxBurst', 'setSandboxColumns', 'setPlayerElevation']
          : ['setSandboxColumns', 'setPlayerElevation', 'sandboxBurst'],
      );
      expect(world.recording.last('setPlayerElevation')).toEqual([0]);
      expect(world.recording.last('sandboxBurst')).toEqual([{ x: X, y: Y }]);
      // Not a teleport: the view eases the fall (presenter.test.ts).
      expect(world.recording.calls.filter((call) => call.method === 'setPlayerPosition' && call.args[1] === true)).toEqual([]);
    },
  );

  it('unsubscribes and releases the block key on destroy', () => {
    const world = setup();
    expect(world.sandbox.listeners).toBe(4);
    expect(world.keyboard.count('keydown-E')).toBe(1);
    world.session.destroy();
    expect(world.sandbox.listeners).toBe(0);
    expect(world.keyboard.count('keydown-E')).toBe(0);
    world.sandbox.publish({ columns: [stack(X, Y, 1)], carrying: 2 });
    expect(world.recording.last('setCarried')).toBeUndefined();
  });
});
