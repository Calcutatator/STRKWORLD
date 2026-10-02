import { describe, expect, it } from 'vitest';
import type { ShellEvents, WorldEvents } from '@strkworld/shared';
import { JUMP_AIR_MS, JUMP_COOLDOWN_MS } from './jump.js';
import { createStreetMap, tileToWorld } from './map/street.js';
import type { MovementInput } from './street-movement.js';
import { createWorldSession, type WorldKeyboard, type WorldSessionView } from './world-session.js';

/**
 * The jump inside the gameplay session (D-097): Space takes off once, holds
 * until landing, cools down, never moves the player, and yields whenever the
 * World does not own the keyboard.
 */

const NO_KEYS: MovementInput = Object.freeze({ left: false, right: false, up: false, down: false });
const STREET = createStreetMap();
const STUDIO_ENTRANCE = STREET.avatarStudioEntrance;
const BANK_DOOR = STREET.doors.find((door) => door.building === 'bank')!;

type KeyEvent = { readonly repeat: boolean; readonly target: unknown };

function fakeKeyboard() {
  const handlers = new Map<string, Set<(event: KeyEvent) => void>>();
  let pressed: MovementInput = NO_KEYS;
  const keyboard: WorldKeyboard & {
    hold(keys: Partial<MovementInput>): void;
    space(repeat?: boolean): void;
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
    space(repeat = false) {
      for (const handler of [...(handlers.get('keydown-Space') ?? [])]) handler({ repeat, target: null });
    },
    count(event) {
      return handlers.get(event)?.size ?? 0;
    },
  };
  return keyboard;
}

function setup() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const view = new Proxy({} as WorldSessionView, {
    get: (_target, property) => (...args: unknown[]) => {
      calls.push({ method: String(property), args });
    },
  });
  const keyboard = fakeKeyboard();
  const emitted: Array<keyof WorldEvents> = [];
  const shellHandlers = new Map<string, Set<(payload: unknown) => void>>();
  const session = createWorldSession({
    view,
    keyboard,
    config: {
      out: { emit: (event) => emitted.push(event) },
      in: {
        on: (event, handler) => {
          if (!shellHandlers.has(event)) shellHandlers.set(event, new Set());
          shellHandlers.get(event)!.add(handler as (payload: unknown) => void);
          return () => shellHandlers.get(event)?.delete(handler as (payload: unknown) => void);
        },
      },
    },
  });
  const internals = session as unknown as {
    position: { x: number; y: number };
    inputGate: { suspend(): void; resume(): void };
  };
  return {
    session,
    keyboard,
    emitted,
    internals,
    jumps: () => calls.filter((call) => call.method === 'playerJump').length,
    jumpEvents: () => emitted.filter((event) => event === 'player:jumped').length,
    shellEmit<K extends keyof ShellEvents>(event: K, payload: ShellEvents[K]) {
      for (const handler of [...(shellHandlers.get(event) ?? [])]) handler(payload);
    },
    standOn(tile: { x: number; y: number }) {
      internals.position = tileToWorld(tile.x, tile.y);
      session.update(16);
    },
  };
}

describe('the jump in the session (D-097)', () => {
  it('takes off on Space, plays once on the view and tells the Shell, standing still', () => {
    const world = setup();
    expect(world.session.jump).toBe('ready');
    world.keyboard.space();
    expect(world.session.jump).toBe('airborne');
    expect(world.jumps()).toBe(1);
    expect(world.jumpEvents()).toBe(1);
  });

  it('has no double jump, holds until landing, then cools down before the next', () => {
    const world = setup();
    // Frames are clamped to 100 ms, so time passes in 50 ms frames.
    const advance = (ms: number) => {
      for (let done = 0; done < ms; done += 50) world.session.update(50);
    };
    world.keyboard.space();
    advance(JUMP_AIR_MS / 2);
    world.keyboard.space();
    expect(world.jumps()).toBe(1);
    advance(JUMP_AIR_MS / 2);
    expect(world.session.jump).toBe('cooldown');
    world.keyboard.space();
    expect(world.jumps()).toBe(1);
    advance(JUMP_COOLDOWN_MS);
    expect(world.session.jump).toBe('ready');
    world.keyboard.space();
    expect(world.jumps()).toBe(2);
    expect(world.jumpEvents()).toBe(2);
  });

  it('ignores a held key\'s repeats', () => {
    const world = setup();
    world.keyboard.space(true);
    expect(world.jumps()).toBe(0);
    expect(world.session.jump).toBe('ready');
  });

  it('never changes movement: a walk during a jump covers the same ground as one without', () => {
    const walk = (jump: boolean) => {
      const world = setup();
      const start = world.session.player;
      world.keyboard.hold({ right: true });
      if (jump) world.keyboard.space();
      for (let frame = 0; frame < 30; frame += 1) world.session.update(16);
      return { dx: world.session.player.x - start.x, dy: world.session.player.y - start.y };
    };
    const plain = walk(false);
    expect(plain.dx).toBeGreaterThan(0);
    expect(walk(true)).toEqual(plain);
  });

  it('yields while a panel or Shell claim holds the keyboard', () => {
    const world = setup();
    world.internals.inputGate.suspend();
    world.keyboard.space();
    expect(world.jumps()).toBe(0);
    world.internals.inputGate.resume();
    world.keyboard.space();
    expect(world.jumps()).toBe(1);
  });

  it('yields while a room\'s counter holds the controls (control-owner shell), and jumps indoors otherwise', () => {
    const world = setup();
    world.standOn(BANK_DOOR);
    expect(world.session.area).toBe('bank');
    world.shellEmit('world:control-owner', { building: 'bank', owner: 'shell' });
    world.keyboard.space();
    expect(world.jumps()).toBe(0);
    world.shellEmit('world:control-owner', { building: 'bank', owner: 'world' });
    world.keyboard.space();
    // Indoors the jump plays for the player alone; the Shell sends nothing
    // from a private interior, because presence is suspended there.
    expect(world.jumps()).toBe(1);
  });

  it('never jumps in the Avatar Studio', () => {
    const world = setup();
    world.standOn(STUDIO_ENTRANCE);
    expect(world.session.area).toBe('studio');
    world.keyboard.space();
    expect(world.jumps()).toBe(0);
    expect(world.jumpEvents()).toBe(0);
  });

  it('leaves E and F to their own actions: Space is only ever the jump', () => {
    const world = setup();
    expect(world.keyboard.count('keydown-Space')).toBe(1);
    world.keyboard.space();
    expect(world.emitted).toEqual(expect.not.arrayContaining(['avatar:selected']));
  });

  it('releases the Space binding on destroy', () => {
    const world = setup();
    world.session.destroy();
    expect(world.keyboard.count('keydown-Space')).toBe(0);
    world.keyboard.space();
    expect(world.jumps()).toBe(0);
  });
});
