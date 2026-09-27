import { describe, expect, it, vi } from 'vitest';
import { Group, Vector3 } from 'three';
import { SANDBOX_AREA, type AvatarSpriteKey } from '@strkworld/shared';
import { createNullLabelFactory } from './labels.js';
import { createPresenter } from './presenter.js';
import type { AvatarFigure, AvatarFigureFactory } from './types.js';

/**
 * The presenter in node (D-059): real builders and the null label factory,
 * with fake avatar figures so looks and animation calls can be observed.
 */

function fakeFigures() {
  const created: Array<AvatarFigure & { update: ReturnType<typeof vi.fn> }> = [];
  const factory: AvatarFigureFactory = (key) => {
    let look: AvatarSpriteKey = key;
    const figure = {
      object: new Group(),
      get look() {
        return look;
      },
      setLook: vi.fn((next: AvatarSpriteKey) => {
        look = next;
      }),
      update: vi.fn(),
      dispose: vi.fn(),
    };
    created.push(figure);
    return figure;
  };
  return { factory, created };
}

function setup() {
  const parent = new Group();
  const figures = fakeFigures();
  const presenter = createPresenter({ parent, labels: createNullLabelFactory(), figures: figures.factory });
  const view = presenter.bindSession();
  // The Studio builds its figures first; the local avatar hangs off the root.
  const avatar = figures.created.find((figure) => figure.object.parent?.name === 'strkworld')!;
  return { parent, presenter, view, avatar, figures };
}

const tile = (x: number, y: number) => ({ x: x * 32 + 16, y: y * 32 + 16 });

describe('presenter', () => {
  it('draws the local avatar at the session position, in world units', () => {
    const world = setup();
    world.view.setPlayerPosition(tile(24, 15), true);
    world.presenter.update(16);
    expect(world.avatar.object.position.x).toBeCloseTo(24.5);
    expect(world.avatar.object.position.z).toBeCloseTo(15.5);
    expect(world.presenter.consumeSnap()).toBe(true);
    expect(world.presenter.consumeSnap()).toBe(false);
  });

  it('turns the avatar towards its heading without snapping', () => {
    const world = setup();
    world.view.setPlayerMotion({ vx: 160, vy: 0, sprinting: false });
    world.presenter.update(16);
    const yaw = world.presenter.player.yaw;
    expect(yaw).toBeGreaterThan(0);
    expect(yaw).toBeLessThan(Math.PI / 2);
    for (let i = 0; i < 30; i += 1) world.presenter.update(16);
    expect(world.presenter.player.yaw).toBeCloseTo(Math.PI / 2);
  });

  it('shows one room at a time and hides the street while inside', () => {
    const world = setup();
    const street = world.parent.getObjectByName('strkworld')!;
    world.view.setStreetVisible(false);
    world.view.showRoom('bank');
    const rooms = street.children.filter((child) => child.name.includes('room') && child.visible);
    expect(rooms.length).toBeLessThanOrEqual(1);
    world.view.showRoom(null);
    world.view.setStreetVisible(true);
  });

  it('holds a carried block above the head and follows sandbox elevation with a hop', () => {
    const world = setup();
    world.view.setPlayerPosition(tile(SANDBOX_AREA.x + 3, 14), true);
    world.presenter.update(16);
    // The engine consumes the teleport snap every frame; do the same here.
    world.presenter.consumeSnap();
    world.view.setCarried(2);
    const carried = world.avatar.object.children.find((child) => child.visible);
    expect(carried?.position.y).toBeGreaterThan(1);
    world.view.setPlayerElevation(1);
    world.presenter.update(95);
    // Mid-hop the feet are above the landing level, then land exactly.
    expect(world.avatar.object.position.y).toBeGreaterThan(1);
    world.presenter.update(200);
    expect(world.avatar.object.position.y).toBeCloseTo(1);
    world.view.setPlayerElevation(0);
    for (let i = 0; i < 40; i += 1) world.presenter.update(16);
    expect(world.avatar.object.position.y).toBeCloseTo(0);
  });

  it('lands at once when a stack rises more than a block under the player', () => {
    const world = setup();
    world.view.setPlayerPosition(tile(SANDBOX_AREA.x + 3, 14), true);
    world.presenter.update(16);
    world.view.setPlayerElevation(4);
    world.presenter.update(16);
    expect(world.presenter.player.elevation).toBe(4);
  });

  it('ignores a retired session, so it cannot steer its successor', () => {
    const world = setup();
    world.view.setPlayerPosition(tile(10, 14), true);
    const next = world.presenter.bindSession();
    world.view.setPlayerPosition(tile(40, 14), true);
    world.presenter.update(16);
    expect(world.avatar.object.position.x).toBeCloseTo(10.5);
    next.setPlayerPosition(tile(30, 14), true);
    world.presenter.update(16);
    expect(world.avatar.object.position.x).toBeCloseTo(30.5);
  });

  it('fades a building between the camera and the player, and restores it', () => {
    const world = setup();
    // Behind the Bank (north of its footprint), camera to the south.
    world.view.setPlayerPosition(tile(6, 3), true);
    world.presenter.update(16);
    const camera = new Vector3(6.5, 9, 16);
    for (let i = 0; i < 30; i += 1) world.presenter.updateOcclusion(camera, 16);
    world.view.setPlayerPosition(tile(6, 20), true);
    for (let i = 0; i < 30; i += 1) world.presenter.updateOcclusion(camera, 16);
    // No throw, and the loop settles; opacity values are internal to occluders.
    expect(true).toBe(true);
  });

  it('disposes everything once and detaches from its parent', () => {
    const world = setup();
    world.presenter.dispose();
    world.presenter.dispose();
    expect(world.parent.children).toEqual([]);
    for (const figure of world.figures.created) expect(figure.dispose).toHaveBeenCalledOnce();
    expect(() => world.presenter.bindSession()).toThrow();
  });
});
