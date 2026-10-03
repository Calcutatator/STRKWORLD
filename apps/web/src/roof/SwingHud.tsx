import { useEffect, useSyncExternalStore } from 'react';
import type { RoofSwingSnapshot } from '@strkworld/shared';
import { COPY } from '../copy.js';
import { keyBelongsElsewhere } from '../arena/ArenaHud.js';
import type { SwingShellChannel } from './swing-controller.js';

/**
 * The lookout swing's HUD (D-132): one small hint, in the brand style
 * (`docs/brand/README.md`), shown to the rider and nobody else.
 *
 * The ride is the server's twenty seconds and the World draws it; the Shell
 * adds only the way out. While this client is the rider the hint reads
 * "Esc to get off", with the same words on a button for a touch screen, and
 * Esc anywhere else on the page does the same. Nothing renders off the roof,
 * for a spectator, or when the swing is idle.
 */

export interface SwingHudProps {
  readonly swing?: SwingShellChannel;
  /** Where Esc is listened for; the document by default. */
  readonly keyTarget?: Pick<Document, 'addEventListener' | 'removeEventListener'> | null;
  /** Reduced motion: the hint fades in rather than sliding up. */
  readonly reducedMotion?: () => boolean;
}

const NO_SWING = (): RoofSwingSnapshot | null => null;
const NO_SUBSCRIBE = () => () => {};

function media(query: string): boolean {
  try {
    return globalThis.matchMedia?.(query).matches === true;
  } catch {
    return false;
  }
}

export function SwingHud({
  swing,
  keyTarget = globalThis.document ?? null,
  reducedMotion = () => media('(prefers-reduced-motion: reduce)'),
}: SwingHudProps) {
  const state = useSyncExternalStore(
    swing ? swing.subscribe : NO_SUBSCRIBE,
    swing ? swing.swing : NO_SWING,
    swing ? swing.swing : NO_SWING,
  );
  const self = swing?.selfId() ?? null;
  const riding =
    state !== null && state.phase === 'riding' && self !== null && state.riderId === self;

  // Esc gets the rider off, unless a text field or a window has the key.
  useEffect(() => {
    if (!riding || !keyTarget || !swing) return;
    const onKey = (event: Event): void => {
      const key = event as KeyboardEvent;
      if (key.key !== 'Escape' || key.repeat) return;
      if (keyBelongsElsewhere(key.target)) return;
      swing.press();
    };
    keyTarget.addEventListener('keydown', onKey);
    return () => keyTarget.removeEventListener('keydown', onKey);
  }, [riding, keyTarget, swing]);

  if (!swing || !riding) return null;

  return (
    <div
      className="swing-hud"
      data-motion={reducedMotion() ? 'reduced' : 'full'}
      aria-label={COPY.swing.label}
      role="region"
    >
      <button type="button" className="swing-hud-hint" onClick={() => swing.press()}>
        {COPY.swing.getOff}
      </button>
    </div>
  );
}
