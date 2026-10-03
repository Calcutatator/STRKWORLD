import { describe, expect, it, vi } from 'vitest';
import { createDomKeyboard, type DomEventHost } from './dom-keyboard.js';
import { createInputGate } from './input-gate.js';

type Listener = Parameters<DomEventHost['addEventListener']>[1];

function fakeHost(): DomEventHost & {
  dispatch(type: string, event?: Record<string, unknown>): void;
  count(type: string): number;
  visibilityState?: string;
} {
  const listeners = new Map<string, Set<Listener>>();
  return {
    addEventListener(type, listener) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatch(type, event = {}) {
      for (const listener of [...(listeners.get(type) ?? [])]) listener(event);
    },
    count(type) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

function key(code: string, extra: Record<string, unknown> = {}) {
  return { code, repeat: false, target: null, preventDefault: vi.fn(), ...extra };
}

function setup() {
  const window = fakeHost();
  const document = fakeHost();
  const keyboard = createDomKeyboard({ window, document });
  return { window, document, keyboard };
}

describe('DOM World keyboard', () => {
  it('merges arrows and WASD into held movement', () => {
    const { window, keyboard } = setup();
    window.dispatch('keydown', key('ArrowUp'));
    window.dispatch('keydown', key('KeyD'));
    expect(keyboard.held).toEqual({ up: true, down: false, left: false, right: true });
    window.dispatch('keyup', key('ArrowUp'));
    expect(keyboard.held).toEqual({ up: false, down: false, left: false, right: true });
  });

  it('reads either Shift key as sprint', () => {
    const { window, keyboard } = setup();
    window.dispatch('keydown', key('ShiftRight'));
    expect(keyboard.sprinting).toBe(true);
    window.dispatch('keyup', key('ShiftRight'));
    expect(keyboard.sprinting).toBe(false);
  });

  it('delivers and reads nothing while disabled', () => {
    const { window, keyboard } = setup();
    window.dispatch('keydown', key('KeyW'));
    keyboard.enabled = false;
    expect(keyboard.held.up).toBe(false);
    window.dispatch('keydown', key('KeyS'));
    keyboard.enabled = true;
    // W was held before the gate closed and was never released; S arrived
    // while disabled and must not have been recorded.
    expect(keyboard.held).toEqual({ up: true, down: false, left: false, right: false });
  });

  it('captures World keys only while global capture is on', () => {
    const { window, keyboard } = setup();
    const captured = key('ArrowDown');
    window.dispatch('keydown', captured);
    expect(captured.preventDefault).toHaveBeenCalledOnce();

    keyboard.disableGlobalCapture();
    const released = key('ArrowLeft');
    window.dispatch('keydown', released);
    expect(released.preventDefault).not.toHaveBeenCalled();

    const letter = key('KeyQ');
    keyboard.enableGlobalCapture();
    window.dispatch('keydown', letter);
    expect(letter.preventDefault).not.toHaveBeenCalled();
  });

  it('never reads a keystroke aimed at an editable element as movement', () => {
    const { window, keyboard } = setup();
    const typed = key('KeyW', { target: { tagName: 'INPUT' } });
    window.dispatch('keydown', typed);
    expect(keyboard.held.up).toBe(false);
    expect(typed.preventDefault).not.toHaveBeenCalled();
    window.dispatch('keydown', key('KeyA', { target: { isContentEditable: true } }));
    window.dispatch('keydown', key('KeyS', { target: { closest: () => ({}) } }));
    expect(keyboard.held).toEqual({ up: false, down: false, left: false, right: false });
  });

  it('honours a release over any target, so keys cannot stick behind a panel', () => {
    const { window, keyboard } = setup();
    window.dispatch('keydown', key('KeyD'));
    window.dispatch('keyup', key('KeyD', { target: { tagName: 'TEXTAREA' } }));
    expect(keyboard.held.right).toBe(false);
  });

  it('clears held keys on window blur and when the tab is hidden', () => {
    const { window, document, keyboard } = setup();
    window.dispatch('keydown', key('KeyW'));
    window.dispatch('blur');
    expect(keyboard.held.up).toBe(false);

    window.dispatch('keydown', key('KeyA'));
    document.visibilityState = 'visible';
    document.dispatch('visibilitychange');
    expect(keyboard.held.left).toBe(true);
    document.visibilityState = 'hidden';
    document.dispatch('visibilitychange');
    expect(keyboard.held.left).toBe(false);
  });

  it('emits keydown-F with the native repeat and target only while enabled', () => {
    const { window, keyboard } = setup();
    const handler = vi.fn();
    keyboard.on('keydown-F', handler);
    const target = { tagName: 'DIV' };
    window.dispatch('keydown', key('KeyF', { repeat: true, target }));
    expect(handler).toHaveBeenCalledWith({ repeat: true, target });

    keyboard.enabled = false;
    window.dispatch('keydown', key('KeyF'));
    expect(handler).toHaveBeenCalledOnce();

    keyboard.enabled = true;
    keyboard.off('keydown-F', handler);
    window.dispatch('keydown', key('KeyF'));
    expect(handler).toHaveBeenCalledOnce();
  });

  it('runs every F handler before surfacing a handler failure', () => {
    const { window, keyboard } = setup();
    const failure = new Error('shell delivery failed');
    const later = vi.fn();
    keyboard.on('keydown-F', () => {
      throw failure;
    });
    keyboard.on('keydown-F', later);
    expect(() => window.dispatch('keydown', key('KeyF'))).toThrow(failure);
    expect(later).toHaveBeenCalledOnce();
  });

  it('satisfies the input gate contract: suspend releases capture, delivery and held state', () => {
    const { window, keyboard } = setup();
    const gate = createInputGate(keyboard);
    window.dispatch('keydown', key('KeyW'));

    gate.suspend();
    expect(keyboard.enabled).toBe(false);
    expect(keyboard.held.up).toBe(false);
    const typed = key('ArrowUp');
    window.dispatch('keydown', typed);
    expect(typed.preventDefault).not.toHaveBeenCalled();

    gate.resume();
    expect(keyboard.enabled).toBe(true);
    // Held state was cleared by the suspend; nothing walks on resume.
    expect(keyboard.held).toEqual({ up: false, down: false, left: false, right: false });
  });

  it('leaves browser chords alone: nothing held, captured or emitted with Ctrl, Cmd or Alt', () => {
    const { window, keyboard } = setup();
    const outfit = vi.fn();
    keyboard.on('keydown-F', outfit);
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) {
      const chord = key('ArrowLeft', { [modifier]: true });
      window.dispatch('keydown', chord);
      expect(chord.preventDefault).not.toHaveBeenCalled();
      window.dispatch('keydown', key('KeyF', { [modifier]: true }));
    }
    expect(keyboard.held.left).toBe(false);
    expect(outfit).not.toHaveBeenCalled();
    // Shift is sprint, not a browser chord.
    window.dispatch('keydown', key('ArrowLeft', { shiftKey: true }));
    expect(keyboard.held.left).toBe(true);
  });

  it('ignores a key the Shell already handled', () => {
    const { window, keyboard } = setup();
    const handled = key('KeyW', { defaultPrevented: true });
    window.dispatch('keydown', handled);
    expect(keyboard.held.up).toBe(false);
    expect(handled.preventDefault).not.toHaveBeenCalled();
  });

  it('treats an input inside a shadow root as editable', () => {
    const { window, keyboard } = setup();
    const shadowInput = { tagName: 'INPUT' };
    window.dispatch('keydown', key('KeyS', {
      target: { tagName: 'MY-WIDGET' },
      composedPath: () => [shadowInput, { tagName: 'MY-WIDGET' }],
    }));
    expect(keyboard.held.down).toBe(false);
  });

  it('emits keydown-E for the sandbox block key with the same guards as F', () => {
    const { window, keyboard } = setup();
    const block = vi.fn();
    const outfit = vi.fn();
    keyboard.on('keydown-E', block);
    keyboard.on('keydown-F', outfit);
    window.dispatch('keydown', key('KeyE'));
    expect(block).toHaveBeenCalledWith({ repeat: false, target: null });
    expect(outfit).not.toHaveBeenCalled();
    window.dispatch('keydown', key('KeyE', { target: { tagName: 'INPUT' } }));
    keyboard.enabled = false;
    window.dispatch('keydown', key('KeyE'));
    expect(block).toHaveBeenCalledOnce();
    keyboard.enabled = true;
    keyboard.off('keydown-E', block);
    window.dispatch('keydown', key('KeyE'));
    expect(block).toHaveBeenCalledOnce();
  });

  it('emits keydown-Space for the jump (D-097), never from a text field or a disabled keyboard', () => {
    const { window, keyboard } = setup();
    const jump = vi.fn();
    keyboard.on('keydown-Space', jump);
    const press = key('Space');
    window.dispatch('keydown', press);
    expect(jump).toHaveBeenCalledWith({ repeat: false, target: null });
    // Space is captured, so the page does not scroll under the World.
    expect(press.preventDefault).toHaveBeenCalled();
    window.dispatch('keydown', key('Space', { repeat: true }));
    expect(jump).toHaveBeenLastCalledWith({ repeat: true, target: null });
    window.dispatch('keydown', key('Space', { target: { tagName: 'INPUT' } }));
    window.dispatch('keydown', key('Space', { target: { tagName: 'TEXTAREA' } }));
    keyboard.enabled = false;
    window.dispatch('keydown', key('Space'));
    expect(jump).toHaveBeenCalledTimes(2);
    keyboard.enabled = true;
    // A suspended keyboard (a panel open) hands Space to the page untouched.
    keyboard.disableGlobalCapture();
    const typed = key('Space');
    window.dispatch('keydown', typed);
    expect(typed.preventDefault).not.toHaveBeenCalled();
  });

  it('emits keydown-Q for the arena block (D-128), with the same guards as E', () => {
    const { window, keyboard } = setup();
    const down = vi.fn();
    const up = vi.fn();
    keyboard.on('keydown-Q', down);
    keyboard.on('keyup-Q', up);
    window.dispatch('keydown', key('KeyQ'));
    expect(down).toHaveBeenCalledWith({ repeat: false, target: null });
    window.dispatch('keyup', key('KeyQ'));
    expect(up).toHaveBeenCalledWith({ repeat: false, target: null });
    // Never from a text field: a player typing "q" does not raise a guard.
    window.dispatch('keydown', key('KeyQ', { target: { tagName: 'INPUT' } }));
    window.dispatch('keydown', key('KeyQ', { target: { tagName: 'TEXTAREA' } }));
    expect(down).toHaveBeenCalledTimes(1);
    // Nor from a disabled keyboard.
    keyboard.enabled = false;
    window.dispatch('keydown', key('KeyQ'));
    expect(down).toHaveBeenCalledTimes(1);
  });

  it('releases Q over any target, but only one this keyboard saw go down', () => {
    const { window, keyboard } = setup();
    const up = vi.fn();
    keyboard.on('keyup-Q', up);
    // Nothing went down here, so there is no guard of ours to lower.
    window.dispatch('keyup', key('KeyQ'));
    expect(up).not.toHaveBeenCalled();
    // Held in the World, let go over a panel: the release still arrives, or
    // the block would stick up for ever.
    window.dispatch('keydown', key('KeyQ'));
    window.dispatch('keyup', key('KeyQ', { target: { tagName: 'INPUT' } }));
    expect(up).toHaveBeenCalledTimes(1);
    // And only once: the key is no longer held.
    window.dispatch('keyup', key('KeyQ'));
    expect(up).toHaveBeenCalledTimes(1);
  });

  it('lowers a held Q on blur, on a hidden tab and on resetKeys', () => {
    for (const drop of ['blur', 'hidden', 'reset'] as const) {
      const window = fakeHost();
      const document = fakeHost();
      const keyboard = createDomKeyboard({ window, document });
      const up = vi.fn();
      keyboard.on('keyup-Q', up);
      window.dispatch('keydown', key('KeyQ'));
      if (drop === 'blur') window.dispatch('blur');
      else if (drop === 'hidden') {
        document.visibilityState = 'hidden';
        document.dispatch('visibilitychange');
      } else keyboard.resetKeys();
      expect(up).toHaveBeenCalledWith({ repeat: false, target: null });
      // The key is no longer held, so nothing is released twice.
      keyboard.resetKeys();
      expect(up).toHaveBeenCalledTimes(1);
    }
  });

  it('detaches every listener on destroy and stays inert', () => {
    const { window, document, keyboard } = setup();
    const handler = vi.fn();
    keyboard.on('keydown-F', handler);
    keyboard.destroy();
    keyboard.destroy();
    expect(window.count('keydown')).toBe(0);
    expect(window.count('keyup')).toBe(0);
    expect(window.count('blur')).toBe(0);
    expect(document.count('visibilitychange')).toBe(0);
    window.dispatch('keydown', key('KeyF'));
    expect(handler).not.toHaveBeenCalled();
    expect(keyboard.held.up).toBe(false);
    expect(keyboard.sprinting).toBe(false);
  });
});
