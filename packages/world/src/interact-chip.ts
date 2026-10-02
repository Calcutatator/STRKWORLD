import { isEditableTarget } from './dom-keyboard.js';
import type { InteractionPrompt } from './interaction.js';

/**
 * D-123: the key chip. While the interaction system has chosen a station
 * (D-117), a quiet chip low on the screen names it: an "E" keycap and the
 * station's words, "[E] SHIELD". It replaces D-117's "E · …" floating over
 * the station and, on a touch screen, its separate tap button: there the
 * chip IS the button, and a tap does what E does (`WorldSession.interact`),
 * through the same gates.
 *
 * It shows exactly while the session reports a prompt, so it already hides
 * whenever E would do nothing: a panel open, Menu Mode, a Shell claim, a
 * counter holding the controls, a fight suspending the stations. It also
 * hides while a text field has focus, where E types a letter.
 *
 * Styled in the brand system (docs/brand/README.md): a Silkscreen keycap on
 * an Ember block with an Outline border and a hard drop, the words in VT323,
 * on a dark window fill. It fades in and out over 200 ms (at once with
 * reduced motion). It sits centred, above the bottom band the HUD's presence
 * pill uses. It never takes focus, so the keyboard stays with the World.
 */

/** The fade, ms; the same as the edge glow's (three/affordance.ts). */
export const INTERACT_CHIP_FADE_MS = 200;

/**
 * The game theme's tokens (D-119: Silkscreen for buttons and labels, VT323
 * for body copy, normalised by `--ui-type-adjust`), falling back to the brand
 * tokens and then to the brand guide's own values, so the chip looks right
 * in any host page.
 */
const EMBER = 'var(--brand-ember, #f56a16)';
const OUTLINE = 'var(--brand-outline, #24120a)';
const CREAM = 'var(--brand-cream, #fff6e6)';
const WINDOW = 'rgb(38 24 16 / 0.86)';
const FONT_KEY = 'var(--ui-btn-font, var(--brand-font-menu, "Silkscreen", "VT323", ui-monospace, monospace))';
const FONT_LABEL = 'var(--ui-font, var(--brand-font-body, "VT323", ui-monospace, monospace))';
/** The pixel faces draw small for their size; the game theme sets their cap height (D-119). */
const TYPE_ADJUST = 'var(--ui-type-adjust, none)';

export interface InteractChip {
  readonly element: HTMLButtonElement;
  /** The prompt the chip carries now, or none. */
  readonly shown: InteractionPrompt | null;
  /** Whether it is on screen: a prompt, and no text field focused. */
  readonly visible: boolean;
  show(prompt: InteractionPrompt | null): void;
  destroy(): void;
}

export interface InteractChipOptions {
  /** The World's mount; the chip is placed over its bottom centre. */
  readonly mount: HTMLElement;
  /** A touch screen: the chip is a tap target. Otherwise it is a hint the pointer passes through. */
  readonly touch: boolean;
  /** A tap: use what the chip names. Only on a touch screen. */
  readonly onPress: () => void;
  /** `prefers-reduced-motion`: no fade. Read at each change. */
  readonly reducedMotion?: () => boolean;
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

export function createInteractChip(options: InteractChipOptions): InteractChip {
  const doc = options.mount.ownerDocument;
  const touch = options.touch === true;
  const chip = doc.createElement('button');
  chip.type = 'button';
  chip.className = 'strkworld-interact-chip';
  chip.dataset['interaction'] = 'chip';
  chip.dataset['touch'] = String(touch);
  chip.dataset['shown'] = 'false';
  chip.tabIndex = -1;
  chip.setAttribute('aria-hidden', 'true');
  const key = doc.createElement('span');
  key.className = 'strkworld-interact-key';
  key.textContent = 'E';
  key.setAttribute('aria-hidden', 'true');
  const words = doc.createElement('span');
  words.className = 'strkworld-interact-label';
  chip.append(key, words);
  Object.assign(chip.style, {
    position: 'absolute',
    left: '50%',
    // Above the HUD's bottom band (the presence pill sits at 1rem from the edge).
    bottom: 'calc(max(16px, env(safe-area-inset-bottom, 0px)) + 56px)',
    transform: 'translateX(-50%)',
    margin: '0',
    minHeight: touch ? '48px' : '40px',
    padding: touch ? '6px 16px 8px 6px' : '4px 14px 6px 5px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '10px',
    border: `3px solid ${OUTLINE}`,
    borderRadius: '6px',
    background: WINDOW,
    boxShadow: `0 4px 0 ${OUTLINE}`,
    color: CREAM,
    font: `400 19px/1 ${FONT_LABEL}`,
    fontSizeAdjust: TYPE_ADJUST,
    letterSpacing: '0.03em',
    whiteSpace: 'nowrap',
    maxWidth: 'calc(100% - 32px)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    touchAction: 'manipulation',
    cursor: touch ? 'pointer' : 'default',
    userSelect: 'none',
    zIndex: '2',
    opacity: '0',
    visibility: 'hidden',
    pointerEvents: 'none',
  } satisfies Partial<CSSStyleDeclaration>);
  Object.assign(key.style, {
    display: 'inline-grid',
    placeItems: 'center',
    boxSizing: 'border-box',
    minWidth: touch ? '32px' : '28px',
    height: touch ? '32px' : '28px',
    padding: '0 6px',
    border: `2px solid ${OUTLINE}`,
    borderRadius: '4px',
    background: EMBER,
    boxShadow: `0 3px 0 ${OUTLINE}`,
    color: CREAM,
    font: `700 14px/1 ${FONT_KEY}`,
    fontSizeAdjust: TYPE_ADJUST,
    letterSpacing: '0.04em',
  } satisfies Partial<CSSStyleDeclaration>);

  let shown: InteractionPrompt | null = null;
  let editing = isEditableTarget(doc.activeElement);
  let destroyed = false;

  const reduced = (): boolean => {
    try {
      return options.reducedMotion?.() === true;
    } catch {
      return false;
    }
  };

  const render = (): void => {
    const visible = shown !== null && !editing;
    const fade = reduced() ? 0 : INTERACT_CHIP_FADE_MS;
    // Fading out, `visibility` waits for the fade; fading in, it flips first.
    chip.style.transition = fade === 0
      ? 'none'
      : visible
        ? `opacity ${fade}ms ease-out, visibility 0s linear 0s`
        : `opacity ${fade}ms ease-in, visibility 0s linear ${fade}ms`;
    chip.style.opacity = visible ? '1' : '0';
    chip.style.visibility = visible ? 'visible' : 'hidden';
    chip.style.pointerEvents = visible && touch ? 'auto' : 'none';
    chip.dataset['shown'] = String(visible);
    if (visible) chip.removeAttribute('aria-hidden');
    else chip.setAttribute('aria-hidden', 'true');
  };

  const onClick = (event: Event): void => {
    event.preventDefault();
    event.stopPropagation();
    // Hand the keyboard straight back to the World.
    chip.blur();
    if (destroyed || !touch || !shown || editing) return;
    options.onPress();
  };
  // E types a letter in a text field, so the chip steps aside while one has focus.
  const onFocusIn = (event: FocusEvent): void => {
    const next = isEditableTarget(event.target);
    if (next === editing) return;
    editing = next;
    render();
  };
  const onFocusOut = (event: FocusEvent): void => {
    const next = isEditableTarget(event.relatedTarget);
    if (next === editing) return;
    editing = next;
    render();
  };
  chip.addEventListener('click', onClick);
  doc.addEventListener('focusin', onFocusIn);
  doc.addEventListener('focusout', onFocusOut);
  options.mount.appendChild(chip);

  return {
    element: chip,
    get shown() {
      return shown;
    },
    get visible() {
      return shown !== null && !editing;
    },
    show(prompt) {
      if (destroyed) return;
      shown = prompt;
      if (prompt) {
        // Fading out keeps the last words; only a new prompt rewrites them.
        words.textContent = prompt.label;
        chip.setAttribute('aria-label', `${prompt.label} (E)`);
      }
      render();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      shown = null;
      chip.removeEventListener('click', onClick);
      doc.removeEventListener('focusin', onFocusIn);
      doc.removeEventListener('focusout', onFocusOut);
      chip.parentNode?.removeChild(chip);
    },
  };
}
