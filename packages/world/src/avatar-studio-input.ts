export interface AvatarStudioToggleBinding {
  setActive(active: boolean): void;
  destroy(): void;
}

interface AvatarStudioKeyEvent {
  readonly repeat: boolean;
  readonly target: unknown;
}

interface KeyboardEmitter {
  on(event: 'keydown-F', handler: (event: AvatarStudioKeyEvent) => void): unknown;
  off(event: 'keydown-F', handler: (event: AvatarStudioKeyEvent) => void): unknown;
}

const EDITABLE_SELECTOR =
  'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

/** Own the Studio-only F listener without leaking it across Scene restarts. */
export function createAvatarStudioToggleBinding(options: {
  readonly keyboard: KeyboardEmitter;
  readonly toggle: () => void;
}): AvatarStudioToggleBinding {
  let active = false;
  let destroyed = false;

  const onKeyDown = (event: AvatarStudioKeyEvent): void => {
    if (destroyed || !active || event.repeat || isEditableKeyboardTarget(event.target)) return;
    options.toggle();
  };

  return {
    setActive(nextActive): void {
      if (destroyed || nextActive === active) return;
      active = nextActive;
      if (active) options.keyboard.on('keydown-F', onKeyDown);
      else options.keyboard.off('keydown-F', onKeyDown);
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      if (active) options.keyboard.off('keydown-F', onKeyDown);
      active = false;
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
