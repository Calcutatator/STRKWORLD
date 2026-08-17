import type { PrivacyErrorKind } from '@strkworld/privacy';

/**
 * Failure classification, structurally rather than by `instanceof`.
 *
 * The obvious implementation imports `PrivacyError` from `@strkworld/privacy`
 * and uses `instanceof`. That is a **value** import of the seam, and the seam's
 * entry point re-exports the wallet adapter, which pulls `starknet` — roughly
 * 900 kB — into whatever chunk touches it. The shell must be able to render a
 * connect screen without loading the chain, so the shell holds no value import
 * of the seam outside the lazily loaded demo module.
 *
 * The structural check is also more robust across module instances, which is
 * the usual reason `instanceof` quietly stops matching in a bundled app.
 */

const KINDS: readonly PrivacyErrorKind[] = [
  'not-registered',
  'insufficient-balance',
  'privacy-leak',
  'unsupported-wallet',
  'user-rejected',
  'unreachable',
  'unknown',
];

/** What the shell passes around instead of the seam's error class. */
export interface ShellFailure {
  kind: PrivacyErrorKind;
  /** The original throw, for logging. Never rendered. */
  cause: unknown;
}

function isKind(value: unknown): value is PrivacyErrorKind {
  return typeof value === 'string' && (KINDS as readonly string[]).includes(value);
}

/**
 * Anything the seam can throw, mapped to a failure class.
 *
 * Unmapped throws become `unknown` rather than reaching a player — a raw RPC
 * string on screen is a defect, not a diagnostic.
 *
 * Idempotent by design: a failure classified in a panel gets handed on to the
 * connect flow, so this has to accept its own output as readily as the seam's
 * error. Matching on the `kind` field rather than the class is what makes both
 * work, and it is why a re-classification cannot silently become `unknown`
 * halfway along the path from the wallet to the room.
 */
export function toFailure(error: unknown): ShellFailure {
  if (typeof error === 'object' && error !== null) {
    const candidate = error as { kind?: unknown };
    if (isKind(candidate.kind)) {
      return { kind: candidate.kind, cause: error };
    }
  }
  return { kind: 'unknown', cause: error };
}
