/**
 * Suspending world input while a building panel is open.
 *
 * Without this, **typing an amount into a panel is impossible.** Phaser's
 * KeyboardManager binds `keydown`/`keyup` to `window` with no
 * `document.activeElement` check, and `addKeys`/`createCursorKeys` default to
 * `enableCapture = true`. A keystroke from a focused React `<input>` is both
 * swallowed (`defaultPrevented`) *and* delivered to the game — the character
 * never arrives and the player walks away while you type.
 *
 * Three fixes that look right and are not:
 *
 * - `game.input.enabled = false` does **not** stop the keyboard.
 *   `KeyboardPlugin.isActive()` ignores `manager.enabled`, while
 *   `InputPlugin.isActive()` honours it. It disables the mouse only.
 * - `scene.pause()` is queued by the SceneManager, not immediate. Read it back
 *   in the same tick and the scene is still running with the key still down.
 * - Disabling the plugin alone leaves `Key.isDown` **sticky**. Suspend while W
 *   is held and the key stays down forever, so the player walks off screen the
 *   moment you resume.
 *
 * The order matters: stop capturing, then disable, then clear held state.
 *
 * Deliberately written against a minimal structural interface rather than
 * Phaser's types, so the sequence — the part that is easy to get wrong and
 * silent when wrong — is unit-tested in CI without a browser.
 */

/** The subset of Phaser's KeyboardPlugin this needs. */
export interface KeyboardLike {
  enabled: boolean;
  /** Releases the browser-level capture that swallows keystrokes. */
  disableGlobalCapture(): void;
  /** Re-arms it. */
  enableGlobalCapture(): void;
  /** Clears held state. Without this, `isDown` survives a suspend. */
  resetKeys(): void;
}

export interface InputGate {
  /** Hand the keyboard to the DOM. Idempotent. */
  suspend(): void;
  /** Take it back. Idempotent. */
  resume(): void;
  readonly suspended: boolean;
}

export function createInputGate(keyboard: KeyboardLike): InputGate {
  let suspended = false;

  return {
    suspend() {
      if (suspended) return;
      suspended = true;
      // Order is load-bearing.
      keyboard.disableGlobalCapture(); // stop swallowing keystrokes
      keyboard.enabled = false; // stop delivering them to the game
      keyboard.resetKeys(); // drop anything currently held
    },

    resume() {
      if (!suspended) return;
      suspended = false;
      // Clear first: a key pressed while suspended must not arrive as held.
      keyboard.resetKeys();
      keyboard.enabled = true;
      keyboard.enableGlobalCapture();
    },

    get suspended() {
      return suspended;
    },
  };
}

/**
 * Wire the gate to building entry and exit.
 *
 * Escape deliberately belongs to React, not to a scene key. Once the plugin is
 * correctly disabled, a scene-level ESC handler never fires — and a panel that
 * cannot be closed by keyboard is worse than one that never opened.
 */
export function bindInputGate(
  gate: InputGate,
  on: (event: 'building:entered' | 'building:exited', handler: () => void) => () => void,
): () => void {
  const offEnter = on('building:entered', () => gate.suspend());
  const offExit = on('building:exited', () => gate.resume());
  return () => {
    offEnter();
    offExit();
    // Never leave the world unable to receive input because a panel unmounted
    // in an unexpected order.
    gate.resume();
  };
}
