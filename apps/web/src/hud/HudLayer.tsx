import { useEffect, useId, useMemo, useRef, useState, type Ref } from 'react';
import type { EventBus, ShellEvents } from '@strkworld/shared';
import { COPY } from '../copy.js';
import { useArrivalNudge } from '../bridge/ArrivalNudgeProvider.js';
import { useWalletStatusSnapshot } from '../privacy/PrivacyProvider.js';
import { useStore } from '../store/use-store.js';
import { browserViewerStorage, type ViewerStorage } from '../store/viewer-storage.js';
import { GettingStarted } from './GettingStarted.js';
import { createHudModel, type HudState } from './hud-model.js';

export const HUD_BALANCE_HIDDEN_KEY = 'strkworld.hud.balance-hidden.v1';
export const HUD_GUIDE_DISMISSED_KEY = 'strkworld.hud.guide-dismissed.v1';

/**
 * The street HUD: wallet status, the last balance the player read at the
 * Bank, what is in flight, the D-021 Bridge nudge and the way back to the
 * Getting started card.
 *
 * A Shell overlay, not World geometry. No decision requires the World to draw
 * the HUD — ARCHITECTURE's "Phaser HUD" sketch predates D-059, which kept every
 * seam's shape — and listening beside the World on the same bus changes no
 * seam: the World may still subscribe later. Both compositions mount it
 * through `App`, so the demo and production trees get the same HUD.
 *
 * Nothing here emits on the bus, reads a balance or reaches the lobby. The
 * balance toggle and the guide's dismissal are per-viewer conveniences in
 * guarded storage, and the HUD renders the same without them.
 *
 * `wallet:status` is published from an effect in `PrivacyProvider`, above this
 * component, whenever the connect state changes, and the bus does not replay
 * (D-038). Since D-072 the HUD mounts only once the entry gate passes, and in
 * the demo that is long after the provider first published, so the HUD reads
 * the current status as it subscribes and takes every later change from the
 * bus. Outside a provider (tests) it waits for the first event, as before.
 */
export function HudLayer({
  shell,
  storage = browserViewerStorage,
}: {
  shell: EventBus<ShellEvents>;
  storage?: ViewerStorage;
}) {
  // Keyed on the bus: a different bus is a different stream, and its
  // predecessor's balance must not carry over.
  const model = useMemo(() => createHudModel(), [shell]);
  const state = useStore(model.store);
  const currentWallet = useWalletStatusSnapshot();
  useEffect(() => model.listen(shell, currentWallet ?? undefined), [model, shell, currentWallet]);

  const arrival = useArrivalNudge();
  // Hidden unless this viewer chose to show it: a balance on screen by
  // default is a balance on every stream and screen share.
  const [balanceHidden, setBalanceHidden] = useState(
    () => storage.read(HUD_BALANCE_HIDDEN_KEY) !== '0',
  );
  const [guide, setGuide] = useState(() => ({
    open: storage.read(HUD_GUIDE_DISMISSED_KEY) !== '1',
    focus: false,
  }));
  const helpRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const guideId = useId();

  useEffect(() => {
    // Only a guide the player asked for takes focus; the first-run card
    // appears without pulling focus away from the street.
    if (guide.open && guide.focus) headingRef.current?.focus();
  }, [guide]);

  const toggleBalance = (): void => {
    const next = !balanceHidden;
    setBalanceHidden(next);
    storage.write(HUD_BALANCE_HIDDEN_KEY, next ? '1' : '0');
  };

  const closeGuide = (returnFocus: boolean): void => {
    setGuide({ open: false, focus: false });
    storage.write(HUD_GUIDE_DISMISSED_KEY, '1');
    if (returnFocus) helpRef.current?.focus();
  };

  return (
    <HudView
      state={state}
      balanceHidden={balanceHidden}
      onToggleBalance={toggleBalance}
      guideId={guideId}
      guideOpen={guide.open}
      onToggleGuide={() => (guide.open ? closeGuide(false) : setGuide({ open: true, focus: true }))}
      onDismissGuide={() => closeGuide(true)}
      arrivalWaiting={arrival?.waiting ?? false}
      onDismissArrival={() => arrival?.dismiss()}
      helpRef={helpRef}
      headingRef={headingRef}
    />
  );
}

/** Pure render half, so every state is testable without a DOM. */
export function HudView({
  state,
  balanceHidden,
  onToggleBalance,
  guideId,
  guideOpen,
  onToggleGuide,
  onDismissGuide,
  arrivalWaiting,
  onDismissArrival,
  helpRef,
  headingRef,
}: {
  state: HudState;
  balanceHidden: boolean;
  onToggleBalance: () => void;
  guideId: string;
  guideOpen: boolean;
  onToggleGuide: () => void;
  onDismissGuide: () => void;
  arrivalWaiting: boolean;
  onDismissArrival: () => void;
  helpRef?: Ref<HTMLButtonElement>;
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  const status = state.wallet ?? 'unknown';
  const { pending } = state;
  return (
    <aside className="journey-hud" aria-label={COPY.hud.label}>
      <div className="journey-hud-bar">
        <p className="journey-hud-wallet" data-status={status}>
          <span className="journey-hud-lamp" aria-hidden="true" />
          <span className="journey-hud-label">{COPY.hud.wallet[status]}</span>
        </p>
        <p className="journey-hud-balance">
          <span className="journey-hud-label">{COPY.hud.balance}</span>{' '}
          <strong>{balanceHidden ? COPY.hud.balanceHidden : state.balance ?? COPY.hud.balanceUnknown}</strong>
          <button
            type="button"
            className="journey-hud-toggle"
            aria-label={balanceHidden ? COPY.hud.showBalance : COPY.hud.hideBalance}
            onClick={onToggleBalance}
          >
            {balanceHidden ? COPY.hud.show : COPY.hud.hide}
          </button>
        </p>
        {pending > 0 ? (
          // A visual duplicate of the live region below, hidden from assistive
          // technology so the count is announced once.
          <p className="journey-hud-pending" aria-hidden="true">
            <span className="journey-hud-spinner" />
            <span>{pending}</span>
            <span className="journey-hud-label">{pending === 1 ? COPY.hud.pendingOne : COPY.hud.pendingMany}</span>
          </p>
        ) : null}
        <button
          ref={helpRef}
          type="button"
          className="journey-hud-help"
          aria-label={COPY.hud.help}
          aria-expanded={guideOpen}
          aria-controls={guideId}
          onClick={onToggleGuide}
        >
          ?
        </button>
      </div>
      <p className="journey-visually-hidden" role="status" aria-live="polite">
        {pendingAnnouncement(pending)}
      </p>
      {arrivalWaiting ? (
        <div className="journey-hud-nudge" role="note">
          <p>{COPY.next.bridgeArrival}</p>
          <button type="button" aria-label={COPY.next.dismissLabel} onClick={onDismissArrival}>
            {COPY.next.dismiss}
          </button>
        </div>
      ) : null}
      <GettingStarted
        id={guideId}
        titleId={`${guideId}-title`}
        open={guideOpen}
        headingRef={headingRef}
        onDismiss={onDismissGuide}
      />
    </aside>
  );
}

export function pendingAnnouncement(count: number): string {
  if (count <= 0) return COPY.hud.pendingNone;
  return `${count} ${count === 1 ? COPY.hud.pendingOne : COPY.hud.pendingMany}`;
}
