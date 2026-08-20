import { describe, expect, it, vi } from 'vitest';
import type { WorldEvents } from '@strkworld/shared';
import {
  createAvatarOutfitSelection,
  createAvatarOutfitToggleBinding,
} from './avatar-outfit.js';

type Emitted = { event: keyof WorldEvents; payload: unknown };

describe('World-local outfit selection', () => {
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
});

describe('World-local outfit toggle binding', () => {
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
