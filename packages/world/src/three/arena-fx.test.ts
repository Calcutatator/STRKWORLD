import { describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, type MeshBasicMaterial, type Object3D } from 'three';
import { ARENA_DUMMY_TILE, ARENA_MAX_HP, type ArenaPhase, type GameId } from '@strkworld/shared';
import type { ArenaViewFrame } from '../arena-channel.js';
import { tileCenterToGround } from './coords.js';
import {
  ARENA_FX_NUMBER_MS,
  ARENA_FX_NUMBER_RISE,
  ARENA_FX_REDUCED_NUMBER_MS,
  ARENA_FX_TOPPLE_MS,
  createArenaFx,
  splitDamage,
  type RemoteSwingPort,
} from './arena-fx.js';

const FIGHTER = 'g-fighter' as GameId;

function frame(over: Partial<Omit<ArenaViewFrame, 'dummy'>> & { hp?: number; hits?: number; down?: boolean; phase?: ArenaPhase } = {}): ArenaViewFrame {
  const phase = over.phase ?? 'fighting';
  const hp = over.hp ?? ARENA_MAX_HP;
  return {
    phase,
    gate: phase === 'idle' ? 'open' : 'busy',
    dummy: phase === 'idle' ? null : { hp, maxHp: ARENA_MAX_HP, hits: over.hits ?? 0, down: over.down ?? false },
    challengerId: phase === 'idle' ? null : over.challengerId ?? FIGHTER,
    challengerSwings: over.challengerSwings ?? 0,
    selfIsChallenger: over.selfIsChallenger ?? false,
  };
}

function setup(reduced = false) {
  const motion = { reduced };
  const fx = createArenaFx({ reducedMotion: () => motion.reduced });
  const find = (name: string): Object3D => {
    const found = fx.group.getObjectByName(name);
    if (!found) throw new Error(`no ${name}`);
    return found;
  };
  const numbers = (): Mesh<never, MeshBasicMaterial>[] =>
    fx.group.children.filter((c): c is Mesh<never, MeshBasicMaterial> => c instanceof Mesh && c.name === 'arena:damage-number');
  const shownNumbers = () => numbers().filter((n) => n.visible);
  const dummyMaterial = () => (find('arena-fx:dummy') as Mesh<never, MeshStandardMaterial>).material;
  const pivot = () => find('arena-dummy-pivot');
  const fill = () => find('arena:hp-fill');
  const run = (ms: number, step = 16) => {
    for (let t = 0; t < ms; t += step) fx.update(step);
  };
  return { fx, motion, find, numbers, shownNumbers, dummyMaterial, pivot, fill, run };
}

describe('arena fx: the dummy and its HP bar', () => {
  it('stands the dummy on its tile in the room, with the bar hidden while the ring is idle', () => {
    const { fx, find } = setup();
    const ground = tileCenterToGround(ARENA_DUMMY_TILE.x, ARENA_DUMMY_TILE.y, { x: 64, y: 64 });
    const dummy = find('arena-fx-dummy');
    expect(dummy.position.x).toBeCloseTo(ground.x);
    expect(dummy.position.z).toBeCloseTo(ground.z);
    fx.sync(frame({ phase: 'idle' }), null);
    expect(find('arena-hp-bar').visible).toBe(false);
    fx.sync(frame({ phase: 'countdown' }), null);
    expect(find('arena-hp-bar').visible).toBe(true);
  });

  it('a late join mid-fight is a baseline: the bar snaps to the server’s HP and no number shows', () => {
    const { fx, fill, shownNumbers } = setup();
    fx.sync(frame({ hp: 40, hits: 6 }), null);
    expect(fill().scale.x).toBeCloseTo(0.4);
    expect(shownNumbers()).toHaveLength(0);
  });

  it('the bar eases towards the server’s HP at full motion and snaps under reduced motion', () => {
    const full = setup();
    full.fx.sync(frame(), null);
    full.fx.sync(frame({ hp: 90, hits: 1 }), null);
    expect(full.fill().scale.x).toBeCloseTo(1);
    full.run(500);
    expect(full.fill().scale.x).toBeCloseTo(0.9, 2);
    const quiet = setup(true);
    quiet.fx.sync(frame(), null);
    quiet.fx.sync(frame({ hp: 90, hits: 1 }), null);
    expect(quiet.fill().scale.x).toBeCloseTo(0.9);
  });
});

describe('arena fx: hits come from server state', () => {
  it('an HP delta spawns a damage number and a flash', () => {
    const { fx, shownNumbers, dummyMaterial } = setup();
    fx.sync(frame(), null);
    expect(dummyMaterial().emissive.getHex()).toBe(0);
    fx.sync(frame({ hp: 90, hits: 1 }), null);
    expect(shownNumbers()).toHaveLength(1);
    expect(dummyMaterial().emissive.r).toBeGreaterThan(0);
  });

  it('two hits coalesced in one patch show two numbers', () => {
    const { fx, shownNumbers } = setup();
    fx.sync(frame(), null);
    fx.sync(frame({ hp: 80, hits: 2 }), null);
    expect(shownNumbers()).toHaveLength(2);
    expect(splitDamage(20, 2)).toEqual([10, 10]);
    expect(splitDamage(25, 2)).toEqual([12, 13]);
    expect(splitDamage(10, 0)).toEqual([10]);
    expect(splitDamage(0, 3)).toEqual([]);
    // The hits counter wraps at 256.
    expect(splitDamage(10, (0 - 255) & 0xff)).toEqual([10]);
  });

  it('a swing the server counted as a miss (swings up, HP unchanged) shows nothing', () => {
    const { fx, shownNumbers, dummyMaterial } = setup();
    fx.sync(frame({ challengerSwings: 0 }), null);
    fx.sync(frame({ challengerSwings: 1 }), null);
    expect(shownNumbers()).toHaveLength(0);
    expect(dummyMaterial().emissive.getHex()).toBe(0);
  });

  it('a number rises 0.8 and fades over 700 ms at full motion', () => {
    const { fx, shownNumbers, run } = setup();
    fx.sync(frame(), null);
    fx.sync(frame({ hp: 90, hits: 1 }), null);
    const number = shownNumbers()[0]!;
    const startY = number.position.y;
    run(ARENA_FX_NUMBER_MS - 50, 10);
    expect(number.position.y - startY).toBeGreaterThan(ARENA_FX_NUMBER_RISE * 0.9);
    expect(number.material.opacity).toBeLessThan(0.2);
    run(100, 10);
    expect(number.visible).toBe(false);
  });

  it('the dummy wobbles on a hit at full motion and settles', () => {
    const { fx, pivot, run } = setup();
    fx.sync(frame(), null);
    fx.sync(frame({ hp: 90, hits: 1 }), null);
    run(48);
    expect(Math.abs(pivot().rotation.z)).toBeGreaterThan(0.01);
    run(3000);
    expect(Math.abs(pivot().rotation.z)).toBeLessThan(0.001);
  });

  it('knockout topples the dummy over 500 ms; a new fight stands it back up', () => {
    const { fx, pivot, run } = setup();
    fx.sync(frame({ hp: 10, hits: 9 }), null);
    fx.sync(frame({ phase: 'ended', hp: 0, hits: 10, down: true }), null);
    run(ARENA_FX_TOPPLE_MS / 2);
    const halfway = pivot().rotation.z;
    expect(halfway).toBeLessThan(-0.3);
    expect(halfway).toBeGreaterThan(-Math.PI / 2);
    run(ARENA_FX_TOPPLE_MS);
    expect(pivot().rotation.z).toBeCloseTo(-Math.PI / 2, 3);
    fx.sync(frame({ phase: 'idle' }), null);
    expect(pivot().rotation.z).toBeCloseTo(0, 5);
  });

  it('joining after a knockout shows the dummy already down', () => {
    const { fx, pivot } = setup();
    fx.sync(frame({ phase: 'ended', hp: 0, hits: 10, down: true }), null);
    expect(pivot().rotation.z).toBeCloseTo(-Math.PI / 2, 3);
  });
});

describe('arena fx: reduced motion', () => {
  it('no wobble, no rise, no straw: a colour flash and a number that fades in place over 500 ms', () => {
    const { fx, pivot, shownNumbers, dummyMaterial, find, run } = setup(true);
    fx.sync(frame(), null);
    fx.sync(frame({ hp: 90, hits: 1 }), null);
    expect(dummyMaterial().emissive.getHex()).toBe(0);
    expect(dummyMaterial().color.g).toBeLessThan(1);
    const number = shownNumbers()[0]!;
    const startY = number.position.y;
    run(ARENA_FX_REDUCED_NUMBER_MS - 20, 10);
    expect(pivot().rotation.z).toBe(-0);
    expect(number.position.y).toBe(startY);
    expect(find('arena:straw').visible).toBe(false);
    run(40, 10);
    expect(number.visible).toBe(false);
  });

  it('knockout snaps the dummy flat and dims it, with no burst', () => {
    const { fx, pivot, dummyMaterial, find } = setup(true);
    fx.sync(frame({ hp: 10, hits: 9 }), null);
    fx.sync(frame({ phase: 'ended', hp: 0, hits: 10, down: true }), null);
    expect(pivot().rotation.z).toBeCloseTo(-Math.PI / 2, 5);
    expect(dummyMaterial().color.r).toBeLessThan(0.7);
    expect(find('arena:straw').visible).toBe(false);
  });
});

describe('arena fx: spectators see the fighter swing', () => {
  function port() {
    return { playSwing: vi.fn(), setFighter: vi.fn() } satisfies RemoteSwingPort;
  }

  it('plays a peer’s swing when the server’s swing counter moves', () => {
    const { fx } = setup();
    const remote = port();
    fx.sync(frame({ challengerSwings: 3 }), remote);
    expect(remote.playSwing).not.toHaveBeenCalled();
    fx.sync(frame({ challengerSwings: 4 }), remote);
    expect(remote.playSwing).toHaveBeenCalledWith(FIGHTER);
    // The knockout swing arrives with the ended patch.
    fx.sync(frame({ phase: 'ended', challengerSwings: 5, hp: 0, down: true }), remote);
    expect(remote.playSwing).toHaveBeenCalledTimes(2);
  });

  it('never plays the fighter’s own swing back to it: its client predicted it', () => {
    const { fx } = setup();
    const remote = port();
    fx.sync(frame({ challengerSwings: 0, selfIsChallenger: true }), remote);
    fx.sync(frame({ challengerSwings: 1, selfIsChallenger: true }), remote);
    expect(remote.playSwing).not.toHaveBeenCalled();
  });

  it('a new challenger is a baseline, not a swing', () => {
    const { fx } = setup();
    const remote = port();
    fx.sync(frame({ challengerSwings: 9 }), remote);
    fx.sync(frame({ challengerId: 'g-next' as GameId, challengerSwings: 0, phase: 'countdown' }), remote);
    expect(remote.playSwing).not.toHaveBeenCalled();
  });

  it('marks the fighter for the battle stance while the ring is busy', () => {
    const { fx } = setup();
    const remote = port();
    fx.sync(frame({ phase: 'countdown' }), remote);
    expect(remote.setFighter).toHaveBeenLastCalledWith(FIGHTER);
    fx.sync(frame({ phase: 'idle' }), remote);
    expect(remote.setFighter).toHaveBeenLastCalledWith(null);
  });
});

describe('arena fx: lifecycle', () => {
  it('a null frame stands the dummy up and hides the bar; dispose empties the group', () => {
    const { fx, find, pivot } = setup(true);
    fx.sync(frame({ phase: 'ended', hp: 0, hits: 10, down: true }), null);
    fx.sync(null, null);
    expect(pivot().rotation.z).toBeCloseTo(0, 5);
    expect(find('arena-hp-bar').visible).toBe(false);
    fx.dispose();
    expect(fx.group.children).toHaveLength(0);
    // Inert afterwards.
    fx.sync(frame(), null);
    fx.update(16);
  });
});

describe('arena fx: the room’s own dummy', () => {
  function roomDummy() {
    const shared = new MeshStandardMaterial({ color: 0xffffff });
    const dummy = new Group();
    dummy.position.set(20.5, 0, 14.5);
    const body = new Mesh(new BoxGeometry(0.5, 1, 0.3), shared);
    dummy.add(body);
    return { dummy, body, shared };
  }

  it('flashes and topples the room’s dummy on its own material, and builds none of its own', () => {
    const { dummy, body, shared } = roomDummy();
    const fx = createArenaFx({ reducedMotion: () => false, dummy });
    expect(fx.group.getObjectByName('arena-fx:dummy')).toBeUndefined();
    expect(body.material).not.toBe(shared);
    // The bar sits over the room's dummy, in the same frame.
    expect(fx.group.getObjectByName('arena-hp-bar')!.position.x).toBeCloseTo(20.5);
    fx.sync(frame(), null);
    fx.sync(frame({ hp: 90, hits: 1 }), null);
    expect((body.material as MeshStandardMaterial).emissive.r).toBeGreaterThan(0);
    expect(shared.emissive.getHex()).toBe(0);
    fx.sync(frame({ phase: 'ended', hp: 0, hits: 10, down: true }), null);
    for (let t = 0; t < 600; t += 16) fx.update(16);
    expect(dummy.rotation.z).toBeCloseTo(-Math.PI / 2, 3);
    fx.dispose();
    expect(body.material).toBe(shared);
    expect(dummy.rotation.z).toBe(0);
  });
});

describe('arena fx: finding the room’s dummy once mounted', () => {
  it('adopts the arena room’s `arena:dummy` beside its mount, and drops its own', () => {
    const room = new Group();
    const mount = new Group();
    mount.name = 'arena:fx-mount';
    const dummy = new Group();
    dummy.name = 'arena:dummy';
    dummy.position.set(20.5, 0, 14.5);
    const shared = new MeshStandardMaterial();
    dummy.add(new Mesh(new BoxGeometry(0.5, 1, 0.3), shared));
    room.add(dummy, mount);
    const fx = createArenaFx({ reducedMotion: () => false });
    expect(fx.group.getObjectByName('arena-fx:dummy')).toBeDefined();
    mount.add(fx.group);
    fx.update(16);
    expect(fx.group.getObjectByName('arena-fx:dummy')).toBeUndefined();
    // The bar is over the room's dummy, in the room's own frame.
    expect(fx.group.getObjectByName('arena-hp-bar')!.position.x).toBeCloseTo(20.5);
    fx.sync(frame({ hp: 10, hits: 9 }), null);
    fx.sync(frame({ phase: 'ended', hp: 0, hits: 10, down: true }), null);
    for (let t = 0; t < 600; t += 16) fx.update(16);
    expect(dummy.rotation.z).toBeCloseTo(-Math.PI / 2, 3);
    expect(shared.emissive.getHex()).toBe(0);
    fx.dispose();
    expect((dummy.children[0] as Mesh).material).toBe(shared);
  });

  it('keeps its own dummy where the room has none', () => {
    const mount = new Group();
    const fx = createArenaFx({ reducedMotion: () => false });
    mount.add(fx.group);
    fx.update(16);
    expect(fx.group.getObjectByName('arena-fx:dummy')).toBeDefined();
    fx.dispose();
  });
});
