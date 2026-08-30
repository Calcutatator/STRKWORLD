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

  it('keeps suspension retryable when entry setup fails', () => {
    const error = new Error('keyboard capture disable failed');
    const disableGlobalCapture = vi.fn().mockImplementationOnce(() => {
      throw error;
    });
    const keyboard: KeyboardLike = {
      enabled: true,
      disableGlobalCapture,
      enableGlobalCapture: vi.fn(),
      resetKeys: vi.fn(),
    };
    const gate = createInputGate(keyboard);

    expect(() => gate.suspend()).toThrow(error);
    expect(gate.suspended).toBe(false);
    expect(() => gate.suspend()).not.toThrow();
    expect(gate.suspended).toBe(true);
    expect(disableGlobalCapture).toHaveBeenCalledTimes(2);
  });

  it('attempts exit cleanup and input restoration when entry cleanup throws', () => {
    const { keyboard } = fakeKeyboard();
    const gate = createInputGate(keyboard);
    const entryCleanupError = new Error('entry cleanup failed');
    const offEnter = vi.fn(() => { throw entryCleanupError; });
    const offExit = vi.fn();
    const on = vi.fn().mockReturnValueOnce(offEnter).mockReturnValueOnce(offExit);
    const unbind = bindInputGate(gate, on as never);

    gate.suspend();
    expect(() => unbind()).toThrow(entryCleanupError);
    expect(offExit).toHaveBeenCalledOnce();
    expect(gate.suspended).toBe(false);
  });

  it('restores input even when exit cleanup throws', () => {
    const { keyboard } = fakeKeyboard();
    const gate = createInputGate(keyboard);
    const exitCleanupError = new Error('exit cleanup failed');
    const offEnter = vi.fn();
    const offExit = vi.fn(() => { throw exitCleanupError; });
    const on = vi.fn().mockReturnValueOnce(offEnter).mockReturnValueOnce(offExit);
    const unbind = bindInputGate(gate, on as never);

    gate.suspend();
    expect(() => unbind()).toThrow(exitCleanupError);
    expect(gate.suspended).toBe(false);
  });
});

describe('resume', () => {
  it('keeps restoration retryable when keyboard reset fails', () => {
    const resetKeys = vi.fn();
    const keyboard: KeyboardLike = {
      enabled: true,
      disableGlobalCapture: vi.fn(),
      enableGlobalCapture: vi.fn(),
      resetKeys,
    };
    const gate = createInputGate(keyboard);
    gate.suspend();
    resetKeys.mockClear();
    const error = new Error('keyboard reset failed');
    resetKeys.mockImplementationOnce(() => { throw error; });

    expect(() => gate.resume()).toThrow(error);
    expect(gate.suspended).toBe(true);

    expect(() => gate.resume()).not.toThrow();
    expect(gate.suspended).toBe(false);
    expect(keyboard.enabled).toBe(true);
  });

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
