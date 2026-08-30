import { describe, expect, it, vi } from 'vitest';
import { bindInputGate, createInputGate, type KeyboardLike } from './input-gate.js';

/**
 * These tests encode the "Phaser eats your keystrokes" trap.
 *
 * The failure is silent and total: without the gate, typing an amount into a
 * building panel is impossible — the character never reaches the input and the
 * player walks away while you type. The order of calls is what fixes it, so the
 * order is what is asserted.
 */
function fakeKeyboard() {
  const calls: string[] = [];
  const keyboard: KeyboardLike = {
    enabled: true,
    disableGlobalCapture: () => calls.push('disableGlobalCapture'),
    enableGlobalCapture: () => calls.push('enableGlobalCapture'),
    resetKeys: () => calls.push('resetKeys'),
  };
  // Record assignments too, so ordering covers the whole sequence.
  return {
    keyboard: new Proxy(keyboard, {
      set(target, prop, value) {
        if (prop === 'enabled') calls.push(`enabled=${value}`);
        return Reflect.set(target, prop, value);
      },
    }),
    calls,
  };
}

describe('suspend', () => {
  it('stops capture, then delivery, then clears held keys — in that order', () => {
    const { keyboard, calls } = fakeKeyboard();
    createInputGate(keyboard).suspend();

    // Capture must go first or the DOM never sees the keystroke. resetKeys
    // must go last or a held key survives the suspend.
    expect(calls).toEqual(['disableGlobalCapture', 'enabled=false', 'resetKeys']);
  });

  it('clears held keys, so a key held at suspend does not stay down', () => {
    // Key.isDown is sticky: without resetKeys the player walks off screen the
    // moment input resumes.
    const { keyboard, calls } = fakeKeyboard();
    createInputGate(keyboard).suspend();
    expect(calls).toContain('resetKeys');
  });

  it('is idempotent', () => {
    const { keyboard, calls } = fakeKeyboard();
    const gate = createInputGate(keyboard);
    gate.suspend();
    gate.suspend();
    gate.suspend();
    expect(calls.filter((c) => c === 'disableGlobalCapture')).toHaveLength(1);
  });
});

describe('resume', () => {
  it('clears held keys before re-enabling', () => {
    const { keyboard, calls } = fakeKeyboard();
    const gate = createInputGate(keyboard);
    gate.suspend();
    calls.length = 0;
    gate.resume();

    // A key pressed while a panel was open must not arrive as already-held.
    expect(calls).toEqual(['resetKeys', 'enabled=true', 'enableGlobalCapture']);
  });

  it('is idempotent, and a resume without a suspend does nothing', () => {
    const { keyboard, calls } = fakeKeyboard();
    const gate = createInputGate(keyboard);
    gate.resume();
    expect(calls).toHaveLength(0);
    expect(gate.suspended).toBe(false);
  });

  it('round-trips back to a usable keyboard', () => {
    const { keyboard } = fakeKeyboard();
    const gate = createInputGate(keyboard);
    gate.suspend();
    expect(keyboard.enabled).toBe(false);
    gate.resume();
    expect(keyboard.enabled).toBe(true);
    expect(gate.suspended).toBe(false);
  });
});

describe('binding to building events', () => {
  it('rolls back entry listener when exit registration throws', () => {
    const { keyboard } = fakeKeyboard();
    const gate = createInputGate(keyboard);
    const offEnter = vi.fn();
    const registrationError = new Error('exit listener registration failed');
    const on = vi
      .fn()
      .mockReturnValueOnce(offEnter)
      .mockImplementationOnce(() => {
        throw registrationError;
      });

    expect(() => bindInputGate(gate, on as never)).toThrow(registrationError);
    expect(offEnter).toHaveBeenCalledOnce();
  });

  it('suspends on entry and resumes on exit', () => {
    const { keyboard } = fakeKeyboard();
    const gate = createInputGate(keyboard);
    const handlers: Record<string, () => void> = {};
    const on = (event: string, handler: () => void) => {
      handlers[event] = handler;
      return () => delete handlers[event];
    };

    bindInputGate(gate, on as never);
    handlers['building:entered']!();
    expect(gate.suspended).toBe(true);
    handlers['building:exited']!();
    expect(gate.suspended).toBe(false);
  });

  it('restores input on unbind, even if a panel never emitted its exit', () => {
    // A panel unmounting in an unexpected order must not leave the world
    // permanently unable to receive input.
    const { keyboard } = fakeKeyboard();
    const gate = createInputGate(keyboard);
    const handlers: Record<string, () => void> = {};
    const on = (event: string, handler: () => void) => {
      handlers[event] = handler;
      return () => delete handlers[event];
    };

    const unbind = bindInputGate(gate, on as never);
    handlers['building:entered']!();
    expect(gate.suspended).toBe(true);
    unbind();
    expect(gate.suspended).toBe(false);
  });

  it('unsubscribes both handlers on unbind', () => {
    const { keyboard } = fakeKeyboard();
    const offEnter = vi.fn();
    const offExit = vi.fn();
    const on = vi.fn().mockReturnValueOnce(offEnter).mockReturnValueOnce(offExit);
    const unbind = bindInputGate(createInputGate(keyboard), on as never);
    unbind();
    expect(offEnter).toHaveBeenCalledOnce();
    expect(offExit).toHaveBeenCalledOnce();
  });
});
