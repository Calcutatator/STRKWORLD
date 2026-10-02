import type { InteractionPrompt } from './interaction.js';

/**
 * D-117: on a touch screen there is no E key, so the "E · …" prompt becomes
 * a button. It shows exactly while the interaction system focuses a
 * station, carries the same words, and a tap does what E does
 * (`WorldSession.interact`), through the same gates: nothing while a panel
 * or a Shell claim owns the controls.
 *
 * A plain DOM button over the World's canvas, styled like the plaza's prompt
 * (cream on near-black, ringed in STRK20 orange). It never keeps focus after
 * a tap, so the keyboard stays with the World.
 */

export interface TouchInteractButton {
  readonly element: HTMLButtonElement;
  /** The prompt the button carries now, or none (hidden). */
  readonly shown: InteractionPrompt | null;
  show(prompt: InteractionPrompt | null): void;
  destroy(): void;
}

export interface TouchInteractButtonOptions {
  /** The World's mount; the button is placed over its bottom centre. */
  readonly mount: HTMLElement;
  /** A tap: use what the prompt shows. */
  readonly onPress: () => void;
}

/** Whether the World is shown on a touch screen: a coarse primary pointer, or touch events with no fine pointer. */
export function isTouchScreen(win: Pick<Window, 'matchMedia'> & { readonly navigator?: { readonly maxTouchPoints?: number } }): boolean {
  try {
    if (win.matchMedia?.('(pointer: coarse)').matches === true) return true;
    if (win.matchMedia?.('(any-pointer: fine)').matches === true) return false;
    return (win.navigator?.maxTouchPoints ?? 0) > 0;
  } catch {
    return false;
  }
}

export function createTouchInteractButton(options: TouchInteractButtonOptions): TouchInteractButton {
  const doc = options.mount.ownerDocument;
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'strkworld-interact';
  button.dataset['interaction'] = 'touch';
  button.hidden = true;
  const key = doc.createElement('span');
  key.className = 'strkworld-interact-key';
  key.textContent = 'E';
  key.setAttribute('aria-hidden', 'true');
  const words = doc.createElement('span');
  words.className = 'strkworld-interact-label';
  button.append(key, words);
  Object.assign(button.style, {
    position: 'absolute',
    left: '50%',
    bottom: '24px',
    transform: 'translateX(-50%)',
    minHeight: '48px',
    minWidth: '96px',
    padding: '10px 18px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '10px',
    border: '2px solid #c53400',
    borderRadius: '999px',
    background: 'rgba(13,13,13,0.86)',
    color: '#fffdf1',
    font: '600 16px/1.1 ui-rounded, system-ui, sans-serif',
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    touchAction: 'manipulation',
    cursor: 'pointer',
    zIndex: '2',
  } satisfies Partial<CSSStyleDeclaration>);
  Object.assign(key.style, {
    display: 'inline-grid',
    placeItems: 'center',
    width: '26px',
    height: '26px',
    borderRadius: '6px',
    background: '#c53400',
    color: '#fffdf1',
  } satisfies Partial<CSSStyleDeclaration>);
  let shown: InteractionPrompt | null = null;
  let destroyed = false;

  const onClick = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
    // Hand the keyboard straight back to the World.
    button.blur();
    if (destroyed || !shown) return;
    options.onPress();
  };
  button.addEventListener('click', onClick);
  options.mount.appendChild(button);

  return {
    element: button,
    get shown() {
      return shown;
    },
    show(prompt) {
      if (destroyed) return;
      shown = prompt;
      if (!prompt) {
        button.hidden = true;
        return;
      }
      words.textContent = prompt.label;
      button.setAttribute('aria-label', `${prompt.label} (E)`);
      button.hidden = false;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      shown = null;
      button.removeEventListener('click', onClick);
      button.parentNode?.removeChild(button);
    },
  };
}
