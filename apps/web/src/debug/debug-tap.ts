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

/**
 * One step of a Vault call (D-077): the probe of whether a wallet runs STRK20
 * shadow accounts end to end. Yes/no answers, wallet error codes and stage
 * names only, never an amount, a balance, an address, the commitment or a
 * transaction hash; the logger admits each field only from a fixed list.
 */
export type VaultDebugStep =
  /** The version query at the counter: whether shadow accounts are offered, and the Wallet API it reported. */
  | { readonly step: 'capability'; readonly supported: boolean; readonly walletApi: string | null }
  /** A stage the seam reported (`VaultStage`), passed on as it came. */
  | { readonly step: 'stage'; readonly stage: unknown }
  /** A prepare starting: which way, and whether it is everything. The Borrow counter's four ways too (D-083). */
  | { readonly step: 'prepare'; readonly kind: VaultDebugKind; readonly all: boolean }
  /** A confirm stage, or how the attempt ended here. */
  | { readonly step: 'confirm'; readonly kind: VaultDebugKind; readonly stage: string };

/** A Vault action's kind, or the Borrow counter's (D-083), which stands in the Vault's room. */
export type VaultDebugKind = 'supply' | 'redeem' | 'borrow' | 'add-collateral' | 'repay' | 'withdraw-collateral';

/**
 * A moment at the football pitch (D-078): the local player kicked, a goal
 * went in for a side, or a side won at full time. Never who: no identifier,
 * no position, no player count.
 */
export type FootballDebugStep =
  | { readonly event: 'kick' }
  | { readonly event: 'goal'; readonly side: 'west' | 'east' }
  | { readonly event: 'full-time'; readonly winner: 'west' | 'east' };

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
  /**
   * A shell-game result at the Privacy Plaza (D-076): win or lose, and
   * nothing else. Optional, so a tap written before the plaza still fits.
   */
  plazaShells?(result: unknown): void;
  /** A Vault step (D-077), by code only. Optional, like `plazaShells`. */
  vault?(step: unknown): void;
  /** A football moment (D-078): a kick, a goal's side, full time's winner. Optional, like `vault`. */
  football?(step: unknown): void;
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

/**
 * A round of "Where's the note?" ended (D-076). The result only: no
 * identifier, no streak, no timing beyond the line's own.
 */
export function debugPlazaShells(result: 'win' | 'lose'): void {
  if (!tap) return;
  try {
    tap.plazaShells?.(result);
  } catch {
    // As above.
  }
}

/**
 * A Vault step (D-077), by code only: see `VaultDebugStep`. The probe of
 * shadow-account support reads these lines.
 */
export function debugVault(step: VaultDebugStep): void {
  if (!tap) return;
  try {
    tap.vault?.(step);
  } catch {
    // As above.
  }
}

/**
 * A football moment (D-078), by side at most: see `FootballDebugStep`. The
 * kick is the local player's own; goals and full time are everyone's.
 */
export function debugFootball(step: FootballDebugStep): void {
  if (!tap) return;
  try {
    tap.football?.(step);
  } catch {
    // As above.
  }
}
