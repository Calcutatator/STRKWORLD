import type { Intent, PrivacyErrorKind } from '@strkworld/privacy';

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

/** Every kind, as a record so the compiler refuses a kind the seam adds and this misses. */
const KIND_SET: Readonly<Record<PrivacyErrorKind, true>> = Object.freeze({
  'not-registered': true,
  'recipient-not-registered': true,
  'insufficient-balance': true,
  'privacy-leak': true,
  'unsupported-wallet': true,
  'user-rejected': true,
  unreachable: true,
  'submission-uncertain': true,
  'relay-not-configured': true,
  'shadow-accounts-unsupported': true,
  'price-guard': true,
  unknown: true,
});
const KINDS = Object.freeze(Object.keys(KIND_SET)) as readonly PrivacyErrorKind[];

/** What the shell passes around instead of the seam's error class. */
export interface ShellFailure {
  kind: PrivacyErrorKind;
  /** The original throw, for logging. Never rendered. */
  cause: unknown;
  /**
   * The route that failed, when the panel knows it: a wallet's 114 maps to
   * kind `unknown`, which alone does not say a stake failed. Logged, never
   * rendered.
   */
  operation?: Intent['kind'];
  /**
   * D-126: a `price-guard` refusal's two figures, when the throw carried
   * them: how far below the oracle price the quote sat, and the cap that
   * floor allows, both in bps. The counter turns them into its own sentence;
   * the seam's message string is still never rendered.
   */
  priceGuard?: { readonly shortfallBps: number; readonly boundBps: number };
}

/** A whole number of bps a refusal may carry: nothing negative, nothing absurd. */
function bpsFigure(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 100_000 ? value : null;
}

/**
 * D-126: the guard's figures off a `price-guard` throw, read as own data
 * properties for the same reason `kind` is. Either figure missing or
 * malformed leaves them off, and the counter falls back to the kind's copy.
 */
function priceGuardFigures(error: object): ShellFailure['priceGuard'] {
  try {
    // Idempotent like the rest of this: a `ShellFailure` handed back in
    // carries the figures nested, the seam's throw carries them flat.
    const nested = Object.getOwnPropertyDescriptor(error, 'priceGuard');
    const source = nested && 'value' in nested && nested.value && typeof nested.value === 'object'
      ? (nested.value as object)
      : error;
    const shortfall = Object.getOwnPropertyDescriptor(source, 'shortfallBps');
    const bound = Object.getOwnPropertyDescriptor(source, 'boundBps');
    if (!shortfall || !('value' in shortfall) || !bound || !('value' in bound)) return undefined;
    const shortfallBps = bpsFigure(shortfall.value);
    const boundBps = bpsFigure(bound.value);
    if (shortfallBps === null || boundBps === null) return undefined;
    return Object.freeze({ shortfallBps, boundBps });
  } catch {
    return undefined;
  }
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
    try {
      const descriptor = Object.getOwnPropertyDescriptor(error, 'kind');
      // Error values can cross a provider or package boundary. Read only an
      // own data field: inherited/accessor values are not trustworthy, and a
      // throwing getter must not escape the sanitizing classifier.
      if (descriptor && 'value' in descriptor && isKind(descriptor.value)) {
        const priceGuard = descriptor.value === 'price-guard' ? priceGuardFigures(error) : undefined;
        return { kind: descriptor.value, cause: error, ...(priceGuard ? { priceGuard } : {}) };
      }
    } catch {
      // Hostile proxies and descriptor traps are unknown failures too.
    }
  }
  return { kind: 'unknown', cause: error };
}
