import { describe, expect, it, vi } from 'vitest';
import type { AvatarSpriteKey, EventBus, WorldEvents } from '@strkworld/shared';
import { createAvatarOutfitSelection } from './avatar-outfit.js';
import {
  AVATAR_STUDIO_DEFINITION,
  AVATAR_STUDIO_TILE_SIZE,
  avatarStudioFigureAt,
  avatarStudioSpawnToWorld,
  avatarStudioTileColour,
  createAvatarStudioPresentation,
  createAvatarStudioController,
  isAvatarStudioSolidAt,
  type AvatarStudioDefinition,
  type AvatarStudioFigure,
  type AvatarStudioState,
  type AvatarStudioPresentationPort,
  validateAvatarStudioDefinition,
} from './avatar-studio.js';
import { createStreetMap, tileToWorld } from './map/street.js';

type Emitted = { [K in keyof WorldEvents]: { event: K; payload: WorldEvents[K] } }[keyof WorldEvents];

describe('hidden Avatar Studio', () => {
  it('retries presentation cleanup after a failed destroy', () => {
    const cleanupError = new Error('studio cleanup failed');
    const destroyStudio = vi.fn().mockImplementationOnce(() => { throw cleanupError; });
    const noop = vi.fn();
    const presentation = createAvatarStudioPresentation({
      port: {
        setPlayerVelocity: noop,
        setBodyEnabled: noop,
        setGroundVisible: noop,
        setDoorsVisible: noop,
        setRemoteVisible: noop,
        setLabelsVisible: noop,
        setRoomVisible: noop,
        setStudioVisible: noop,
        setWorldBounds: noop,
        setCameraBounds: noop,
        setPlayerPosition: noop,
        resetDoors: noop,
        resumeStreet: noop,
        destroyStudio,
      },
      streetBounds: { x: 0, y: 0, width: 10, height: 10 },
      studioBounds: { x: 1, y: 1, width: 10, height: 10 },
      studioSpawn: { x: 5, y: 5 },
      streetReturn: { x: 2, y: 2 },
      reportStreet: noop,
    });

    expect(() => presentation.destroy()).toThrow(cleanupError);
    expect(() => presentation.destroy()).not.toThrow();
    expect(destroyStudio).toHaveBeenCalledTimes(2);
  });
  it('stops an enter transition when a presentation callback destroys it', () => {
    let presentation!: ReturnType<typeof createAvatarStudioPresentation>;
    const destroyStudio = vi.fn();
    const setWorldBounds = vi.fn();
    const port: AvatarStudioPresentationPort = {
      setPlayerVelocity: vi.fn(),
      setBodyEnabled: vi.fn(),
      setGroundVisible: vi.fn(),
      setDoorsVisible: vi.fn(),
      setRemoteVisible: vi.fn(),
      setLabelsVisible: vi.fn(),
      setRoomVisible: vi.fn(),
      setStudioVisible: vi.fn(() => presentation.destroy()),
      setWorldBounds,
      setCameraBounds: vi.fn(),
      setPlayerPosition: vi.fn(),
      resetDoors: vi.fn(),
      resumeStreet: vi.fn(),
      destroyStudio,
    };
    presentation = createAvatarStudioPresentation({
      port,
      streetBounds: { x: 0, y: 0, width: 10, height: 10 },
      studioBounds: { x: 1, y: 1, width: 10, height: 10 },
      studioSpawn: { x: 5, y: 5 },
      streetReturn: { x: 2, y: 2 },
      reportStreet: vi.fn(),
    });

    presentation.enter();

    expect(destroyStudio).toHaveBeenCalledOnce();
    expect(setWorldBounds).not.toHaveBeenCalled();
    expect(port.setCameraBounds).not.toHaveBeenCalled();
    expect(port.setPlayerPosition).not.toHaveBeenCalled();
  });

  it('has a fixed 18x12 envelope, eight cosy figures and no building/station seam', () => {
    expect(AVATAR_STUDIO_DEFINITION).toMatchObject({
      width: 18,
      height: 12,
      spawn: { x: 9, y: 1 },
      exit: { x: 8, y: 0, width: 2, height: 1 },
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

  it('derives the interior pixel spawn from the validated top-opening definition', () => {
    expect(
      avatarStudioSpawnToWorld(AVATAR_STUDIO_DEFINITION, { x: 64, y: 64 }, 32),
    ).toEqual({ x: 368, y: 112 });
  });

  it('rejects overlapping selector rectangles that would make a later figure unreachable', () => {
    const figures: AvatarStudioFigure[] = AVATAR_STUDIO_DEFINITION.figures.map(
      (figure) => ({ ...figure }),
    );
    figures[0] = { ...figures[0]!, width: 2 };
    figures[1] = { ...figures[1]!, x: 3, y: 3 };

    expect(() => validateAvatarStudioDefinition(authoredDefinition({ figures }))).toThrow(
      /figures must not overlap/i,
    );
  });

  it('requires exactly eight well-formed in-bounds selector rectangles', () => {
    expect(() =>
      validateAvatarStudioDefinition(authoredDefinition({
        figures: AVATAR_STUDIO_DEFINITION.figures.slice(0, 7),
      })),
    ).toThrow(/exactly eight figures/i);

    for (const malformed of [
      { x: 2.5 },
      { width: 0 },
      { x: AVATAR_STUDIO_DEFINITION.width },
    ]) {
      const figures: AvatarStudioFigure[] = AVATAR_STUDIO_DEFINITION.figures.map(
        (figure) => ({ ...figure }),
      );
      figures[0] = { ...figures[0]!, ...malformed };
      expect(() => validateAvatarStudioDefinition(authoredDefinition({ figures }))).toThrow(
        /figures must be in-bounds and off the exit/i,
      );
    }
  });

  it.each([
    ['left', { x: 0, y: 3 }],
    ['right', { x: AVATAR_STUDIO_DEFINITION.width - 1, y: 3 }],
    ['top', { x: 2, y: 0 }],
    ['bottom', { x: 2, y: AVATAR_STUDIO_DEFINITION.height - 1 }],
  ])('rejects a selector on the solid %s border', (_border, position) => {
    const figures: AvatarStudioFigure[] = AVATAR_STUDIO_DEFINITION.figures.map(
      (figure) => ({ ...figure }),
    );
    figures[0] = { ...figures[0]!, ...position };

    expect(() => validateAvatarStudioDefinition(authoredDefinition({ figures }))).toThrow(
      /strictly inside the walkable interior/i,
    );
  });

  it.each([
    ['a fractional coordinate', { x: 9.5, y: 1 }],
    ['the solid room border', { x: 0, y: 9 }],
    ['the exit opening', { x: 8, y: 0 }],
    ['a selector rectangle', { x: 2, y: 3 }],
  ])('rejects a spawn on %s', (_label, spawn) => {
    expect(() => validateAvatarStudioDefinition(authoredDefinition({ spawn }))).toThrow(
      /spawn must be a walkable interior tile off the exit and figures/i,
    );
  });

  it.each([
    ['one tile sideways from the opening centre', { x: 8, y: 1 }],
    ['two rows inside the room', { x: 9, y: 2 }],
  ])('rejects a spawn %s', (_label, spawn) => {
    expect(() => validateAvatarStudioDefinition(authoredDefinition({ spawn }))).toThrow(
      /spawn must be immediately inside the centred top opening/i,
    );
  });

  it.each([
    ['below the top border', { x: 8, y: 1, width: 2, height: 1 }],
    ['only one tile wide', { x: 8, y: 0, width: 1, height: 1 }],
    ['two tiles deep', { x: 8, y: 0, width: 2, height: 2 }],
    ['off centre', { x: 7, y: 0, width: 2, height: 1 }],
  ])('rejects an exit %s', (_label, exit) => {
    expect(() => validateAvatarStudioDefinition(authoredDefinition({ exit }))).toThrow(
      /exit must be a centred two-tile top-border opening/i,
    );
  });

  it('selects a cosy figure on contact and exits upward through the top opening', () => {
    const events: Emitted[] = [];
    const out: Pick<EventBus<WorldEvents>, 'emit'> = {
      emit: (event, payload) => events.push({ event, payload } as Emitted),
    };
    const controller = createAvatarStudioController({
      out,
      selection: createAvatarOutfitSelection({ out }),
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

    controller.update({ x: 8, y: 0 });
    expect(controller.state.inRoom).toBe(false);
    expect(events.at(-1)).toEqual({ event: 'avatar-studio:exited', payload: {} });
  });

  it('does not select a figure after onChange destroys the controller', () => {
    const events: Emitted[] = [];
    const out: Pick<EventBus<WorldEvents>, 'emit'> = {
      emit: (event, payload) => events.push({ event, payload } as Emitted),
    };
    const selection = createAvatarOutfitSelection({ out });
    let controller!: ReturnType<typeof createAvatarStudioController>;
    controller = createAvatarStudioController({
      out,
      selection,
      onChange: (state) => {
        if (state.highlightedFigure === 8) controller.destroy();
      },
    });

    controller.enter();
    controller.update({ x: 14, y: 6 });

    expect(controller.state.inRoom).toBe(false);
    expect(selection.selected).toBe('avatar-1');
    expect(events.filter((event) => event.event === 'avatar:selected')).toEqual([]);
  });

  it('does not publish after avatar selection destroys the controller', () => {
    const snapshots: AvatarStudioState[] = [];
    const out: Pick<EventBus<WorldEvents>, 'emit'> = {
      emit: (event) => {
        if (event === 'avatar:selected') controller.destroy();
      },
    };
    const selection = createAvatarOutfitSelection({ out });
    let controller!: ReturnType<typeof createAvatarStudioController>;
    controller = createAvatarStudioController({
      out,
      selection,
      onChange: (state) => snapshots.push(state),
    });

    controller.enter();
    snapshots.length = 0;
    controller.update({ x: 14, y: 6 });

    expect(selection.selected).toBe('avatar-8');
    expect(controller.state.inRoom).toBe(false);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ highlightedFigure: 8, inRoom: true });
  });

  it('does not publish or announce entry after onEnter destroys the controller', () => {
    const events: Emitted[] = [];
    const snapshots: AvatarStudioState[] = [];
    const out: Pick<EventBus<WorldEvents>, 'emit'> = {
      emit: (event, payload) => events.push({ event, payload } as Emitted),
    };
    let controller!: ReturnType<typeof createAvatarStudioController>;
    controller = createAvatarStudioController({
      out,
      selection: createAvatarOutfitSelection({ out }),
      onEnter: () => controller.destroy(),
      onChange: (state) => snapshots.push(state),
    });

    controller.enter();

    expect(controller.state.inRoom).toBe(false);
    expect(snapshots).toEqual([]);
    expect(events).toEqual([]);
  });

  it('does not publish or announce exit after onExit destroys the controller', () => {
    const events: Emitted[] = [];
    const snapshots: AvatarStudioState[] = [];
    const out: Pick<EventBus<WorldEvents>, 'emit'> = {
      emit: (event, payload) => events.push({ event, payload } as Emitted),
    };
    let controller!: ReturnType<typeof createAvatarStudioController>;
    controller = createAvatarStudioController({
      out,
      selection: createAvatarOutfitSelection({ out }),
      onExit: () => controller.destroy(),
      onChange: (state) => snapshots.push(state),
    });

    controller.enter();
    events.length = 0;
    snapshots.length = 0;
    controller.update({ x: AVATAR_STUDIO_DEFINITION.exit.x, y: AVATAR_STUDIO_DEFINITION.exit.y });

    expect(controller.state.inRoom).toBe(false);
    expect(snapshots).toEqual([]);
    expect(events).toEqual([]);
  });

  it('reads and writes the Scene\'s outfit selection rather than its own copy', () => {
    // D-053: F is a Scene-owned binding. The Studio must therefore never hold
    // a second copy of the selection — it would go stale the moment the outfit
    // changed outdoors, and the next press would emit a state the avatar is
    // already in.
    const events: Emitted[] = [];
    const out: Pick<EventBus<WorldEvents>, 'emit'> = {
      emit: (event, payload) => events.push({ event, payload } as Emitted),
    };
    const selection = createAvatarOutfitSelection({ out });
    const controller = createAvatarStudioController({ out, selection });

    // A toggle before entry (outdoors) is visible to the Studio on entry.
    selection.toggle();
    expect(controller.state.selected).toBe('avatar-9');
    controller.enter();
    expect(controller.state.selected).toBe('avatar-9');

    // Figure contact writes through to the shared selection.
    controller.update({ x: 2, y: 3 });
    expect(selection.selected).toBe('avatar-1');
    expect(controller.state.selected).toBe('avatar-1');
    expect(events.at(-1)).toEqual({
      event: 'avatar:selected',
      payload: { sprite: 'avatar-1' },
    });

    // Standing on the same figure again is not a change and emits nothing.
    const settled = events.length;
    controller.update({ x: 2, y: 3 });
    expect(events).toHaveLength(settled);

    // The selection outlives the Studio: leaving, and even destroying it,
    // leaves the local avatar's outfit intact and still changeable.
    controller.update({ x: 8, y: 0 });
    controller.destroy();
    selection.toggle();
    expect(selection.selected).toBe('avatar-9');
  });

  it('moves down from the interior spawn and exits only after moving back up through the opening', () => {
    const operations: string[] = [];
    const playerPositions: Array<{ x: number; y: number }> = [];
    const map = createStreetMap();
    const streetReturn = tileToWorld(map.spawn.x, map.spawn.y);
    const studioSpawn = avatarStudioSpawnToWorld(
      AVATAR_STUDIO_DEFINITION,
      { x: 64, y: 64 },
      AVATAR_STUDIO_TILE_SIZE,
    );
    const noop = (): void => {};
    const port: AvatarStudioPresentationPort = {
      setPlayerVelocity: noop,
      setBodyEnabled: noop,
      setGroundVisible: noop,
      setDoorsVisible: noop,
      setRemoteVisible: noop,
      setLabelsVisible: noop,
      setRoomVisible: noop,
      setStudioVisible: noop,
      setWorldBounds: noop,
      setCameraBounds: noop,
      setPlayerPosition: (position) => {
        playerPositions.push(position);
        operations.push(position === streetReturn ? 'position:street' : 'position:studio');
      },
      resetDoors: () => operations.push('doors:reset'),
      resumeStreet: (position, report) => {
        expect(position).toBe(streetReturn);
        operations.push('presence:resume');
        report();
      },
      destroyStudio: noop,
    };
    const presentation = createAvatarStudioPresentation({
      port,
      streetBounds: { x: 0, y: 0, width: map.width * 32, height: map.height * 32 },
      studioBounds: { x: 64, y: 64, width: 18 * 32, height: 12 * 32 },
      studioSpawn,
      streetReturn,
      reportStreet: () => operations.push('street:reported'),
    });
    const presentationOut: Pick<EventBus<WorldEvents>, 'emit'> = {
      emit: (event) => operations.push(event),
    };
    const controller = createAvatarStudioController({
      out: presentationOut,
      selection: createAvatarOutfitSelection({ out: presentationOut }),
      onEnter: () => presentation.enter(),
      onExit: () => presentation.exit(),
    });

    controller.enter();
    expect(playerPositions.at(-1)).toEqual({ x: 368, y: 112 });
    expect(AVATAR_STUDIO_DEFINITION.spawn.y).toBe(
      AVATAR_STUDIO_DEFINITION.exit.y + AVATAR_STUDIO_DEFINITION.exit.height,
    );

    controller.update({
      x: AVATAR_STUDIO_DEFINITION.spawn.x,
      y: AVATAR_STUDIO_DEFINITION.spawn.y + 1,
    });
    expect(controller.state.inRoom).toBe(true);
    controller.update(AVATAR_STUDIO_DEFINITION.spawn);
    expect(controller.state.inRoom).toBe(true);
    controller.update({
      x: AVATAR_STUDIO_DEFINITION.exit.x + 1,
      y: AVATAR_STUDIO_DEFINITION.exit.y,
    });

    expect(controller.state.inRoom).toBe(false);
    expect(playerPositions.at(-1)).toBe(streetReturn);
    expect(operations.slice(-5)).toEqual([
      'position:street',
      'doors:reset',
      'presence:resume',
      'street:reported',
      'avatar-studio:exited',
    ]);

    const operationsAfterExit = operations.length;
    controller.update({
      x: AVATAR_STUDIO_DEFINITION.exit.x + 1,
      y: AVATAR_STUDIO_DEFINITION.exit.y,
    });
    expect(controller.state.inRoom).toBe(false);
    expect(operations).toHaveLength(operationsAfterExit);
    expect(operations.filter((operation) => operation === 'avatar-studio:entered')).toHaveLength(1);
  });

  it('keeps the room border solid except for the two-tile exit', () => {
    expect(isAvatarStudioSolidAt(AVATAR_STUDIO_DEFINITION, 0, 0)).toBe(true);
    expect(isAvatarStudioSolidAt(AVATAR_STUDIO_DEFINITION, 8, 0)).toBe(false);
    expect(isAvatarStudioSolidAt(AVATAR_STUDIO_DEFINITION, 9, 0)).toBe(false);
    expect(isAvatarStudioSolidAt(AVATAR_STUDIO_DEFINITION, 9, 1)).toBe(false);
    expect(isAvatarStudioSolidAt(AVATAR_STUDIO_DEFINITION, 9, 11)).toBe(true);
  });

  it('renders the walkable top exit as an opening rather than a wall', () => {
    expect(avatarStudioTileColour(AVATAR_STUDIO_DEFINITION, 8, 0)).toBe(0x8a7c62);
    expect(avatarStudioTileColour(AVATAR_STUDIO_DEFINITION, 9, 0)).toBe(0x8a7c62);
    expect(avatarStudioTileColour(AVATAR_STUDIO_DEFINITION, 0, 0)).toBe(0x39343b);
  });

  it('supports enter/select/exit/re-enter/shutdown through one lifecycle seam', () => {
    const streetBounds = { x: 0, y: 0, width: 48 * 32, height: 28 * 32 };
    const studioBounds = { x: 64, y: 64, width: 18 * 32, height: 12 * 32 };
    const studioSpawn = avatarStudioSpawnToWorld(
      AVATAR_STUDIO_DEFINITION,
      { x: 64, y: 64 },
      32,
    );
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
    const lifecycleOut: Pick<EventBus<WorldEvents>, 'emit'> = {
      emit: (event, payload) => {
        lifecycle.operations.push(event);
        if (event === 'avatar:selected') {
          const selected = (payload as WorldEvents['avatar:selected']).sprite;
          lifecycle.sprite = selected;
        }
      },
    };
    const controller = createAvatarStudioController({
      out: lifecycleOut,
      selection: createAvatarOutfitSelection({ out: lifecycleOut }),
      onEnter: () => presentation.enter(),
      onChange: (state) => {
        lifecycle.selected = state.selected;
      },
      onExit: () => presentation.exit(),
      onDestroy: () => presentation.destroy(),
    });

    controller.enter();
    controller.update({ x: 14, y: 6 });
    controller.update({ x: 8, y: 0 });

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

function authoredDefinition(
  overrides: Partial<AvatarStudioDefinition>,
): AvatarStudioDefinition {
  return {
    ...AVATAR_STUDIO_DEFINITION,
    figures: AVATAR_STUDIO_DEFINITION.figures.map((figure) => ({ ...figure })),
    ...overrides,
  };
}
