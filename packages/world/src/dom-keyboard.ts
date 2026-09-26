import type { MovementInput } from './street-movement.js';
import type { WorldKeyboard } from './world-session.js';

/**
 * World keyboard input read straight from DOM events (D-059).
 *
 * Phaser's KeyboardPlugin used to do this, and the contract the input gate
 * depends on is carried over exactly:
 *
 * - `enabled = false` delivers nothing and reads nothing as held.
 * - `disableGlobalCapture()` stops the World swallowing keystrokes, so a
 *   focused panel input receives them.
 * - `resetKeys()` clears held state, so a key held across a suspend does not
 *   walk the player away the moment input resumes.
 *
 * Two traps Phaser also guarded are handled here: a window blur or a hidden
 * tab clears held keys (their keyup is delivered somewhere else), and a
 * keystroke aimed at an editable element is never read as movement.
 */

const MOVEMENT_CODES: Readonly<Record<keyof MovementInput, readonly string[]>> = Object.freeze({
  up: Object.freeze(['ArrowUp', 'KeyW']),
  down: Object.freeze(['ArrowDown', 'KeyS']),
  left: Object.freeze(['ArrowLeft', 'KeyA']),
  right: Object.freeze(['ArrowRight', 'KeyD']),
});
const SPRINT_CODES: readonly string[] = Object.freeze(['ShiftLeft', 'ShiftRight']);
/** Keys the World claims while it owns input: movement, sprint and space. */
const CAPTURED_CODES: ReadonlySet<string> = new Set([
  ...Object.values(MOVEMENT_CODES).flat(),
  ...SPRINT_CODES,
  'Space',
]);
const OUTFIT_CODE = 'KeyF';

const NO_MOVEMENT: MovementInput = Object.freeze({
  left: false,
  right: false,
  up: false,
  down: false,
});

const EDITABLE_SELECTOR =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

interface KeyboardEventLike {
  readonly code?: unknown;
  readonly repeat?: unknown;
  readonly target?: unknown;
  preventDefault?(): void;
}

type Listener = (event: KeyboardEventLike) => void;

export interface DomEventHost {
  addEventListener(type: string, listener: Listener): void;
  removeEventListener(type: string, listener: Listener): void;
}

export interface DomKeyboardOptions {
  /** Receives keydown, keyup and blur; normally `window`. */
  readonly window: DomEventHost;
  /** Receives visibilitychange; normally `document`. */
  readonly document?: DomEventHost & { readonly visibilityState?: string };
}

export interface DomKeyboard extends WorldKeyboard {
  destroy(): void;
}

type OutfitHandler = Parameters<WorldKeyboard['on']>[1];

export function createDomKeyboard(options: DomKeyboardOptions): DomKeyboard {
  const held = new Set<string>();
  const outfitHandlers = new Set<OutfitHandler>();
  let enabled = true;
  let capture = true;
  let destroyed = false;

  const onKeyDown: Listener = (event) => {
    if (destroyed || !enabled) return;
    const code = typeof event.code === 'string' ? event.code : '';
    if (!code || isEditableTarget(event.target)) return;
    held.add(code);
    if (capture && CAPTURED_CODES.has(code)) event.preventDefault?.();
    if (code === OUTFIT_CODE) emitOutfit(event);
  };

  // Release is honoured whatever the target or gate state: a key pressed in
  // the World and released over a panel must not stay held.
  const onKeyUp: Listener = (event) => {
    if (destroyed) return;
    const code = typeof event.code === 'string' ? event.code : '';
    if (code) held.delete(code);
  };

  const onBlur: Listener = () => {
    held.clear();
  };

  const onVisibilityChange: Listener = () => {
    if (options.document?.visibilityState === 'hidden') held.clear();
  };

  const emitOutfit = (event: KeyboardEventLike): void => {
    const payload = { repeat: event.repeat === true, target: event.target };
    const errors: unknown[] = [];
    for (const handler of [...outfitHandlers]) {
      try {
        handler(payload);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'World keyboard handler failed');
  };

  options.window.addEventListener('keydown', onKeyDown);
  options.window.addEventListener('keyup', onKeyUp);
  options.window.addEventListener('blur', onBlur);
  options.document?.addEventListener('visibilitychange', onVisibilityChange);

  const isHeld = (codes: readonly string[]): boolean => codes.some((code) => held.has(code));

  return {
    get enabled() {
      return enabled;
    },
    set enabled(value: boolean) {
      enabled = value === true;
    },
    get held(): MovementInput {
      if (destroyed || !enabled) return NO_MOVEMENT;
      return {
        up: isHeld(MOVEMENT_CODES.up),
        down: isHeld(MOVEMENT_CODES.down),
        left: isHeld(MOVEMENT_CODES.left),
        right: isHeld(MOVEMENT_CODES.right),
      };
    },
    get sprinting(): boolean {
      return !destroyed && enabled && isHeld(SPRINT_CODES);
    },
    disableGlobalCapture(): void {
      capture = false;
    },
    enableGlobalCapture(): void {
      capture = true;
    },
    resetKeys(): void {
      held.clear();
    },
    on(event, handler) {
      if (event === 'keydown-F' && typeof handler === 'function' && !destroyed) {
        outfitHandlers.add(handler);
      }
      return undefined;
    },
    off(event, handler) {
      if (event === 'keydown-F') outfitHandlers.delete(handler);
      return undefined;
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      held.clear();
      outfitHandlers.clear();
      options.window.removeEventListener('keydown', onKeyDown);
      options.window.removeEventListener('keyup', onKeyUp);
      options.window.removeEventListener('blur', onBlur);
      options.document?.removeEventListener('visibilitychange', onVisibilityChange);
    },
  };
}

function isEditableTarget(target: unknown): boolean {
  if (target === null || (typeof target !== 'object' && typeof target !== 'function')) {
    return false;
  }
  const candidate = target as {
    readonly tagName?: unknown;
    readonly isContentEditable?: unknown;
    readonly closest?: unknown;
  };
  if (candidate.isContentEditable === true) return true;
  if (
    typeof candidate.tagName === 'string' &&
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(candidate.tagName.toUpperCase())
  ) {
    return true;
  }
  try {
    return (
      typeof candidate.closest === 'function' &&
      candidate.closest.call(target, EDITABLE_SELECTOR) !== null
    );
  } catch {
    return false;
  }
}
