/**
 * The World-local outfit selection and its single F binding (D-053).
 *
 * D-052 shipped F as an Avatar Studio key. That made the toggle appear broken
 * everywhere else, because the Studio controller both owned the selected
 * sprite *and* owned the listener: step outside and there was nothing to press.
 *
 * D-053 splits those two jobs apart:
 *
 *   - `createAvatarOutfitSelection` owns *what* the local avatar is wearing.
 *     One instance per Scene, shared by the Studio and every fixed room, so
 *     there is exactly one source of truth. Two selections silently diverge —
 *     a toggle outdoors would leave the Studio's own copy stale, and the next
 *     press would emit a state the avatar is already in and change nothing.
 *   - `createAvatarOutfitToggleBinding` owns *when* F counts. It registers one
 *     listener for the Scene's lifetime and asks `isActive()` at press time
 *     rather than attaching and detaching across room transitions. A binding
 *     that re-registers per room is how you end up with two listeners, or
 *     none, after an unusual enter/exit order or a same-instance restart.
 *
 * This is cosmetic and World-local. It resolves through the existing
 * `pairedAvatarSprite` mapping and emits the existing `avatar:selected` event
 * with an opaque `avatar-1..avatar-16` key. It adds no stance or outfit field,
 * no lobby message, no building field and no financial meaning.
 *
 * Written against a minimal structural keyboard interface rather than Phaser's
 * types, so the guards — repeat, editable target, suspended input, post-destroy
 * staleness — are unit-tested in CI without a browser.
 */

import type { AvatarSpriteKey, EventBus, WorldEvents } from '@strkworld/shared';
import { DEFAULT_AVATAR_SPRITE, pairedAvatarSprite } from './avatar-state.js';

export interface AvatarOutfitSelection {
  /** What the local avatar is wearing right now. */
  readonly selected: AvatarSpriteKey;
  /** Select a key. Returns whether this was a real change. */
  select(sprite: AvatarSpriteKey): boolean;
  /** Swap to the paired cosy/fighting state of the current selection. */
  toggle(): void;
}

export function createAvatarOutfitSelection(options: {
  readonly out: Pick<EventBus<WorldEvents>, 'emit'>;
  readonly initial?: AvatarSpriteKey;
}): AvatarOutfitSelection {
  let selected = options.initial ?? DEFAULT_AVATAR_SPRITE;

  const select = (sprite: AvatarSpriteKey): boolean => {
    if (sprite === selected) return false;
    selected = sprite;
    options.out.emit('avatar:selected', { sprite: selected });
    return true;
  };

  return {
    get selected() {
      return selected;
    },
    select,
    toggle: () => void select(pairedAvatarSprite(selected)),
  };
}

export interface AvatarOutfitToggleBinding {
  destroy(): void;
}

interface AvatarOutfitKeyEvent {
  readonly repeat: boolean;
  readonly target: unknown;
}

interface KeyboardEmitter {
  on(event: 'keydown-F', handler: (event: AvatarOutfitKeyEvent) => void): unknown;
  off(event: 'keydown-F', handler: (event: AvatarOutfitKeyEvent) => void): unknown;
}

const EDITABLE_SELECTOR =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

/**
 * Own the single keydown-F listener for the Scene's lifetime.
 *
 * `isActive` is asked per press, not cached: World input is suspended and
 * resumed by the input gate while the player is outdoors, in the Studio and in
 * a room, and a cached flag would go stale on the transition that matters.
 */
export function createAvatarOutfitToggleBinding(options: {
  readonly keyboard: KeyboardEmitter;
  readonly isActive: () => boolean;
  readonly toggle: () => void;
}): AvatarOutfitToggleBinding {
  let destroyed = false;
  let detached = false;

  const onKeyDown = (event: AvatarOutfitKeyEvent): void => {
    // One press per toggle: a held key repeats, and a keystroke aimed at a
    // panel's input belongs to the DOM.
    if (destroyed || event.repeat || isEditableKeyboardTarget(event.target)) return;
    if (!options.isActive()) return;
    options.toggle();
  };

  try {
    options.keyboard.on('keydown-F', onKeyDown);
  } catch (error) {
    try { options.keyboard.off('keydown-F', onKeyDown); } catch { /* preserve registration failure */ }
    throw error;
  }

  return {
    destroy(): void {
      if (detached) return;
      destroyed = true;
      options.keyboard.off('keydown-F', onKeyDown);
      // Mark the resource released only after the emitter confirms removal.
      // If `off` throws, the inert listener remains owned and a later cleanup
      // attempt must be allowed to retry it.
      detached = true;
    },
  };
}

function isEditableKeyboardTarget(target: unknown): boolean {
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
  return (
    typeof candidate.closest === 'function' &&
    candidate.closest.call(target, EDITABLE_SELECTOR) !== null
  );
}
