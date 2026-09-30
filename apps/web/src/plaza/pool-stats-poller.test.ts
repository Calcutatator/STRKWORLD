import { describe, expect, it, vi } from 'vitest';
import {
  POOL_STATS_INCOMPLETE_MS,
  POOL_STATS_JITTER,
  POOL_STATS_POLL_MS,
  POOL_STATS_RETRY_MS,
  POOL_STATS_TIMEOUT_MS,
  STALE_AFTER_MS,
  createPoolStatsPoller,
} from './pool-stats-poller.js';
import type { PoolStatsSnapshot, PoolStatsSource } from './pool-stats.js';

/**
 * When the plaza's figures are read (D-076): about once a minute, only while
 * the plaza is in view or the monument's window is open, never on a hidden
 * page; "…" on failure unless the last good figures are recent; backing off
 * to the minute when reads keep failing or a part stays uncounted.
 */

const FULL: PoolStatsSnapshot = Object.freeze({
  accounts: 2932,
  deposits24h: 23,
  valueUsd: 1_177_415,
  topHoldings: Object.freeze([]),
  valueAsOf: '2026-09-30T00:00:00.000Z',
  tokenCount: 40,
});
const PARTIAL: PoolStatsSnapshot = Object.freeze({ ...FULL, accounts: null });
/** Everything counted but the USD value: the other new "part" that also makes an answer incomplete. */
const VALUE_PENDING: PoolStatsSnapshot = Object.freeze({ ...FULL, valueUsd: null, topHoldings: null, valueAsOf: null, tokenCount: null });

/** An answer that never comes, whatever the signal says. */
const STALL = Symbol('stall');

function harness(answers: Array<PoolStatsSnapshot | Error | typeof STALL> = [FULL], random = () => 0) {
  let now = 0;
  let hidden = false;
  const timers: Array<{ at: number; run: () => void; live: boolean }> = [];
  const published: Array<PoolStatsSnapshot | null> = [];
  let answer = 0;
  const load = vi.fn(async (_signal?: AbortSignal): Promise<PoolStatsSnapshot> => {
    const next = answers[Math.min(answer, answers.length - 1)]!;
    answer += 1;
    if (next === STALL) return new Promise<PoolStatsSnapshot>(() => {});
    if (next instanceof Error) throw next;
    return next;
  });
  const source: PoolStatsSource = { demo: false, load };
  const poller = createPoolStatsPoller({
    source,
    publish: (stats) => published.push(stats),
    now: () => now,
    setTimer: (run, ms) => {
      const timer = { at: now + ms, run, live: true };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as { live: boolean }).live = false;
    },
    hidden: () => hidden,
    random,
  });
  const flush = async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return {
    poller,
    load,
    published,
    live: () => timers.filter((timer) => timer.live),
    /** When the next read is booked, from now. */
    nextIn: () => Math.min(...timers.filter((timer) => timer.live).map((timer) => timer.at)) - now,
    setHidden(value: boolean) {
      hidden = value;
    },
    async advance(ms: number) {
      now += ms;
      for (const timer of [...timers]) {
        if (!timer.live || timer.at > now) continue;
        timer.live = false;
        timer.run();
      }
      await flush();
    },
    flush,
  };
}

describe('the pool stats poller (D-076)', () => {
  it('reads nothing until the plaza is in view', async () => {
    const test = harness();
    await test.advance(10 * POOL_STATS_POLL_MS);
    expect(test.load).not.toHaveBeenCalled();
    expect(test.live()).toEqual([]);
  });

  it('reads as the plaza comes into view, then about once a minute, and stops when it leaves', async () => {
    const test = harness();
    test.poller.setNear(true);
    await test.flush();
    expect(test.load).toHaveBeenCalledTimes(1);
    expect(test.poller.store.getState()).toMatchObject({ status: 'ready', stats: FULL });
    // The World heard the figures (after a first "…" on the way in).
    expect(test.published.at(-1)).toBe(FULL);
    await test.advance(POOL_STATS_POLL_MS - 1);
    expect(test.load).toHaveBeenCalledTimes(1);
    await test.advance(1);
    expect(test.load).toHaveBeenCalledTimes(2);
    test.poller.setNear(false);
    expect(test.live()).toEqual([]);
    await test.advance(10 * POOL_STATS_POLL_MS);
    expect(test.load).toHaveBeenCalledTimes(2);
  });

  it('tells a new World the current figures when the plaza comes back into view, without reading early', async () => {
    const test = harness();
    test.poller.setNear(true);
    await test.flush();
    test.poller.setNear(false);
    await test.advance(10_000);
    const before = test.published.length;
    test.poller.setNear(true);
    await test.flush();
    expect(test.published.length).toBe(before + 1);
    expect(test.published.at(-1)).toBe(FULL);
    expect(test.load).toHaveBeenCalledTimes(1);
    // ...and it reads again once the minute is up.
    await test.advance(POOL_STATS_POLL_MS);
    expect(test.load).toHaveBeenCalledTimes(2);
  });

  it('keeps reading while the monument window is open, even away from the plaza', async () => {
    const test = harness();
    const close = test.poller.open();
    await test.flush();
    expect(test.load).toHaveBeenCalledTimes(1);
    await test.advance(POOL_STATS_POLL_MS);
    expect(test.load).toHaveBeenCalledTimes(2);
    close();
    close();
    expect(test.live()).toEqual([]);
  });

  it('asks again sooner while the backend is still counting a part, backing off to the minute', async () => {
    const test = harness([PARTIAL, PARTIAL, PARTIAL, PARTIAL, PARTIAL, FULL]);
    test.poller.setNear(true);
    await test.flush();
    expect(test.poller.store.getState().stats).toBe(PARTIAL);
    const waits: number[] = [];
    while (test.poller.store.getState().stats !== FULL) {
      waits.push(test.nextIn());
      await test.advance(test.nextIn());
    }
    expect(waits).toEqual([POOL_STATS_INCOMPLETE_MS, 20_000, 40_000, POOL_STATS_POLL_MS, POOL_STATS_POLL_MS]);
    // A full answer puts it back on the minute.
    expect(test.nextIn()).toBe(POOL_STATS_POLL_MS);
  });

  it('treats the USD value as its own part too (D-080): still asked again sooner while it alone is uncounted', async () => {
    const test = harness([VALUE_PENDING, FULL]);
    test.poller.setNear(true);
    await test.flush();
    expect(test.poller.store.getState().stats).toBe(VALUE_PENDING);
    expect(test.nextIn()).toBe(POOL_STATS_INCOMPLETE_MS);
    await test.advance(test.nextIn());
    expect(test.poller.store.getState().stats).toBe(FULL);
    expect(test.nextIn()).toBe(POOL_STATS_POLL_MS);
  });

  it('backs off after failed reads, a 429 included, to about once a minute with jitter', async () => {
    const test = harness([new Error('429')]);
    test.poller.setNear(true);
    await test.flush();
    const waits: number[] = [];
    for (let miss = 0; miss < 5; miss++) {
      waits.push(test.nextIn());
      await test.advance(test.nextIn());
    }
    expect(waits).toEqual([POOL_STATS_RETRY_MS, 30_000, POOL_STATS_POLL_MS, POOL_STATS_POLL_MS, POOL_STATS_POLL_MS]);
    expect(test.load).toHaveBeenCalledTimes(6);
    // The jitter only ever adds to a wait, by at most a quarter.
    const jittery = harness([new Error('429')], () => 0.999);
    jittery.poller.setNear(true);
    await jittery.flush();
    expect(jittery.nextIn()).toBeGreaterThan(POOL_STATS_RETRY_MS);
    expect(jittery.nextIn()).toBeLessThanOrEqual(POOL_STATS_RETRY_MS * (1 + POOL_STATS_JITTER));
  });

  it('does not read at once as the plaza comes back into view while it is backing off', async () => {
    const test = harness([new Error('down'), FULL]);
    test.poller.setNear(true);
    await test.flush();
    expect(test.load).toHaveBeenCalledTimes(1);
    // Walking back and forth across the plaza's edge asks for nothing more...
    for (let crossing = 0; crossing < 5; crossing++) {
      test.poller.setNear(false);
      test.poller.setNear(true);
      const close = test.poller.open();
      close();
      test.poller.wake();
    }
    await test.flush();
    expect(test.load).toHaveBeenCalledTimes(1);
    // ...until the retry is due.
    await test.advance(POOL_STATS_RETRY_MS);
    expect(test.load).toHaveBeenCalledTimes(2);
    expect(test.poller.store.getState()).toMatchObject({ status: 'ready', stats: FULL });
  });

  it('gives up a read that stalls, as a failure, and carries on', async () => {
    const test = harness([STALL, FULL]);
    test.poller.setNear(true);
    await test.flush();
    expect(test.poller.store.getState().status).toBe('loading');
    await test.advance(POOL_STATS_TIMEOUT_MS);
    expect(test.poller.store.getState()).toMatchObject({ status: 'failed', stats: null });
    expect(test.load.mock.calls[0]![0]!.aborted).toBe(true);
    await test.advance(POOL_STATS_RETRY_MS);
    expect(test.load).toHaveBeenCalledTimes(2);
    expect(test.poller.store.getState()).toMatchObject({ status: 'ready', stats: FULL });
  });

  it('keeps recent figures through a failed read, and shows "…" once they are stale', async () => {
    const failure = new Error('429');
    const test = harness([FULL, failure]);
    test.poller.setNear(true);
    await test.flush();
    await test.advance(POOL_STATS_POLL_MS);
    expect(test.poller.store.getState()).toMatchObject({ status: 'failed', stats: FULL });
    // While the retries keep failing, the figures age out.
    while (test.poller.store.getState().stats !== null) await test.advance(test.nextIn());
    expect(test.load.mock.calls.length).toBeLessThanOrEqual(6);
    expect(test.poller.store.getState()).toMatchObject({ status: 'failed', stats: null });
    expect(test.published.at(-1)).toBeNull();
  });

  it('shows "…" when the very first read fails', async () => {
    const test = harness([new Error('down')]);
    test.poller.setNear(true);
    await test.flush();
    expect(test.poller.store.getState()).toMatchObject({ status: 'failed', stats: null });
    expect(test.published.every((stats) => stats === null)).toBe(true);
  });

  it('reads nothing on a hidden page, and catches up when it is shown again', async () => {
    const test = harness();
    test.setHidden(true);
    test.poller.setNear(true);
    await test.advance(3 * POOL_STATS_POLL_MS);
    expect(test.load).not.toHaveBeenCalled();
    test.setHidden(false);
    test.poller.wake();
    await test.flush();
    expect(test.load).toHaveBeenCalledTimes(1);
  });

  it('can be released and started again', async () => {
    const test = harness();
    test.poller.setNear(true);
    test.poller.release();
    expect(test.live()).toEqual([]);
    await test.flush();
    test.poller.setNear(true);
    await test.flush();
    expect(test.poller.store.getState().stats).toBe(FULL);
  });

  it('sits idle with no source at all', async () => {
    const published: unknown[] = [];
    const poller = createPoolStatsPoller({ source: null, publish: (stats) => published.push(stats), hidden: () => false });
    poller.setNear(true);
    expect(poller.store.getState()).toEqual({ status: 'idle', stats: null, demo: false });
    expect(published).toEqual([null]);
    poller.release();
  });
});
