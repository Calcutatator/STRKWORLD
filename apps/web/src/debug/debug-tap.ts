/**
 * The Shell's taps into the opt-in debug logger (D-069).
 *
 * The places where failures and transitions are already funnelled call these.
 * Each is a no-op until `debug-logs.ts` attaches a tap, which happens only in
 * a build compiled with `VITE_DEBUG_LOGS=true` whose page was opened with
 * `?debug=1`. A launch build never loads that module, so these stay no-ops
 * that hold, buffer and send nothing. A tap can never break its caller.
 */

export interface DebugTap {
  /** A privacy or wallet failure: its PrivacyError kind, wallet code and message. */
  failure(event: string, error: unknown): void;
  /** A connect-flow state, as published. */
  connectState(state: unknown): void;
  /** A wallet-session snapshot, as the Shell sees it. */
  walletSession(snapshot: unknown): void;
  /** A building-visit transition, from which panel opens and closes are read. */
  visit(previous: unknown, next: unknown): void;
}

let tap: DebugTap | null = null;

/** Attach the live logger, or detach it with null. Only `debug-logs.ts` calls this. */
export function attachDebugTap(next: DebugTap | null): void {
  tap = next;
}

export function debugFailure(event: string, error: unknown): void {
  if (!tap) return;
  try {
    tap.failure(event, error);
  } catch {
    // The logger must never disturb the path it observes.
  }
}

export function debugConnectState(state: unknown): void {
  if (!tap) return;
  try {
    tap.connectState(state);
  } catch {
    // As above.
  }
}

export function debugWalletSession(snapshot: unknown): void {
  if (!tap) return;
  try {
    tap.walletSession(snapshot);
  } catch {
    // As above.
  }
}

export function debugVisit(previous: unknown, next: unknown): void {
  if (!tap || previous === next) return;
  try {
    tap.visit(previous, next);
  } catch {
    // As above.
  }
}
