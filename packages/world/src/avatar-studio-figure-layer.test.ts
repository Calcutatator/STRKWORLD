import { describe, expect, it, vi } from 'vitest';
import { createAvatarStudioFigureLayer } from './avatar-studio-figure-layer.js';

describe('Avatar Studio final figure layer', () => {
  it('owns the injected room origin after construction', () => {
    const fake = fakeScene();
    const roomOrigin = { x: 64, y: 64 };
    const layer = createAvatarStudioFigureLayer({
      scene: fake.scene as never,
      roomOrigin,
    });

    Reflect.set(roomOrigin, 'x', 1);
    layer.sync({ visible: true, highlightedFigure: 8 });

    expect(fake.highlight.setPosition).toHaveBeenLastCalledWith(528, 272);
  });

  it('renders the eight cosy selectors as non-physics final-sheet sprites at their fixed centres', () => {
    const fake = fakeScene();

    const layer = createAvatarStudioFigureLayer({
      scene: fake.scene as never,
      roomOrigin: { x: 64, y: 64 },
    });
    layer.sync({ visible: true, highlightedFigure: null });

    expect(fake.scene.add.sprite.mock.calls.map((call) => call.slice(0, 4))).toEqual([
      [144, 176, 'avatar-1', 0],
      [240, 176, 'avatar-2', 0],
      [336, 176, 'avatar-3', 0],
      [432, 176, 'avatar-4', 0],
      [528, 176, 'avatar-5', 0],
      [208, 272, 'avatar-6', 0],
      [368, 272, 'avatar-7', 0],
      [528, 272, 'avatar-8', 0],
    ]);
    expect(fake.sprites).toHaveLength(8);
    for (let index = 0; index < fake.sprites.length; index += 1) {
      const sprite = fake.sprites[index]!;
      expect(sprite.setOrigin).toHaveBeenLastCalledWith(0.5, 0.875);
      expect(sprite.setFrame).toHaveBeenLastCalledWith(0);
      expect(sprite.setData).toHaveBeenCalledWith('sprite', `avatar-${index + 1}`);
      expect(sprite.setVisible).toHaveBeenLastCalledWith(true);
      expect(sprite).not.toHaveProperty('body');
    }
  });

  it('moves one separate gold highlight behind the selected figure without tinting avatar art', () => {
    const fake = fakeScene();
    const layer = createAvatarStudioFigureLayer({
      scene: fake.scene as never,
      roomOrigin: { x: 64, y: 64 },
    });

    layer.sync({ visible: true, highlightedFigure: 8 });

    expect(fake.scene.add.rectangle).toHaveBeenCalledWith(0, 0, 24, 24, 0xffd66b, 1);
    expect(fake.highlight.setDepth).toHaveBeenLastCalledWith(2);
    expect(fake.highlight.setPosition).toHaveBeenLastCalledWith(528, 272);
    expect(fake.highlight.setVisible).toHaveBeenLastCalledWith(true);
    for (const sprite of fake.sprites) {
      expect(sprite.setTint).not.toHaveBeenCalled();
      expect(sprite.setDisplaySize).not.toHaveBeenCalled();
    }

    layer.sync({ visible: true, highlightedFigure: 1 });
    expect(fake.scene.add.rectangle).toHaveBeenCalledTimes(1);
    expect(fake.highlight.setPosition).toHaveBeenLastCalledWith(144, 176);
    layer.sync({ visible: false, highlightedFigure: 1 });
    expect(fake.highlight.setVisible).toHaveBeenLastCalledWith(false);
  });

  it('rolls back partial visibility when a figure sync fails', () => {
    const fake = fakeScene();
    const layer = createAvatarStudioFigureLayer({
      scene: fake.scene as never,
      roomOrigin: { x: 64, y: 64 },
    });
    layer.sync({ visible: true, highlightedFigure: null });
    fake.sprites[3]!.setVisible.mockImplementationOnce(() => {
      throw new Error('figure visibility failed');
    });

    expect(() => layer.sync({ visible: false, highlightedFigure: null })).toThrow(
      'figure visibility failed',
    );
    expect(fake.sprites.slice(0, 4).every((sprite) => sprite.visible)).toBe(true);
  });

  it('reuses figures across re-entry and makes teardown idempotent with no late resurrection', () => {
    const fake = fakeScene();
    const layer = createAvatarStudioFigureLayer({
      scene: fake.scene as never,
      roomOrigin: { x: 64, y: 64 },
    });

    layer.sync({ visible: true, highlightedFigure: 1 });
    layer.sync({ visible: false, highlightedFigure: null });
    layer.sync({ visible: true, highlightedFigure: 8 });

    expect(fake.scene.add.sprite).toHaveBeenCalledTimes(8);
    expect(fake.scene.add.rectangle).toHaveBeenCalledTimes(1);
    expect(fake.highlight.setPosition).toHaveBeenLastCalledWith(528, 272);

    layer.destroy();
    layer.destroy();
    for (const sprite of fake.sprites) expect(sprite.destroy).toHaveBeenCalledTimes(1);
    expect(fake.highlight.destroy).toHaveBeenCalledTimes(1);

    const visibilityCalls = fake.sprites.map((sprite) => sprite.setVisible.mock.calls.length);
    const highlightVisibilityCalls = fake.highlight.setVisible.mock.calls.length;
    const highlightPositionCalls = fake.highlight.setPosition.mock.calls.length;

    layer.sync({ visible: true, highlightedFigure: 1 });

    expect(fake.sprites.map((sprite) => sprite.setVisible.mock.calls.length)).toEqual(
      visibilityCalls,
    );
    expect(fake.highlight.setVisible).toHaveBeenCalledTimes(highlightVisibilityCalls);
    expect(fake.highlight.setPosition).toHaveBeenCalledTimes(highlightPositionCalls);
  });

  it.each([
    { failure: 'sprite', options: { failSpriteAt: 4 }, expectedSprites: 3 },
    { failure: 'highlight', options: { failHighlightDepth: true }, expectedSprites: 8 },
  ])(
    'releases every owned object when $failure construction fails',
    ({ options, expectedSprites }) => {
      const fake = fakeScene(options);

      expect(() =>
        createAvatarStudioFigureLayer({
          scene: fake.scene as never,
          roomOrigin: { x: 64, y: 64 },
        }),
      ).toThrow('construction failed');

      expect(fake.sprites).toHaveLength(expectedSprites);
      for (const sprite of fake.sprites) expect(sprite.destroy).toHaveBeenCalledTimes(1);
      if (options.failHighlightDepth) {
        expect(fake.highlight.destroy).toHaveBeenCalledTimes(1);
      } else {
        expect(fake.scene.add.rectangle).not.toHaveBeenCalled();
      }
    },
  );

  it('preserves the construction error while attempting every partial teardown', () => {
    const fake = fakeScene({ failHighlightDepth: true, failSpriteDestroyAt: 1 });

    expect(() =>
      createAvatarStudioFigureLayer({
        scene: fake.scene as never,
        roomOrigin: { x: 64, y: 64 },
      }),
    ).toThrow('construction failed');

    for (const sprite of fake.sprites) expect(sprite.destroy).toHaveBeenCalledTimes(1);
    expect(fake.highlight.destroy).toHaveBeenCalledTimes(1);
  });

  it('attempts every normal teardown and remains idempotent after one failure', () => {
    const fake = fakeScene({ failSpriteDestroyAt: 1 });
    const layer = createAvatarStudioFigureLayer({
      scene: fake.scene as never,
      roomOrigin: { x: 64, y: 64 },
    });

    expect(() => layer.destroy()).toThrow('sprite destroy failed');
    for (const sprite of fake.sprites) expect(sprite.destroy).toHaveBeenCalledTimes(1);
    expect(fake.highlight.destroy).toHaveBeenCalledTimes(1);

    layer.destroy();
    for (const sprite of fake.sprites) expect(sprite.destroy).toHaveBeenCalledTimes(1);
    expect(fake.highlight.destroy).toHaveBeenCalledTimes(1);
  });

  it('aggregates multiple normal teardown failures after all attempts', () => {
    const fake = fakeScene({ failSpriteDestroyAt: 1, failHighlightDestroy: true });
    const layer = createAvatarStudioFigureLayer({
      scene: fake.scene as never,
      roomOrigin: { x: 64, y: 64 },
    });

    expect(() => layer.destroy()).toThrow(AggregateError);
    for (const sprite of fake.sprites) expect(sprite.destroy).toHaveBeenCalledTimes(1);
    expect(fake.highlight.destroy).toHaveBeenCalledTimes(1);
  });
});

function fakeScene(options: {
  failSpriteAt?: number;
  failSpriteDestroyAt?: number;
  failHighlightDepth?: boolean;
  failHighlightDestroy?: boolean;
} = {}) {
  const sprites: Array<ReturnType<typeof fakeSprite>> = [];
  let spriteCount = 0;
  const highlight = fakeHighlight(options.failHighlightDepth === true);
  const scene = {
    add: {
      sprite: vi.fn((x: number, y: number, texture: string, frame: number) => {
        spriteCount += 1;
        if (spriteCount === options.failSpriteAt) throw new Error('construction failed');
        const sprite = fakeSprite(x, y, texture, frame);
        if (spriteCount === options.failSpriteDestroyAt) {
          sprite.destroy.mockImplementationOnce(() => {
            throw new Error('sprite destroy failed');
          });
        }
        sprites.push(sprite);
        return sprite;
      }),
      rectangle: vi.fn(() => highlight),
    },
  };
  if (options.failHighlightDestroy) {
    highlight.destroy.mockImplementationOnce(() => {
      throw new Error('highlight destroy failed');
    });
  }
  return { scene, sprites, highlight };
}

function fakeHighlight(failDepth = false) {
  const highlight = {
    setPosition: vi.fn((_x: number, _y: number) => highlight),
    setDepth: vi.fn((_depth: number) => {
      if (failDepth) throw new Error('construction failed');
      return highlight;
    }),
    setVisible: vi.fn((_visible: boolean) => highlight),
    destroy: vi.fn(),
  };
  return highlight;
}

function fakeSprite(x: number, y: number, texture: string, frame: number) {
  const sprite = {
    x,
    y,
    texture,
    frame,
    visible: false,
    setTexture: vi.fn((_key: string) => sprite),
    setOrigin: vi.fn((_x: number, _y: number) => sprite),
    setVertexRoundMode: vi.fn((_mode: string) => sprite),
    play: vi.fn((_key: string, _ignoreIfPlaying?: boolean) => sprite),
    stop: vi.fn(() => sprite),
    setFrame: vi.fn((nextFrame: number) => {
      sprite.frame = nextFrame;
      return sprite;
    }),
    setData: vi.fn((_key: string, _value: unknown) => sprite),
    setDepth: vi.fn((_depth: number) => sprite),
    setVisible: vi.fn((visible: boolean) => {
      sprite.visible = visible;
      return sprite;
    }),
    setTint: vi.fn((_tint: number) => sprite),
    setDisplaySize: vi.fn((_width: number, _height: number) => sprite),
    destroy: vi.fn(),
  };
  return sprite;
}
