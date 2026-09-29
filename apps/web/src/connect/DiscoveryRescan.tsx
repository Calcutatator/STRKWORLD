import { useEffect, useRef } from 'react';

/**
 * Looks for wallets again while a choose-a-wallet card is showing (D-073):
 * once as the card mounts, and each time the page becomes visible again, say
 * after the player installed or unlocked a wallet in another tab. The
 * session's own schedule covers its first five seconds. A look only ever adds
 * a wallet to the list; it never selects or connects one. Renders nothing.
 *
 * It keeps the latest `refresh` in a ref, so a new function from the next
 * snapshot does not count as a new mount and look again by itself.
 */
export function DiscoveryRescan({ refresh }: { refresh: () => void }): null {
  const latest = useRef(refresh);
  useEffect(() => {
    latest.current = refresh;
  }, [refresh]);
  useEffect(() => {
    const look = (): void => {
      try {
        latest.current();
      } catch {
        // Best effort, like the session's own looks; the card keeps "Look again".
      }
    };
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') look();
    };
    look();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);
  return null;
}
