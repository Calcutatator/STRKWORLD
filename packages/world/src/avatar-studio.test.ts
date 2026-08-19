import { describe, expect, it } from 'vitest';
import type { AvatarSpriteKey, WorldEvents } from '@strkworld/shared';
import {
  AVATAR_STUDIO_DEFINITION,
  avatarStudioFigureAt,
  avatarStudioTileColour,
  createAvatarStudioPresentation,
  createAvatarStudioController,
  isAvatarStudioSolidAt,
  validateAvatarStudioDefinition,
} from './avatar-studio.js';
import { avatarPlaceholderTint } from './avatar-state.js';

type Emitted = { [K in keyof WorldEvents]: { event: K; payload: WorldEvents[K] } }[keyof WorldEvents];

describe('hidden Avatar Studio', () => {
  it('has a fixed 18x12 envelope, eight cosy figures and no building/station seam', () => {
    expect(AVATAR_STUDIO_DEFINITION).toMatchObject({
      width: 18,
      height: 12,
      spawn: { x: 9, y: 9 },
      exit: { x: 8, y: 11, width: 2, height: 1 },
    });
    expect(AVATAR_STUDIO_DEFINITION.figures).toHaveLength(8);
    expect(AVATAR_STUDIO_DEFINITION.figures.map((figure) => figure.sprite)).toEqual([
      'avatar-1',
      'avatar-2',
      'avatar-3',
      'avatar-4',
      'avatar-5',
      'avatar-6',
      'avatar-7',
      'avatar-8',
    ]);
    expect(AVATAR_STUDIO_DEFINITION).not.toHaveProperty('building');
    expect(AVATAR_STUDIO_DEFINITION).not.toHaveProperty('stations');
    expect(() => validateAvatarStudioDefinition(AVATAR_STUDIO_DEFINITION)).not.toThrow();
  });

  it('selects a cosy figure on contact and exits through the bottom opening', () => {
    const events: Emitted[] = [];
    const controller = createAvatarStudioController({
      out: { emit: (event, payload) => events.push({ event, payload } as Emitted) },
    });

    controller.enter();
    expect(controller.state.inRoom).toBe(true);
    expect(events[0]).toEqual({ event: 'avatar-studio:entered', payload: {} });

    const figure = avatarStudioFigureAt(AVATAR_STUDIO_DEFINITION, 14, 6)!;
    controller.update({ x: figure.x, y: figure.y });
    expect(controller.state.selected).toBe('avatar-8');
    expect(events.at(-1)).toEqual({
      event: 'avatar:selected',
      payload: { sprite: 'avatar-8' satisfies AvatarSpriteKey },
    });

    controller.update({ x: 8, y: 11 });
    expect(controller.state.inRoom).toBe(false);
    expect(events.at(-1)).toEqual({ event: 'avatar-studio:exited', payload: {} });
  });

  it('keeps the room border solid except for the two-tile exit', () => {
    expect(isAvatarStudioSolidAt(AVATAR_STUDIO_DEFINITION, 0, 0)).toBe(true);
    expect(isAvatarStudioSolidAt(AVATAR_STUDIO_DEFINITION, 8, 11)).toBe(false);
    expect(isAvatarStudioSolidAt(AVATAR_STUDIO_DEFINITION, 9, 11)).toBe(false);
    expect(isAvatarStudioSolidAt(AVATAR_STUDIO_DEFINITION, 9, 9)).toBe(false);
  });

  it('renders the walkable bottom exit as an opening rather than a wall', () => {
    expect(avatarStudioTileColour(AVATAR_STUDIO_DEFINITION, 8, 11)).toBe(0x8a7c62);
    expect(avatarStudioTileColour(AVATAR_STUDIO_DEFINITION, 9, 11)).toBe(0x8a7c62);
    expect(avatarStudioTileColour(AVATAR_STUDIO_DEFINITION, 0, 11)).toBe(0x39343b);
  });

  it('supports enter/select/exit/re-enter/shutdown through one lifecycle seam', () => {
    const streetBounds = { x: 0, y: 0, width: 48 * 32, height: 28 * 32 };
    const studioBounds = { x: 64, y: 64, width: 18 * 32, height: 12 * 32 };
    const studioSpawn = { x: 368, y: 368 };
    const streetReturn = { x: 784, y: 496 };
    const lifecycle = {
      groundVisible: true,
      doorsVisible: true,
      labelsVisible: true,
      remoteVisible: true,
      roomVisible: false,
      studioVisible: false,
      bodyEnabled: true,
      worldBounds: streetBounds,
      cameraBounds: streetBounds,
      playerPosition: streetReturn,
      figures: new Set<number>(),
      figureCreations: 0,
      figureDestructions: 0,
      destroyCalls: 0,
      selected: 'avatar-1',
      sprite: 'avatar-1',
      tint: avatarPlaceholderTint('avatar-1'),
      resumed: 0,
      operations: [] as string[],
    };
    const presentation = createAvatarStudioPresentation({
      port: {
        setPlayerVelocity: (x, y) => lifecycle.operations.push(`velocity:${x},${y}`),
        setBodyEnabled: (enabled) => {
          lifecycle.bodyEnabled = enabled;
          lifecycle.operations.push(`body:${enabled}`);
        },
        setGroundVisible: (visible) => {
          lifecycle.groundVisible = visible;
          lifecycle.operations.push(`ground:${visible}`);
        },
        setDoorsVisible: (visible) => {
          lifecycle.doorsVisible = visible;
          lifecycle.operations.push(`doors:${visible}`);
        },
        setRemoteVisible: (visible) => {
          lifecycle.remoteVisible = visible;
          lifecycle.operations.push(`remote:${visible}`);
        },
        setLabelsVisible: (visible) => {
          lifecycle.labelsVisible = visible;
          lifecycle.operations.push(`labels:${visible}`);
        },
        setRoomVisible: (visible) => {
          lifecycle.roomVisible = visible;
          lifecycle.operations.push(`room:${visible}`);
        },
        setStudioVisible: (visible) => {
          lifecycle.studioVisible = visible;
          lifecycle.operations.push(`studio:${visible}`);
          if (visible) {
            for (const figure of AVATAR_STUDIO_DEFINITION.figures) {
              if (lifecycle.figures.has(figure.figure)) continue;
              lifecycle.figures.add(figure.figure);
              lifecycle.figureCreations += 1;
            }
          }
        },
        setWorldBounds: (bounds) => {
          lifecycle.worldBounds = bounds;
          lifecycle.operations.push(bounds === studioBounds ? 'world:studio' : 'world:street');
        },
        setCameraBounds: (bounds) => {
          lifecycle.cameraBounds = bounds;
          lifecycle.operations.push(bounds === studioBounds ? 'camera:studio' : 'camera:street');
        },
        setPlayerPosition: (position) => {
          lifecycle.playerPosition = position;
          lifecycle.operations.push(position === studioSpawn ? 'position:studio' : 'position:street');
        },
        resetDoors: () => lifecycle.operations.push('doors:reset'),
        resumeStreet: (_position, report) => {
          lifecycle.resumed += 1;
          lifecycle.operations.push('presence:resume');
          report();
        },
        destroyStudio: () => {
          lifecycle.destroyCalls += 1;
          lifecycle.figureDestructions += lifecycle.figures.size;
          lifecycle.figures.clear();
          lifecycle.operations.push('studio:destroy');
        },
      },
      streetBounds,
      studioBounds,
      studioSpawn,
      streetReturn,
      reportStreet: () => lifecycle.operations.push('street:reported'),
    });
    const controller = createAvatarStudioController({
      out: {
        emit: (event, payload) => {
          lifecycle.operations.push(event);
          if (event === 'avatar:selected') {
            const selected = (payload as WorldEvents['avatar:selected']).sprite;
            lifecycle.sprite = selected;
            lifecycle.tint = avatarPlaceholderTint(selected);
          }
        },
      },
      onEnter: () => presentation.enter(),
      onChange: (state) => {
        lifecycle.selected = state.selected;
      },
      onExit: () => presentation.exit(),
      onDestroy: () => presentation.destroy(),
    });

    controller.enter();
    controller.update({ x: 14, y: 6 });
    controller.update({ x: 8, y: 11 });

    expect(lifecycle.groundVisible).toBe(true);
    expect(lifecycle.doorsVisible).toBe(true);
    expect(lifecycle.labelsVisible).toBe(true);
    expect(lifecycle.remoteVisible).toBe(true);
    expect(lifecycle.roomVisible).toBe(false);
    expect(lifecycle.studioVisible).toBe(false);
    expect(lifecycle.bodyEnabled).toBe(true);
    expect(lifecycle.worldBounds).toBe(streetBounds);
    expect(lifecycle.cameraBounds).toBe(streetBounds);
    expect(lifecycle.playerPosition).toBe(streetReturn);
    expect(lifecycle.resumed).toBe(1);
    expect(lifecycle.figureCreations).toBe(8);
    expect(lifecycle.figures.size).toBe(8);
    expect(lifecycle.operations).toEqual([
      'velocity:0,0',
      'body:false',
      'ground:false',
      'doors:false',
      'remote:false',
      'labels:false',
      'room:false',
      'studio:true',
      'world:studio',
      'camera:studio',
      'position:studio',
      'avatar-studio:entered',
      'avatar:selected',
      'velocity:0,0',
      'body:true',
      'ground:true',
      'doors:true',
      'remote:true',
      'labels:true',
      'room:false',
      'studio:false',
      'world:street',
      'camera:street',
      'position:street',
      'doors:reset',
      'presence:resume',
      'street:reported',
      'avatar-studio:exited',
    ]);

    controller.enter();

    expect(lifecycle.selected).toBe('avatar-8');
    expect(lifecycle.sprite).toBe('avatar-8');
    expect(lifecycle.tint).toBe(avatarPlaceholderTint('avatar-8'));
    expect(lifecycle.groundVisible).toBe(false);
    expect(lifecycle.doorsVisible).toBe(false);
    expect(lifecycle.labelsVisible).toBe(false);
    expect(lifecycle.remoteVisible).toBe(false);
    expect(lifecycle.bodyEnabled).toBe(false);
    expect(lifecycle.worldBounds).toBe(studioBounds);
    expect(lifecycle.cameraBounds).toBe(studioBounds);
    expect(lifecycle.playerPosition).toBe(studioSpawn);
    expect(lifecycle.figureCreations).toBe(8);
    expect(lifecycle.figures.size).toBe(8);
    expect(lifecycle.operations.slice(-12)).toEqual([
      'velocity:0,0',
      'body:false',
      'ground:false',
      'doors:false',
      'remote:false',
      'labels:false',
      'room:false',
      'studio:true',
      'world:studio',
      'camera:studio',
      'position:studio',
      'avatar-studio:entered',
    ]);

    controller.destroy();
    expect(lifecycle.destroyCalls).toBe(1);
    expect(lifecycle.figureDestructions).toBe(8);
    expect(lifecycle.figures.size).toBe(0);
    expect(lifecycle.operations.at(-1)).toBe('studio:destroy');
    // destroy is idempotent and does not duplicate the figure set or emit a
    // late lifecycle event after the scene has been torn down.
    controller.destroy();
    expect(lifecycle.destroyCalls).toBe(1);
    expect(lifecycle.figureDestructions).toBe(8);
    expect(lifecycle.figures.size).toBe(0);
  });
});
