import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react';
import type { EventBus, WorldEvents } from '@strkworld/shared';
import { offersBridgeArrival } from '../panels/next-step.js';
import { PRIVACY_REGISTER, type RouteGrade } from '../privacy/register.js';
import { useStore } from '../store/use-store.js';
import { browserViewerStorage, type ViewerStorage } from '../store/viewer-storage.js';
import { useWalletSessionOptional } from '../wallet/WalletSessionProvider.js';
import { createArrivalNudge } from './arrival-nudge.js';

export interface ArrivalNudgeView {
  /** True while the D-021 Bridge → Bank nudge belongs on screen. */
  readonly waiting: boolean;
  refresh(): void;
  dismiss(): void;
}

const ArrivalNudgeContext = createContext<ArrivalNudgeView | null>(null);

/** Null outside the provider, so a surface rendered without it shows no nudge. */
export function useArrivalNudge(): ArrivalNudgeView | null {
  return useContext(ArrivalNudgeContext);
}

/**
 * One nudge for the whole Shell, shared by the HUD and the Bank window so a
 * dismissal in either place is a dismissal in both.
 *
 * The saved Bridge record changes only through the Bridge window, another tab
 * or an import, so it is re-read on the moments that can follow one — a
 * building entered or left, another tab's storage write, the page regaining
 * focus — and never on a timer. The production composition binds the nudge to
 * the connected account; the demo composition has no wallet session to bind.
 */
export function ArrivalNudgeProvider({
  world,
  storage = browserViewerStorage,
  register = PRIVACY_REGISTER,
  children,
}: {
  world: EventBus<WorldEvents>;
  storage?: ViewerStorage;
  register?: readonly RouteGrade[];
  children: ReactNode;
}) {
  const wallet = useWalletSessionOptional();
  const account = wallet ? wallet.snapshot.account : undefined;
  const accountRef = useRef(account);
  accountRef.current = account;
  const nudge = useMemo(
    () => createArrivalNudge({ storage, account: () => accountRef.current }),
    [storage],
  );
  const state = useStore(nudge.store);

  useEffect(() => {
    nudge.refresh();
  }, [nudge, account]);

  useEffect(() => {
    const refresh = (): void => nudge.refresh();
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') refresh();
    };
    const stops = [world.on('building:entered', refresh), world.on('building:exited', refresh)];
    window.addEventListener('storage', refresh);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      for (const stop of stops.splice(0)) stop();
      window.removeEventListener('storage', refresh);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [nudge, world]);

  const offered = offersBridgeArrival(register);
  const value = useMemo<ArrivalNudgeView>(
    () => Object.freeze({
      waiting: offered && state.waiting,
      refresh: nudge.refresh,
      dismiss: nudge.dismiss,
    }),
    [offered, state.waiting, nudge],
  );

  return <ArrivalNudgeContext.Provider value={value}>{children}</ArrivalNudgeContext.Provider>;
}
