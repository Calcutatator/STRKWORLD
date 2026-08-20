import { describe, expect, it, vi } from 'vitest';
import { createAvatarStudioToggleBinding } from './avatar-studio-input.js';

describe('Avatar Studio keyboard toggle', () => {
  it('owns keydown-F only while active and ignores repeat or editable targets', () => {
    const keyboard = new FakeKeyboard();
    const toggle = vi.fn();
    const binding = createAvatarStudioToggleBinding({ keyboard, toggle });

    expect(keyboard.listenerCount('keydown-F')).toBe(0);
    binding.setActive(true);
    binding.setActive(true);
    expect(keyboard.listenerCount('keydown-F')).toBe(1);

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

    keyboard.press({
      repeat: false,
      target: { tagName: 'DIV', closest: () => null },
    });
    expect(toggle).toHaveBeenCalledTimes(2);

    const staleHandler = keyboard.snapshot('keydown-F');
    binding.setActive(false);
    expect(keyboard.listenerCount('keydown-F')).toBe(0);
    keyboard.press({ repeat: false, target: null });
    staleHandler({ repeat: false, target: null });
    expect(toggle).toHaveBeenCalledTimes(2);

    binding.setActive(true);
    expect(keyboard.listenerCount('keydown-F')).toBe(1);
    const lateHandler = keyboard.snapshot('keydown-F');
    binding.destroy();
    binding.destroy();
    expect(keyboard.listenerCount('keydown-F')).toBe(0);
    binding.setActive(true);
    expect(keyboard.listenerCount('keydown-F')).toBe(0);
    keyboard.press({ repeat: false, target: null });
    lateHandler({ repeat: false, target: null });
    expect(toggle).toHaveBeenCalledTimes(2);
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
