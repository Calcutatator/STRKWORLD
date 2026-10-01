import { createStore, type ReadableStore } from '../store/store.js';
import type { PoolStatsSnapshot, PoolStatsSource } from './pool-stats.js';

/**
 * When the Shell reads the plaza's pool stats (D-076): about once a minute,
 * and only while someone can see them — the plaza is in view (the World's
 * `plaza:nearby`) or the monument's window is open — on a visible page.
 * Each answer goes to the store the window reads and to `publish`, which
 * hands the World its pre-formatted figures. Whenever the plaza comes back
 * into view the current figures are published again, since the bus does not
 * replay (D-038).
 *
 * A failed read shows "…" unless the last good figures are recent: a
 * one-off miss keeps them, and after `STALE_AFTER_MS` they are dropped. A
 * failed read, or an answer with a part still uncounted (the backend's first
 * scan), is asked again sooner at first and then backs off, doubling up to
 * the minute with a little jitter, so a backend that keeps saying no (a 429
 * included) or a part that never fills is never asked more than about once a
 * minute. The plaza coming into view, or a window opening, reads at once
 * only when a read is due, never inside a backoff. A read that stalls is
 * given up as a failure.
 */

export const POOL_STATS_POLL_MS = 60_000;
/** The first wait after a failed read; each failure in a row doubles it, up to the poll. */
export const POOL_STATS_RETRY_MS = 15_000;
/** The first wait after an answer with a part still null; doubling likewise. */
export const POOL_STATS_INCOMPLETE_MS = 10_000;
/** Up to this share of a backoff's wait is added at random, so clients that failed together do not retry together. */
export const POOL_STATS_JITTER = 0.25;
/** A read not answered by then is given up, as a failure. */
export const POOL_STATS_TIMEOUT_MS = 15_000;
/** How long the last good figures outlive failed reads. */
export const STALE_AFTER_MS = 180_000;

export type PoolStatsStatus = 'idle' | 'loading' | 'ready' | 'failed';

export interface PoolStatsView {
  readonly status: PoolStatsStatus;
  /** The figures to show, or null for "…". */
  readonly stats: PoolStatsSnapshot | null;
  /** Demo figures, to be labelled as such. */
  readonly demo: boolean;
}

export interface PoolStatsPoller {
  readonly store: ReadableStore<PoolStatsView>;
  /** The World says the plaza came into view, or left it. */
  setNear(near: boolean): void;
  /** A window showing the figures opened; call the result when it closes. */
  open(): () => void;
  /** The page became visible again: read now if the figures are due. */
  wake(): void;
  /** Stop reading and forget the plaza's view: no timer, no read in flight. The poller can start again. */
  release(): void;
}

export interface PoolStatsPollerOptions {
  readonly source: PoolStatsSource | null;
  readonly publish: (stats: PoolStatsSnapshot | null) => void;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  /** Whether the page is hidden; a hidden page reads nothing. */
  readonly hidden?: () => boolean;
  /** In [0, 1): the backoff's jitter. */
  readonly random?: () => number;
}

export function createPoolStatsPoller(options: PoolStatsPollerOptions): PoolStatsPoller {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback, ms) => globalThis.setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  const hidden = options.hidden ?? (() => typeof document !== 'undefined' && document.visibilityState === 'hidden');
  const random = options.random ?? Math.random;
  const source = options.source;
  const store = createStore<PoolStatsView>(Object.freeze({ status: 'idle', stats: null, demo: source?.demo === true }));

  let near = false;
  let windows = 0;
  let timer: unknown = null;
  let inFlight: AbortController | null = null;
  let deadline: unknown = null;
  /** The earliest the next read may start. */
  let nextReadAt = Number.NEGATIVE_INFINITY;
  let lastGoodAt = Number.NEGATIVE_INFINITY;
  /** Reads in a row that failed or came back with a part uncounted. */
  let misses = 0;

  const wanted = (): boolean => near || windows > 0;

  const set = (status: PoolStatsStatus, stats: PoolStatsSnapshot | null): void => {
    store.setState(Object.freeze({ status, stats, demo: source?.demo === true }));
  };

  const publish = (stats: PoolStatsSnapshot | null): void => {
    try {
      options.publish(stats);
    } catch {
      // Presentation must never break the reads.
    }
  };

  const cancelTimer = (): void => {
    if (timer === null) return;
    clearTimer(timer);
    timer = null;
  };

  const schedule = (ms: number): void => {
    cancelTimer();
    if (!wanted()) return;
    timer = setTimer(() => {
      timer = null;
      read();
    }, ms);
  };

  const incomplete = (stats: PoolStatsSnapshot): boolean =>
    stats.accounts === null || stats.valueUsd === null;

  const cancelDeadline = (): void => {
    if (deadline === null) return;
    clearTimer(deadline);
    deadline = null;
  };

  /** Book the next read `ms` from now, and hold every other trigger off until then. */
  const after = (ms: number): void => {
    nextReadAt = now() + ms;
    schedule(ms);
  };

  /** A miss's wait: `first`, doubled for each miss in a row, up to the poll, plus jitter. */
  const backoff = (first: number): number => {
    misses += 1;
    const base = Math.min(POOL_STATS_POLL_MS, first * 2 ** Math.min(misses - 1, 16));
    return Math.round(base * (1 + POOL_STATS_JITTER * Math.min(Math.max(random(), 0), 1)));
  };

  function read(): void {
    if (!wanted() || inFlight) return;
    if (!source) return;
    if (hidden()) {
      // Nobody is looking; `wake` reads when the page is back.
      schedule(POOL_STATS_POLL_MS);
      return;
    }
    const controller = new AbortController();
    inFlight = controller;
    const shown = store.getState().stats;
    if (shown === null) set('loading', null);
    const failed = (): void => {
      if (inFlight !== controller) return;
      inFlight = null;
      cancelDeadline();
      const keep = now() - lastGoodAt < STALE_AFTER_MS ? store.getState().stats : null;
      set('failed', keep);
      if (keep === null) publish(null);
      after(backoff(POOL_STATS_RETRY_MS));
    };
    // A read that stalls is given up, so it can never stop the reads.
    deadline = setTimer(() => {
      deadline = null;
      controller.abort();
      failed();
    }, POOL_STATS_TIMEOUT_MS);
    void source.load(controller.signal).then(
      (stats) => {
        if (inFlight !== controller) return;
        inFlight = null;
        cancelDeadline();
        lastGoodAt = now();
        set('ready', stats);
        publish(stats);
        if (incomplete(stats)) {
          after(backoff(POOL_STATS_INCOMPLETE_MS));
        } else {
          misses = 0;
          after(POOL_STATS_POLL_MS);
        }
      },
      failed,
    );
  }

  const demandChanged = (): void => {
    if (!wanted()) {
      cancelTimer();
      return;
    }
    if (inFlight) return;
    const wait = nextReadAt - now();
    if (wait <= 0) {
      read();
    } else if (timer === null) {
      schedule(wait);
    }
  };

  return Object.freeze({
    store,
    setNear(next: boolean): void {
      const was = near;
      near = next === true;
      // The plaza came (back) into view: the World may be new, so tell it again.
      if (near && !was) publish(store.getState().stats);
      demandChanged();
    },
    open(): () => void {
      windows += 1;
      demandChanged();
      let open = true;
      return () => {
        if (!open) return;
        open = false;
        windows = Math.max(0, windows - 1);
        demandChanged();
      };
    },
    wake(): void {
      if (!wanted() || inFlight) return;
      if (now() >= nextReadAt) read();
    },
    release(): void {
      // Windows keep their own open/close pairs; only the World's view and
      // the reads end here.
      near = false;
      cancelTimer();
      cancelDeadline();
      inFlight?.abort();
      inFlight = null;
      if (store.getState().status === 'loading') set('idle', null);
    },
  });
}
