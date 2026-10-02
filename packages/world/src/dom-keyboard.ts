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
 * Traps Phaser also guarded are handled here: a window blur or a hidden tab
 * clears held keys (their keyup is delivered somewhere else); a keystroke
 * aimed at an editable element — including one inside a shadow root — is never
 * read as movement; a key the Shell already handled is left alone; and any
 * chord with Ctrl, Cmd or Alt belongs to the browser (Phaser skipped modified
 * keys too, and macOS never delivers the keyup of a Cmd chord).
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
/**
 * One-shot action keys: the outfit toggle (D-053), the sandbox, plaza and
 * kick key (D-060, D-076, D-078) and the jump (D-097).
 */
const ACTION_EVENTS: Readonly<Record<string, 'keydown-F' | 'keydown-E' | 'keydown-Space'>> = Object.freeze({
  KeyF: 'keydown-F',
  KeyE: 'keydown-E',
  Space: 'keydown-Space',
});

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
  readonly defaultPrevented?: unknown;
  readonly ctrlKey?: unknown;
  readonly metaKey?: unknown;
  readonly altKey?: unknown;
  composedPath?(): unknown[];
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
  /**
   * D-114: the World's canvas. A primary-button press on it (a left click or
   * a tap) is the `pointerdown-primary` action, which strikes in the arena.
   * Only presses aimed at the canvas itself count, so a HUD button over it
   * never reaches the World. Absent: there is no pointer action.
   */
  readonly canvas?: DomEventHost;
}

interface PointerEventLike {
  readonly button?: unknown;
  readonly isPrimary?: unknown;
  readonly target?: unknown;
  readonly currentTarget?: unknown;
  readonly defaultPrevented?: unknown;
}

export interface DomKeyboard extends WorldKeyboard {
  destroy(): void;
}

type ActionHandler = Parameters<WorldKeyboard['on']>[1];
type ActionEvent = Parameters<WorldKeyboard['on']>[0];

export function createDomKeyboard(options: DomKeyboardOptions): DomKeyboard {
  const held = new Set<string>();
  const actionHandlers: Record<ActionEvent, Set<ActionHandler>> = {
    'keydown-F': new Set(),
    'keydown-E': new Set(),
    'keydown-Space': new Set(),
    'pointerdown-primary': new Set(),
  };
  let enabled = true;
  let capture = true;
  let destroyed = false;

  const onKeyDown: Listener = (event) => {
    if (destroyed || !enabled || event.defaultPrevented === true) return;
    if (event.ctrlKey === true || event.metaKey === true || event.altKey === true) return;
    const code = typeof event.code === 'string' ? event.code : '';
    const target = composedTarget(event);
    if (!code || isEditableTarget(target)) return;
    held.add(code);
    if (capture && CAPTURED_CODES.has(code)) event.preventDefault?.();
    const action = ACTION_EVENTS[code];
    if (action) emitAction(action, { repeat: event.repeat === true, target });
  };

  // Release is honoured whatever the target or gate state: a key pressed in
  // the World and released over a panel must not stay held.
  const onKeyUp: Listener = (event) => {
    if (destroyed) return;
    const code = typeof event.code === 'string' ? event.code : '';
    if (code) held.delete(code);
  };

  // D-114: a primary press on the canvas itself, never on a control over it.
  const onPointerDown = ((event: PointerEventLike) => {
    if (destroyed || !enabled || event.defaultPrevented === true) return;
    if (event.button !== 0 || event.isPrimary === false) return;
    if (options.canvas && event.target !== options.canvas) return;
    emitAction('pointerdown-primary', { repeat: false, target: event.target });
  }) as Listener;

  const onBlur: Listener = () => {
    held.clear();
  };

  const onVisibilityChange: Listener = () => {
    if (options.document?.visibilityState === 'hidden') held.clear();
  };

  const emitAction = (
    action: ActionEvent,
    payload: { readonly repeat: boolean; readonly target: unknown },
  ): void => {
    const errors: unknown[] = [];
    for (const handler of [...actionHandlers[action]]) {
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
  options.canvas?.addEventListener('pointerdown', onPointerDown);

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
      if (actionHandlers[event] && typeof handler === 'function' && !destroyed) {
        actionHandlers[event].add(handler);
      }
      return undefined;
    },
    off(event, handler) {
      actionHandlers[event]?.delete(handler);
      return undefined;
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      held.clear();
      for (const handlers of Object.values(actionHandlers)) handlers.clear();
      options.window.removeEventListener('keydown', onKeyDown);
      options.window.removeEventListener('keyup', onKeyUp);
      options.window.removeEventListener('blur', onBlur);
      options.document?.removeEventListener('visibilitychange', onVisibilityChange);
      options.canvas?.removeEventListener('pointerdown', onPointerDown);
    },
  };
}

/** The element a keystroke was really aimed at, even inside a shadow root. */
function composedTarget(event: KeyboardEventLike): unknown {
  try {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : undefined;
    if (Array.isArray(path) && path.length > 0) return path[0];
  } catch {
    // Fall back to the retargeted target.
  }
  return event.target;
}

/** Whether a keystroke target is a text field (or inside one): the World never reads it. */
export function isEditableTarget(target: unknown): boolean {
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
