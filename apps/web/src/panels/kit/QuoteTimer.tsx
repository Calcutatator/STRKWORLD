import { useEffect, useRef, useState } from 'react';
import { COPY } from '../../copy.js';

/**
 * A quote's refresh countdown: "Quote refreshes in 12s", with a thin bar.
 *
 * `role="timer"` is not announced each second, which is the point: a screen
 * reader hears it when it goes there, not as a stream of numbers. `onExpire`
 * fires once per `expiresAt`. The bar only shortens a step a second; reduced
 * motion drops even the step's easing.
 */
export interface QuoteTimerProps {
  /** When the quote runs out, ms since the epoch. */
  readonly expiresAt: number;
  /** The quote's whole lifetime in ms, for the bar. Absent, no bar. */
  readonly lifetimeMs?: number;
  readonly onExpire?: () => void;
  /** A re-quote is in flight. */
  readonly refreshing?: boolean;
  readonly now?: () => number;
}

export function QuoteTimer({ expiresAt, lifetimeMs, onExpire, refreshing = false, now = Date.now }: QuoteTimerProps) {
  const [current, setCurrent] = useState(now);
  const fired = useRef<number | null>(null);
  const expire = useRef(onExpire);
  expire.current = onExpire;

  useEffect(() => {
    setCurrent(now());
    const timer = setInterval(() => setCurrent(now()), 1_000);
    return () => clearInterval(timer);
  }, [expiresAt, now]);

  const remainingMs = Math.max(0, expiresAt - current);
  useEffect(() => {
    if (remainingMs > 0 || fired.current === expiresAt) return;
    fired.current = expiresAt;
    expire.current?.();
  }, [remainingMs, expiresAt]);

  const seconds = Math.ceil(remainingMs / 1_000);
  const share = lifetimeMs && lifetimeMs > 0 ? Math.min(1, remainingMs / lifetimeMs) : null;
  return (
    <div className="ui-quote-timer" role="timer" data-refreshing={refreshing ? 'true' : undefined}>
      <span>{refreshing || seconds === 0 ? COPY.kit.refreshing : COPY.kit.refreshIn.replace('{seconds}', String(seconds))}</span>
      {share !== null ? (
        <span className="ui-quote-timer-track" aria-hidden="true">
          <span className="ui-quote-timer-bar" style={{ inlineSize: `${(share * 100).toFixed(1)}%` }} />
        </span>
      ) : null}
    </div>
  );
}
