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
const ACTION_EVENTS: Readonly<Record<string, 'keydown-F' | 'keydown-E' | 'keydown-Space' | 'keydown-Q'>> = Object.freeze({
  KeyF: 'keydown-F',
  KeyE: 'keydown-E',
  Space: 'keydown-Space',
  // D-128: the arena's block. Unlike the rest it is a hold, so its release
  // is an action too (`keyup-Q`, emitted from `onKeyUp`).
  KeyQ: 'keydown-Q',
});
/** D-128: release events, delivered from `onKeyUp` whatever the gate state. */
const RELEASE_EVENTS: Readonly<Record<string, 'keyup-Q'>> = Object.freeze({ KeyQ: 'keyup-Q' });

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
  readonly pointerId?: unknown;
  readonly clientX?: unknown;
  readonly target?: unknown;
  readonly currentTarget?: unknown;
  readonly defaultPrevented?: unknown;
}

/**
 * D-133 (2026-10-03): a drag across the canvas further than this, in screen
 * pixels, is a drag rather than a tap, so a tap that wobbles never turns the
 * roof swing's rider's head.
 */
const DRAG_THRESHOLD_PX = 6;

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
    'keydown-Q': new Set(),
    'keyup-Q': new Set(),
    'pointerdown-primary': new Set(),
  };
  let enabled = true;
  let capture = true;
  let destroyed = false;
  /** D-133: the pointer being dragged across the canvas, and where it was last seen. */
  let dragPointer: unknown = null;
  let dragFrom = 0;
  let dragAt = 0;
  let dragging = false;
  /** Horizontal drag not yet taken by `takeDragX`, in screen pixels. */
  let dragX = 0;

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
    if (!code) return;
    const wasHeld = held.delete(code);
    // D-128: a release is delivered on the same terms as a held key being
    // cleared — whatever the target, the gate or the modifiers — so a block
    // started in the World always comes down, even if Q is let go over a
    // panel. Only a key this keyboard saw go down releases.
    const release = RELEASE_EVENTS[code];
    if (release && wasHeld) emitAction(release, { repeat: false, target: composedTarget(event) });
  };

  // D-114: a primary press on the canvas itself, never on a control over it.
  const onPointerDown = ((event: PointerEventLike) => {
    if (destroyed || !enabled || event.defaultPrevented === true) return;
    if (event.button !== 0 || event.isPrimary === false) return;
    if (options.canvas && event.target !== options.canvas) return;
    // D-133: this press may become a drag, which turns a swing rider's head.
    if (typeof event.clientX === 'number' && Number.isFinite(event.clientX)) {
      dragPointer = event.pointerId ?? 'primary';
      dragFrom = event.clientX;
      dragAt = event.clientX;
      dragging = false;
    }
    emitAction('pointerdown-primary', { repeat: false, target: event.target });
  }) as Listener;

  /**
   * D-133: a horizontal drag on the canvas, accumulated for whoever asks. It
   * steers nothing by itself: the only reader is the roof swing's ride, and
   * only while this client is the rider.
   */
  const onPointerMove = ((event: PointerEventLike) => {
    if (destroyed || !enabled || dragPointer === null) return;
    if ((event.pointerId ?? 'primary') !== dragPointer) return;
    if (typeof event.clientX !== 'number' || !Number.isFinite(event.clientX)) return;
    if (!dragging && Math.abs(event.clientX - dragFrom) < DRAG_THRESHOLD_PX) return;
    dragging = true;
    dragX += event.clientX - dragAt;
    dragAt = event.clientX;
  }) as Listener;

  const onPointerUp = ((event: PointerEventLike) => {
    if ((event.pointerId ?? 'primary') !== dragPointer) return;
    dragPointer = null;
    dragging = false;
  }) as Listener;

  /**
   * Clear every held key, and deliver the release of any that has one
   * (D-128's Q). A blur, a hidden tab or a `resetKeys` is exactly the case
   * where the keyup is delivered somewhere else, so this is the only chance
   * to lower a block.
   */
  const clearHeld = (): void => {
    dragPointer = null;
    dragging = false;
    dragX = 0;
    const releasing = [...held].filter((code) => RELEASE_EVENTS[code] !== undefined);
    held.clear();
    for (const code of releasing) emitAction(RELEASE_EVENTS[code]!, { repeat: false, target: null });
  };

  const onBlur: Listener = () => {
    clearHeld();
  };

  const onVisibilityChange: Listener = () => {
    if (options.document?.visibilityState === 'hidden') clearHeld();
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
  options.canvas?.addEventListener('pointermove', onPointerMove);
  options.window.addEventListener('pointerup', onPointerUp);
  options.window.addEventListener('pointercancel', onPointerUp);

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
    takeDragX(): number {
      if (destroyed || !enabled) {
        dragX = 0;
        return 0;
      }
      const moved = dragX;
      dragX = 0;
      return moved;
    },
    disableGlobalCapture(): void {
      capture = false;
    },
    enableGlobalCapture(): void {
      capture = true;
    },
    resetKeys(): void {
      clearHeld();
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
      options.canvas?.removeEventListener('pointermove', onPointerMove);
      options.window.removeEventListener('pointerup', onPointerUp);
      options.window.removeEventListener('pointercancel', onPointerUp);
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
