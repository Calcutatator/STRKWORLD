import { describe, expect, it, vi } from 'vitest';
import type { WorldEvents } from '@strkworld/shared';
import {
  createAvatarOutfitSelection,
  createAvatarOutfitToggleBinding,
} from './avatar-outfit.js';

type Emitted = { event: keyof WorldEvents; payload: unknown };

describe('World-local outfit selection', () => {
  it('rolls back selection when avatar change delivery fails', () => {
    let fail = true;
    const error = new Error('avatar selection delivery failed');
    const emit = vi.fn(() => {
      if (fail) throw error;
    });
    const selection = createAvatarOutfitSelection({
      out: { emit },
    });

    expect(() => selection.select('avatar-2')).toThrow(error);
    expect(selection.selected).toBe('avatar-1');

    fail = false;
    expect(selection.select('avatar-2')).toBe(true);
    expect(selection.selected).toBe('avatar-2');
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('rolls back an outer selection when a failed nested selection restores it', () => {
    const nestedError = new Error('nested avatar selection failed');
    let selection!: ReturnType<typeof createAvatarOutfitSelection>;
    const emit = vi.fn((_event: keyof WorldEvents, payload: unknown) => {
      const sprite = (payload as { sprite: string }).sprite;
      if (sprite === 'avatar-2') {
        selection.select('avatar-3');
      } else if (sprite === 'avatar-3') {
        throw nestedError;
      }
    });
    selection = createAvatarOutfitSelection({ out: { emit } });

    expect(() => selection.select('avatar-2')).toThrow(nestedError);
    expect(selection.selected).toBe('avatar-1');
  });

  it('keeps a successful nested selection authoritative when the outer delivery fails', () => {
    const outerError = new Error('outer avatar selection failed');
    let selection!: ReturnType<typeof createAvatarOutfitSelection>;
    const emit = vi.fn((_event: keyof WorldEvents, payload: unknown) => {
      if ((payload as { sprite: string }).sprite === 'avatar-2') {
        expect(selection.select('avatar-3')).toBe(true);
        throw outerError;
      }
    });
    selection = createAvatarOutfitSelection({ out: { emit } });

    expect(() => selection.select('avatar-2')).toThrow(outerError);
    expect(selection.selected).toBe('avatar-3');
  });

  it('keeps a successful nested selection that returns to the outer candidate', () => {
    const outerError = new Error('outer avatar selection failed');
    let selection!: ReturnType<typeof createAvatarOutfitSelection>;
    let nested = false;
    const emit = vi.fn((_event: keyof WorldEvents, payload: unknown) => {
      const sprite = (payload as { sprite: string }).sprite;
      if (sprite === 'avatar-2' && !nested) {
        nested = true;
        expect(selection.select('avatar-3')).toBe(true);
        throw outerError;
      }
      if (sprite === 'avatar-3') {
        expect(selection.select('avatar-2')).toBe(true);
      }
    });
    selection = createAvatarOutfitSelection({ out: { emit } });

    expect(() => selection.select('avatar-2')).toThrow(outerError);
    expect(selection.selected).toBe('avatar-2');
  });

  it('starts on the default cosy state and only emits real changes', () => {
    const events: Emitted[] = [];
    const selection = createAvatarOutfitSelection({
      out: { emit: (event, payload) => events.push({ event, payload }) },
    });

    expect(selection.selected).toBe('avatar-1');
    expect(events).toHaveLength(0);

    expect(selection.select('avatar-1')).toBe(false);
    expect(events).toHaveLength(0);

    expect(selection.select('avatar-6')).toBe(true);
    expect(selection.selected).toBe('avatar-6');
    expect(events).toEqual([{ event: 'avatar:selected', payload: { sprite: 'avatar-6' } }]);
  });

  it('rejects a forged runtime sprite key without changing authority', () => {
    const emit = vi.fn();
    const selection = createAvatarOutfitSelection({ out: { emit } });

    expect(selection.select('avatar-2')).toBe(true);
    emit.mockClear();

    expect(selection.select('not-an-avatar' as never)).toBe(false);
    expect(selection.selected).toBe('avatar-2');
    expect(emit).not.toHaveBeenCalled();
  });

  it('toggles through the existing pairedAvatarSprite mapping and back', () => {
    const events: Emitted[] = [];
    const selection = createAvatarOutfitSelection({
      out: { emit: (event, payload) => events.push({ event, payload }) },
      initial: 'avatar-8',
    });

    selection.toggle();
    expect(selection.selected).toBe('avatar-16');
    selection.toggle();
    expect(selection.selected).toBe('avatar-8');

    selection.select('avatar-3');
    selection.toggle();
    expect(selection.selected).toBe('avatar-11');

    expect(events).toEqual([
      { event: 'avatar:selected', payload: { sprite: 'avatar-16' } },
      { event: 'avatar:selected', payload: { sprite: 'avatar-8' } },
      { event: 'avatar:selected', payload: { sprite: 'avatar-3' } },
      { event: 'avatar:selected', payload: { sprite: 'avatar-11' } },
    ]);
    // Cosmetic only: no stance, outfit, wire, lobby or building field.
    for (const emitted of events) {
      expect(Object.keys(emitted.payload as object)).toEqual(['sprite']);
    }
  });

  it('emits nothing but avatar:selected', () => {
    const events: Emitted[] = [];
    const selection = createAvatarOutfitSelection({
      out: { emit: (event, payload) => events.push({ event, payload }) },
    });
    selection.toggle();
    selection.select('avatar-2');
    expect(new Set(events.map((emitted) => emitted.event))).toEqual(new Set(['avatar:selected']));
  });

  it('retries listener cleanup when the first keyboard off call throws', () => {
    const handlers = new Set<(event: KeyEvent) => void>();
    let attempts = 0;
    const keyboard = {
      on: vi.fn((_event: string, handler: (event: KeyEvent) => void) => {
        handlers.add(handler);
      }),
      off: vi.fn((_event: string, handler: (event: KeyEvent) => void) => {
        attempts += 1;
        if (attempts === 1) throw new Error('keyboard cleanup failed');
        handlers.delete(handler);
      }),
    };
    const binding = createAvatarOutfitToggleBinding({
      keyboard: keyboard as never,
      isActive: () => true,
      toggle: vi.fn(),
    });

    expect(() => binding.destroy()).toThrow('keyboard cleanup failed');
    expect(handlers).toHaveLength(1);

    binding.destroy();
    expect(handlers).toHaveLength(0);
    expect(keyboard.off).toHaveBeenCalledTimes(2);
  });
});

describe('World-local outfit toggle binding', () => {
  it('rolls back a listener when keyboard registration throws after attaching it', () => {
    const registrationError = new Error('keyboard registration failed');
    const handlers = new Set<(event: KeyEvent) => void>();
    const off = vi.fn((_event: string, handler: (event: KeyEvent) => void) => handlers.delete(handler));
    const keyboard = {
      on: vi.fn((_event: string, handler: (event: KeyEvent) => void) => {
        handlers.add(handler);
        throw registrationError;
      }),
      off,
    };
    expect(() => createAvatarOutfitToggleBinding({ keyboard: keyboard as never, isActive: () => true, toggle: vi.fn() }))
      .toThrow(registrationError);
    expect(handlers).toHaveLength(0);
    expect(off).toHaveBeenCalledOnce();
  });
  it('owns exactly one keydown-F listener for its whole lifetime', () => {
    const keyboard = new FakeKeyboard();
    const binding = createAvatarOutfitToggleBinding({
      keyboard,
      isActive: () => true,
      toggle: vi.fn(),
    });

    expect(keyboard.listenerCount('keydown-F')).toBe(1);
    binding.destroy();
    expect(keyboard.listenerCount('keydown-F')).toBe(0);
  });

  it('toggles once per press and ignores repeat and editable targets', () => {
    const keyboard = new FakeKeyboard();
    const toggle = vi.fn();
    createAvatarOutfitToggleBinding({ keyboard, isActive: () => true, toggle });

    keyboard.press({ repeat: false, target: null });
    expect(toggle).toHaveBeenCalledTimes(1);

    keyboard.press({ repeat: true, target: null });
    for (const target of [
      { tagName: 'INPUT' },
      { tagName: 'textarea' },
      { tagName: 'Select' },
      { isContentEditable: true },
      { tagName: 'SPAN', closest: () => ({}) },
    ]) {
      keyboard.press({ repeat: false, target });
    }
    expect(toggle).toHaveBeenCalledTimes(1);

    keyboard.press({ repeat: false, target: { tagName: 'DIV', closest: () => null } });
    expect(toggle).toHaveBeenCalledTimes(2);
  });

  it('stays inactive while World gameplay input is not active', () => {
    const keyboard = new FakeKeyboard();
    const toggle = vi.fn();
    let active = false;
    createAvatarOutfitToggleBinding({ keyboard, isActive: () => active, toggle });

    keyboard.press({ repeat: false, target: null });
    expect(toggle).not.toHaveBeenCalled();
    // The listener stays owned by the Scene rather than being re-registered.
    expect(keyboard.listenerCount('keydown-F')).toBe(1);

    active = true;
    keyboard.press({ repeat: false, target: null });
    expect(toggle).toHaveBeenCalledTimes(1);

    active = false;
    keyboard.press({ repeat: false, target: null });
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it('is inert after destroy, including through a retained stale handler', () => {
    const keyboard = new FakeKeyboard();
    const toggle = vi.fn();
    const binding = createAvatarOutfitToggleBinding({ keyboard, isActive: () => true, toggle });

    const stale = keyboard.snapshot('keydown-F');
    binding.destroy();
    binding.destroy();
    expect(keyboard.listenerCount('keydown-F')).toBe(0);

    keyboard.press({ repeat: false, target: null });
    stale({ repeat: false, target: null });
    expect(toggle).not.toHaveBeenCalled();
  });
});

interface KeyEvent {
  readonly repeat: boolean;
  readonly target: unknown;
}

class FakeKeyboard {
  private readonly listeners = new Map<string, Set<(event: KeyEvent) => void>>();

  on(event: string, handler: (event: KeyEvent) => void): this {
    const handlers = this.listeners.get(event) ?? new Set();
    handlers.add(handler);
    this.listeners.set(event, handlers);
    return this;
  }

  off(event: string, handler: (event: KeyEvent) => void): this {
    this.listeners.get(event)?.delete(handler);
    return this;
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  snapshot(event: string): (event: KeyEvent) => void {
    const handler = this.listeners.get(event)?.values().next().value;
    if (!handler) throw new Error(`Missing ${event} handler`);
    return handler;
  }

  press(event: KeyEvent): void {
    for (const handler of this.listeners.get('keydown-F') ?? []) handler(event);
  }
}
