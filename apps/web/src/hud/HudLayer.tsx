import { useEffect, useId, useMemo, useRef, useState, type Ref, type RefObject } from 'react';
import type { EventBus, ShellEvents } from '@strkworld/shared';
import { COPY } from '../copy.js';
import { shortenAddress } from '../format.js';
import { useArrivalNudge } from '../bridge/ArrivalNudgeProvider.js';
import { useWalletStatusSnapshot } from '../privacy/PrivacyProvider.js';
import { useStore } from '../store/use-store.js';
import { browserViewerStorage, type ViewerStorage } from '../store/viewer-storage.js';
import { useWalletSessionOptional } from '../wallet/WalletSessionProvider.js';
import { GettingStarted } from './GettingStarted.js';
import { createHudModel, type HudState } from './hud-model.js';

export const HUD_GUIDE_DISMISSED_KEY = 'strkworld.hud.guide-dismissed.v1';

/**
 * The street HUD (D-119): one quiet wallet pill in the top-left corner, what
 * is in flight, the D-021 Bridge nudge and the Getting started card.
 *
 * The pill shows the wallet's status lamp and one word. Pressing it opens a
 * tiny menu: "Help" reopens Getting started, and, where the composition
 * supplies `onSignOut` (production only), "Disconnect & return to menu" hands
 * the sign-out to the production root, which disconnects the wallet session;
 * the city, the lobby connection and the World then unmount and the D-115
 * title screen takes over. The HUD itself only asks: it never touches the
 * wallet, the lobby or the World.
 *
 * The menu takes keys only while it is open, and then only Escape. Closed,
 * nothing here listens to the keyboard, so E and the movement keys stay the
 * World's.
 *
 * A Shell overlay, not World geometry. Nothing here emits on the bus, reads a
 * balance or reaches the lobby. The guide's dismissal is a per-viewer
 * convenience in guarded storage, and the HUD renders the same without it.
 *
 * `wallet:status` is published from an effect in `PrivacyProvider`, above this
 * component, whenever the connect state changes, and the bus does not replay
 * (D-038). Since D-072 the HUD mounts only once the entry gate passes, so it
 * reads the current status as it subscribes and takes every later change from
 * the bus. Outside a provider (tests) it waits for the first event, as before.
 */
export function HudLayer({
  shell,
  storage = browserViewerStorage,
  onSignOut,
}: {
  shell: EventBus<ShellEvents>;
  storage?: ViewerStorage;
  /** Production only: disconnect the wallet and return to the title screen. */
  onSignOut?: () => Promise<void> | void;
}) {
  // Keyed on the bus: a different bus is a different stream.
  const model = useMemo(() => createHudModel(), [shell]);
  const state = useStore(model.store);
  const currentWallet = useWalletStatusSnapshot();
  useEffect(() => model.listen(shell, currentWallet ?? undefined), [model, shell, currentWallet]);
  const account = useWalletSessionOptional()?.snapshot.account ?? null;

  const arrival = useArrivalNudge();
  const [guide, setGuide] = useState(() => ({
    open: storage.read(HUD_GUIDE_DISMISSED_KEY) !== '1',
    focus: false,
  }));
  const [menuOpen, setMenuOpen] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const pillRef = useRef<HTMLButtonElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const guideId = useId();
  const menuId = useId();

  useEffect(() => {
    // Only a guide the player asked for takes focus; the first-run card
    // appears without pulling focus away from the street.
    if (guide.open && guide.focus) headingRef.current?.focus();
  }, [guide]);

  useMenuDismissal(menuOpen, wrapRef, (returnFocus) => {
    setMenuOpen(false);
    if (returnFocus) pillRef.current?.focus();
  });

  const closeGuide = (returnFocus: boolean): void => {
    setGuide({ open: false, focus: false });
    storage.write(HUD_GUIDE_DISMISSED_KEY, '1');
    if (returnFocus) pillRef.current?.focus();
  };

  const signOut = (): void => {
    if (!onSignOut || signingOut) return;
    setMenuOpen(false);
    setSigningOut(true);
    let pending: Promise<void> | void;
    try {
      pending = onSignOut();
    } catch {
      pending = undefined;
    }
    // The production root unmounts this HUD as the session forgets the
    // account; a wallet that refuses the disconnect call has still been
    // forgotten locally, so a failure here has nothing left to show.
    void Promise.resolve(pending).catch(() => undefined).finally(() => setSigningOut(false));
  };

  return (
    <HudView
      state={state}
      account={account}
      menuId={menuId}
      menuOpen={menuOpen}
      onToggleMenu={() => setMenuOpen((open) => !open)}
      guideId={guideId}
      guideOpen={guide.open}
      onHelp={() => {
        setMenuOpen(false);
        setGuide({ open: true, focus: true });
      }}
      onDismissGuide={() => closeGuide(true)}
      onSignOut={onSignOut ? signOut : undefined}
      signingOut={signingOut}
      arrivalWaiting={arrival?.waiting ?? false}
      onDismissArrival={() => arrival?.dismiss()}
      pillRef={pillRef}
      wrapRef={wrapRef}
      headingRef={headingRef}
    />
  );
}

/**
 * While the menu is open: Escape closes it (and goes no further, so the visit
 * layer does not also close a counter), and a press outside it closes it.
 * Closed, nothing is listened to.
 */
function useMenuDismissal(
  open: boolean,
  wrap: RefObject<HTMLElement | null>,
  close: (returnFocus: boolean) => void,
): void {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open || typeof window === 'undefined') return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current(true);
    };
    const onPointerDown = (event: Event): void => {
      const target = event.target;
      if (target instanceof Node && wrap.current?.contains(target)) return;
      closeRef.current(false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [open, wrap]);
}

/** Pure render half, so every state is testable without a DOM. */
export function HudView({
  state,
  account = null,
  menuId,
  menuOpen,
  onToggleMenu,
  guideId,
  guideOpen,
  onHelp,
  onDismissGuide,
  onSignOut,
  signingOut = false,
  arrivalWaiting,
  onDismissArrival,
  pillRef,
  wrapRef,
  headingRef,
}: {
  state: HudState;
  account?: string | null;
  menuId: string;
  menuOpen: boolean;
  onToggleMenu: () => void;
  guideId: string;
  guideOpen: boolean;
  onHelp: () => void;
  onDismissGuide: () => void;
  onSignOut?: () => void;
  signingOut?: boolean;
  arrivalWaiting: boolean;
  onDismissArrival: () => void;
  pillRef?: Ref<HTMLButtonElement>;
  wrapRef?: Ref<HTMLDivElement>;
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  const status = state.wallet ?? 'unknown';
  const { pending } = state;
  const short = status === 'connected' && account ? shortenAddress(account) : null;
  return (
    <aside className="journey-hud" aria-label={COPY.hud.label}>
      <div className="journey-hud-wallet" data-status={status} ref={wrapRef}>
        <button
          ref={pillRef}
          type="button"
          className="journey-hud-pill"
          aria-label={`${COPY.hud.wallet[status]}. ${COPY.hud.menuLabel}`}
          aria-expanded={menuOpen}
          aria-controls={menuId}
          onClick={onToggleMenu}
        >
          <span className="journey-hud-lamp" aria-hidden="true" />
          <span className="journey-hud-label">{signingOut ? COPY.hud.disconnecting : COPY.hud.wallet[status]}</span>
          {pending > 0 ? (
            // A visual duplicate of the live region below, hidden from
            // assistive technology so the count is announced once.
            <span className="journey-hud-pending" aria-hidden="true">
              <span className="journey-hud-spinner" />
              <span>{pending}</span>
            </span>
          ) : null}
        </button>
        <div id={menuId} className="journey-hud-menu" hidden={!menuOpen}>
          {short ? <p className="journey-hud-account">{short}</p> : null}
          <button
            type="button"
            className="journey-hud-menu-item"
            data-action="help"
            aria-controls={guideId}
            aria-expanded={guideOpen}
            onClick={onHelp}
          >
            {COPY.hud.help}
          </button>
          {onSignOut ? (
            <button
              type="button"
              className="journey-hud-menu-item"
              data-action="disconnect"
              disabled={signingOut}
              onClick={onSignOut}
            >
              {withPlainAmpersand(COPY.hud.disconnect)}
            </button>
          ) : null}
        </div>
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

/**
 * Silkscreen's ampersand reads as a dollar sign, which on a wallet control
 * looks like money. The `&` alone is set in the body face (VT323).
 */
function withPlainAmpersand(label: string) {
  const parts = label.split('&');
  return parts.flatMap((part, index) => (index === 0
    ? [part]
    : [<span key={index} className="journey-hud-amp">&amp;</span>, part]));
}

export function pendingAnnouncement(count: number): string {
  if (count <= 0) return COPY.hud.pendingNone;
  return `${count} ${count === 1 ? COPY.hud.pendingOne : COPY.hud.pendingMany}`;
}
