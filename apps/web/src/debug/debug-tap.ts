/**
 * The Shell's taps into the opt-in debug logger (D-069).
 *
 * The places where failures and transitions are already funnelled call these.
 * Each is a no-op until `debug-logs.ts` attaches a tap, which happens only in
 * a build compiled with `VITE_DEBUG_LOGS=true` whose page was opened with
 * `?debug=1`. A launch build never loads that module, so these stay no-ops
 * that hold, buffer and send nothing. A tap can never break its caller.
 */

/**
 * One step in the Bank (D-070): a mode switch, an add the Bank refused, a
 * prepare starting, or a confirm stage. Codes, intent kinds and a count only,
 * never an amount, a balance, a recipient or a token address; the logger
 * admits each field only from a fixed list, so a wrong value is dropped.
 */
export type BankDebugStep =
  | { readonly step: 'mode'; readonly mode: string; readonly from: string }
  | { readonly step: 'add-refused'; readonly reason: string }
  | { readonly step: 'prepare'; readonly kinds: readonly string[] }
  | { readonly step: 'confirm'; readonly stage: string };

export interface DebugTap {
  /** A privacy or wallet failure: its PrivacyError kind, wallet code and message. */
  failure(event: string, error: unknown): void;
  /** A connect-flow state, as published. */
  connectState(state: unknown): void;
  /** A wallet-session snapshot, as the Shell sees it. */
  walletSession(snapshot: unknown): void;
  /** A building-visit transition, from which panel opens and closes are read. */
  visit(previous: unknown, next: unknown): void;
  /** A Bank step, by code only. */
  bank(step: unknown): void;
  /** D-071: the sandbox burst, by the tile it came from and nothing else. */
  sandboxBurst(tile: unknown): void;
  /** An entry-gate transition (D-072), by state name only. */
  gate(state: unknown): void;
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

export function debugBank(step: BankDebugStep): void {
  if (!tap) return;
  try {
    tap.bank(step);
  } catch {
    // As above.
  }
}

/** A sandbox tile, spelled out: this module imports nothing, so it stays inert. */
export interface DebugSandboxTile {
  readonly x: number;
  readonly y: number;
}

export function debugSandboxBurst(tile: DebugSandboxTile): void {
  if (!tap) return;
  try {
    tap.sandboxBurst(tile);
  } catch {
    // As above.
  }
}

/**
 * The entry gate moved to a new state (D-072). The state's name only: never
 * an account, a token, an amount or a transaction hash.
 */
export function debugGate(state: string): void {
  if (!tap) return;
  try {
    tap.gate(state);
  } catch {
    // As above.
  }
}
