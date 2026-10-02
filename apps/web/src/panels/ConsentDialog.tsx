import { useEffect, useId, useRef } from 'react';

/**
 * One modal question, asked before something leaves the device.
 *
 * Generic: the placement stand's disclosure is the first use (D-122, amended
 * 2026-10-02 at the lead's request), and the words, the two labels and what
 * each answer does are the caller's. It remembers nothing — a caller that
 * must ask every time simply mounts it every time.
 *
 * While it is open nothing behind it may act on a keystroke. Every `keydown`
 * is stopped at the window in the capture phase, so the visit layer's Escape
 * does not also close the window behind this dialog (`VisitLayer`), and the
 * World never reads E, movement or Space (`dom-keyboard.ts`, whose own
 * listener bubbles). `keyup` is deliberately left alone: the World clears a
 * held key on release whatever else is open, and swallowing that would leave
 * a key held. The input gate has already handed the keyboard over by the time
 * any panel is on screen; this is the second belt, not the first.
 *
 * Escape and a press outside both answer Cancel, once: either one closes the
 * dialog, and a caller's `onCancel` is never called twice.
 */

/** Everything inside the dialog that can take focus, in document order. */
const FOCUSABLE = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export interface ConsentDialogProps {
  /** The heading, in the brand's headline face. */
  readonly title: string;
  /** One paragraph of body copy: what continuing shares, and with whom. */
  readonly body: string;
  /** The primary answer's label. */
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  /** The player accepted. Called at most once per mount. */
  readonly onConfirm: () => void;
  /** The player declined, pressed Escape, or pressed outside. At most once per mount. */
  readonly onCancel: () => void;
}

export function ConsentDialog({
  title,
  body,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onCancel,
}: ConsentDialogProps) {
  const dialog = useRef<HTMLDivElement>(null);
  /** The control that opened this, so focus goes back to it on close. */
  const trigger = useRef<HTMLElement | null>(null);
  const answered = useRef(false);
  const id = useId();
  const titleId = `${id}-title`;
  const bodyId = `${id}-body`;

  // Keep the newest callbacks reachable from listeners installed once.
  const answer = useRef({ onConfirm, onCancel });
  answer.current = { onConfirm, onCancel };

  const once = (reply: 'confirm' | 'cancel'): void => {
    if (answered.current) return;
    answered.current = true;
    if (reply === 'confirm') answer.current.onConfirm();
    else answer.current.onCancel();
  };

  useEffect(() => {
    const opener = dialog.current?.ownerDocument.activeElement ?? null;
    trigger.current = opener instanceof HTMLElement ? opener : null;
    dialog.current?.focus();
    return () => {
      const back = trigger.current;
      trigger.current = null;
      // A trigger that left the document, or that the answer disabled while it
      // works, cannot hold focus; the panel's own live region speaks instead.
      if (!back || !back.isConnected || (back as HTMLButtonElement).disabled === true) return;
      try {
        back.focus();
      } catch {
        // Focus is a courtesy, never a reason to fail a close.
      }
    };
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onKeyDown = (event: KeyboardEvent): void => {
      // Nothing behind the dialog hears this keystroke.
      event.stopPropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        once('cancel');
        return;
      }
      if (event.key === 'Tab') trapFocus(event, dialog.current);
    };
    const onPressOutside = (event: Event): void => {
      const target = event.target;
      if (target instanceof Node && dialog.current?.contains(target)) return;
      once('cancel');
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', onPressOutside, true);
    window.addEventListener('mousedown', onPressOutside, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPressOutside, true);
      window.removeEventListener('mousedown', onPressOutside, true);
    };
    // Installed once per mount; the newest callbacks are reached through a ref.
  }, []);

  return (
    <div className="consent-screen">
      <div
        className="consent-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        tabIndex={-1}
        ref={dialog}
      >
        <h3 className="consent-title" id={titleId}>{title}</h3>
        <p className="consent-body" id={bodyId}>{body}</p>
        <div className="consent-actions">
          <button type="button" className="consent-confirm" onClick={() => once('confirm')}>
            {confirmLabel}
          </button>
          <button type="button" className="consent-cancel" onClick={() => once('cancel')}>
            {cancelLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Tab and Shift+Tab stay inside the dialog. */
function trapFocus(event: KeyboardEvent, dialog: HTMLElement | null): void {
  if (!dialog) return;
  const stops = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
  const active = dialog.ownerDocument.activeElement;
  if (stops.length === 0) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  const first = stops[0]!;
  const last = stops[stops.length - 1]!;
  const inside = active instanceof Node && dialog.contains(active);
  if (event.shiftKey) {
    if (!inside || active === first || active === dialog) {
      event.preventDefault();
      last.focus();
    }
    return;
  }
  if (!inside || active === last) {
    event.preventDefault();
    first.focus();
  }
}
