/**
 * The private placement's debug seam (D-122, amended 2026-10-02; D-069's
 * channel).
 *
 * Receipts fail open by design: when one cannot be attached the action still
 * goes out, unchanged and silent. That silence is exactly what made the first
 * probe deploy unreadable — every piece of configuration was right, the
 * review simply never said "Counts toward your private placement" and nobody
 * could see which step had declined. So each decision now reports itself, as a
 * reason code and nothing else.
 *
 * **What may be written: a code from the unions below.** Never the season
 * partial commitment `p`, never a full commitment, never a shadow-account
 * address, never the connected account, never a nonce, never a transaction
 * hash, never an amount. `p` in particular lives in one object's memory for the
 * connection and must not reach a log, an error or a callback.
 *
 * The sink is a module-level singleton, like the Shell's own `debug-tap.ts`,
 * and is installed only by a build compiled with `VITE_DEBUG_LOGS=true` whose
 * page was opened with `?debug=1`. Until then every call here is a no-op that
 * holds and sends nothing, and a sink that throws can never disturb the money
 * path it observes.
 */

/** Why no receipt rode on an action that pays the pool fee. Codes only. */
export type LeaderboardSkipReason =
  /** The route policy names no ledger: the leaderboard is off for this session. */
  | 'no-ledger'
  /** The placement's backend reads are not configured, so no nonce can be found. */
  | 'no-reads'
  /** This wallet does not run STRK20 shadow accounts, so it cannot write a receipt. */
  | 'unsupported-route'
  /** This season's receipt nonces are used up. */
  | 'no-nonce'
  /** The season commitment was refused, or the nonce scan failed or did not verify. */
  | 'scan-failed';

/** The DeFi counters whose own shadow account carries a tick. */
export type LeaderboardFeature = 'vault' | 'borrow' | 'unstake' | 'swap';

export type LeaderboardNotice =
  /** A receipt joined the transaction a shield, unshield or send is about to send. */
  | { readonly event: 'receipt'; readonly attached: true }
  /** No receipt could join it, and why. */
  | { readonly event: 'receipt'; readonly attached: false; readonly reason: LeaderboardSkipReason }
  /** `ledger.tick` was appended to a DeFi counter's own shadow-account invoke. */
  | { readonly event: 'tick'; readonly feature: LeaderboardFeature };

export type LeaderboardNoticeSink = (notice: LeaderboardNotice) => void;

let sink: LeaderboardNoticeSink | null = null;

/**
 * Attach the opt-in debug logger, or detach it with null. Only the Shell's
 * `debug-logs.ts` side calls this, and only while D-069's two gates are open.
 */
export function setLeaderboardNoticeSink(next: LeaderboardNoticeSink | null): void {
  sink = next;
}

/** Report one decision. A no-op without a sink, and never a throw. */
export function noticeLeaderboard(notice: LeaderboardNotice): void {
  if (!sink) return;
  try {
    sink(notice);
  } catch {
    // The logger must never disturb the path it observes.
  }
}
