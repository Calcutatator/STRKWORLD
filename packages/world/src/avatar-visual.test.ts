import { describe, expect, it, vi } from 'vitest';
import {
  AVATAR_VISUAL_CATALOG,
  applyAvatarVisual,
  configureLocalAvatarBody,
  createAvatarVisualController,
  createLocalAvatarVisual,
  preloadAvatarVisuals,
  registerAvatarAnimations,
  resolveAvatarAnimation,
  resolveAvatarSheet,
} from './avatar-visual.js';

describe('D-049 avatar visual catalog', () => {
  it('maps every opaque key to one fixed final sheet contract', () => {
    expect(AVATAR_VISUAL_CATALOG.map((sheet) => ({
      sprite: sheet.sprite,
      file: new URL(sheet.url).pathname.split('/').at(-1),
      sheet: [sheet.width, sheet.height],
      cell: [sheet.frameWidth, sheet.frameHeight],
      origin: [sheet.originX, sheet.originY],
    }))).toEqual(Array.from({ length: 16 }, (_, index) => ({
      sprite: `avatar-${index + 1}`,
      file: `avatar-${index + 1}.png`,
      sheet: [192, 256],
      cell: [64, 64],
      origin: [0.5, 0.875],
    })));
  });

  it('resolves an unknown runtime key to the safe avatar-1 sheet', () => {
    expect(resolveAvatarSheet('avatar-16').sprite).toBe('avatar-16');
    expect(resolveAvatarSheet('review-sheet').sprite).toBe('avatar-1');
    expect(resolveAvatarSheet(undefined).sprite).toBe('avatar-1');
  });

  it('queues every missing final sheet as an untrimmed 64px spritesheet', () => {
    const queued: unknown[][] = [];
    const scene = {
      textures: { exists: (key: string) => key === 'avatar-8' },
      load: { spritesheet: (...args: unknown[]) => queued.push(args) },
    };

    preloadAvatarVisuals(scene as never);

    expect(queued).toHaveLength(15);
    expect(queued[0]).toEqual([
      'avatar-1',
      expect.stringMatching(/player-sprites\/v1\/avatar-1\.png$/),
      { frameWidth: 64, frameHeight: 64, startFrame: 0, endFrame: 11 },
    ]);
    expect(queued.at(-1)).toEqual([
      'avatar-16',
      expect.stringMatching(/player-sprites\/v1\/avatar-16\.png$/),
      { frameWidth: 64, frameHeight: 64, startFrame: 0, endFrame: 11 },
    ]);
    expect(queued.some(([key]) => key === 'avatar-8')).toBe(false);
  });

  it('resolves manifest walk frames and cadence for normal and sprint movement', () => {
    expect(resolveAvatarAnimation('avatar-7', 'left', false)).toEqual({
      key: 'avatar-7:left:walk',
      textureKey: 'avatar-7',
      frames: [3, 4, 3, 5],
      frameRate: 8,
    });
    expect(resolveAvatarAnimation('not-allowed', 'up', true)).toEqual({
      key: 'avatar-1:up:sprint',
      textureKey: 'avatar-1',
      frames: [9, 10, 9, 11],
      frameRate: 12,
    });
  });

  it('registers missing global animations once with their resolved sheet frames', () => {
    const created: Array<Record<string, unknown>> = [];
    const scene = {
      anims: {
        exists: (key: string) => key === 'avatar-1:down:walk',
        create: (config: Record<string, unknown>) => created.push(config),
      },
    };

    registerAvatarAnimations(scene as never);

    expect(created).toHaveLength(127);
    expect(created).toContainEqual({
      key: 'avatar-1:down:sprint',
      frames: [
        { key: 'avatar-1', frame: 0 },
        { key: 'avatar-1', frame: 1 },
        { key: 'avatar-1', frame: 0 },
        { key: 'avatar-1', frame: 2 },
      ],
      frameRate: 12,
      repeat: -1,
    });
    expect(created).toContainEqual({
      key: 'avatar-16:up:walk',
      frames: [
        { key: 'avatar-16', frame: 9 },
        { key: 'avatar-16', frame: 10 },
        { key: 'avatar-16', frame: 9 },
        { key: 'avatar-16', frame: 11 },
      ],
      frameRate: 8,
      repeat: -1,
    });
  });

  it('applies one resolved pose contract to a Phaser sprite target', () => {
    const target = fakeAvatarTarget();

    applyAvatarVisual(target as never, {
      sprite: 'avatar-7',
      facing: 'right',
      moving: true,
      sprinting: true,
    });

    expect(target.setTexture).toHaveBeenLastCalledWith('avatar-7');
    expect(target.setOrigin).toHaveBeenLastCalledWith(0.5, 0.875);
    expect(target.play).toHaveBeenLastCalledWith('avatar-7:right:sprint', true);
    expect(target.setData).toHaveBeenCalledWith('sprite', 'avatar-7');
    expect(target.setData).toHaveBeenCalledWith('facing', 'right');

    applyAvatarVisual(target as never, {
      sprite: 'unknown',
      facing: 'up',
      moving: false,
    });

    expect(target.setTexture).toHaveBeenLastCalledWith('avatar-1');
    expect(target.stop).toHaveBeenCalledTimes(1);
    expect(target.setFrame).toHaveBeenLastCalledWith(9);
  });

  it('keeps the local Arcade body at the prior 24px world-coordinate footprint', () => {
    const body = { velocity: {}, setSize: vi.fn(), setOffset: vi.fn() };
    const player = { x: 320, y: 224, body };

    configureLocalAvatarBody(player as never);

    expect(body.setSize).toHaveBeenCalledWith(24, 24, false);
    expect(body.setOffset).toHaveBeenCalledWith(20, 44);
    expect(player).toMatchObject({ x: 320, y: 224 });
  });

  it('fails closed instead of treating a missing or static body as the player body', () => {
    expect(() => configureLocalAvatarBody({ body: null } as never)).toThrow(
      'Local avatar requires a dynamic Arcade body',
    );
    expect(() => configureLocalAvatarBody({
      body: { setSize: vi.fn(), setOffset: vi.fn() },
    } as never)).toThrow('Local avatar requires a dynamic Arcade body');
  });

  it('retains pose across selection and avoids restarting an unchanged animation', () => {
    const target = fakeAvatarTarget();
    const controller = createAvatarVisualController(target as never);

    controller.update({ facing: 'right', moving: true, sprinting: true });
    controller.update({ facing: 'right', moving: true, sprinting: true });
    expect(target.play).toHaveBeenCalledTimes(1);

    controller.select('avatar-7');
    expect(target.setTexture).toHaveBeenLastCalledWith('avatar-7');
    expect(target.play).toHaveBeenLastCalledWith('avatar-7:right:sprint', true);

    controller.update({ facing: 'right', moving: false, sprinting: false });
    expect(target.stop).toHaveBeenCalledTimes(2);
    expect(target.setFrame).toHaveBeenLastCalledWith(6);
    expect(controller.state).toEqual({
      sprite: 'avatar-7',
      facing: 'right',
      moving: false,
      sprinting: false,
    });
  });

  it('owns local body, movement pose and selection as one StreetScene seam', () => {
    const target = Object.assign(fakeAvatarTarget(), {
      body: { velocity: {}, setSize: vi.fn(), setOffset: vi.fn() },
    });
    const local = createLocalAvatarVisual(target as never);

    local.update({ left: true, right: false, up: true, down: false }, true);
    local.update({ left: true, right: false, up: true, down: false }, true);
    expect(target.play).toHaveBeenCalledTimes(1);
    expect(target.play).toHaveBeenLastCalledWith('avatar-1:up:sprint', true);

    local.select('avatar-7');
    expect(target.play).toHaveBeenLastCalledWith('avatar-7:up:sprint', true);
    expect(target.body.setSize).toHaveBeenCalledWith(24, 24, false);
    expect(target.body.setOffset).toHaveBeenCalledWith(20, 44);

    local.update({ left: false, right: false, up: false, down: false }, false);
    expect(target.setTexture).toHaveBeenLastCalledWith('avatar-7');
    expect(target.setFrame).toHaveBeenLastCalledWith(9);
    expect(local.state).toEqual({
      sprite: 'avatar-7',
      facing: 'up',
      moving: false,
      sprinting: false,
    });
  });
});

function fakeAvatarTarget() {
  const target = {
    setTexture: vi.fn(() => target),
    setOrigin: vi.fn(() => target),
    play: vi.fn(() => target),
    stop: vi.fn(() => target),
    setFrame: vi.fn(() => target),
    setData: vi.fn(() => target),
  };
  return target;
}
