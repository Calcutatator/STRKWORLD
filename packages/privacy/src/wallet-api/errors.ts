import { PrivacyError, type PrivacyErrorKind } from '../types.js';

const CODE_TO_KIND = {
  113: 'user-rejected',
  118: 'not-registered',
  119: 'insufficient-balance',
  120: 'privacy-leak',
  162: 'unsupported-wallet',
  163: 'unknown',
} as const;

export function mapWalletError(error: unknown): PrivacyError {
  if (isPrivacyError(error)) return error;
  const code = readCode(error);
  const kind = isAbortError(error)
    ? 'user-rejected'
    : code === null
      ? 'unreachable'
      : (CODE_TO_KIND[code as keyof typeof CODE_TO_KIND] ?? 'unknown');
  return new PrivacyError(kind, safeMessage(kind), error);
}

/**
 * A wallet failure met while proving a private transfer (D-074). A 118 there
 * is reported as the recipient's, never as this account's: D-072 admits a
 * player only on a wallet answer about their own account that a 118 would
 * have refused. Every other failure maps as `mapWalletError` maps it.
 */
export function mapTransferWalletError(error: unknown): PrivacyError {
  const mapped = mapWalletError(error);
  if (mapped.kind !== 'not-registered') return mapped;
  return new PrivacyError(
    'recipient-not-registered',
    safeMessage('recipient-not-registered'),
    mapped.cause ?? mapped,
  );
}

/**
 * A wallet failure met on the Vault's shadow-account path (D-077): asking for
 * the commitment, or submitting the shadow-account action. A wallet that
 * answers either as an API version it does not support (162), or as a method
 * it does not know (JSON-RPC -32601), cannot run a shadow account yet: that
 * is `shadow-accounts-unsupported`, never this account's STRK20 support in
 * general, which would close the city. Every other failure maps as
 * `mapWalletError` maps it, so a 118 is still `not-registered`.
 */
export function mapShadowWalletError(error: unknown): PrivacyError {
  if (isPrivacyError(error)) return error;
  const code = readCode(error);
  if (code === 162 || code === JSON_RPC_METHOD_NOT_FOUND) {
    return new PrivacyError('shadow-accounts-unsupported', safeMessage('shadow-accounts-unsupported'), error);
  }
  return mapWalletError(error);
}

/**
 * A wallet failure met on the capability probe, `wallet_supportedWalletApi`.
 * A wallet that answers it at all is reachable. When the answer says the
 * method is not there (JSON-RPC -32601, EIP-1474's -32004 or EIP-1193's 4200,
 * or a message such as "Method not found", "Unknown method" or "Not
 * implemented"), the wallet has no STRK20 Wallet API: that is
 * `unsupported-wallet`, the wallet's own room, never `unreachable`, whose
 * "Try again" could not help. A wallet code with a meaning of its own (113,
 * 118, 119, 120, 162) keeps it, a cancellation stays a cancellation, and
 * every other failure maps as `mapWalletError` maps it, so a dropped
 * transport or a timeout is still `unreachable`.
 *
 * The message is read only to classify, as an own data property, and is
 * never kept or logged: a wallet may fill it with an address (D-069).
 */
export function mapCapabilityWalletError(error: unknown): PrivacyError {
  if (isPrivacyError(error) || isAbortError(error)) return mapWalletError(error);
  const code = readCode(error);
  if (code !== null && DEFINED_CODES.has(code)) return mapWalletError(error);
  if ((code !== null && UNSUPPORTED_METHOD_CODES.has(code)) || namesMissingMethod(error)) {
    return new PrivacyError('unsupported-wallet', safeMessage('unsupported-wallet'), error);
  }
  return mapWalletError(error);
}

/** Codes whose meaning is the wallet's own, which no message can override. */
const DEFINED_CODES: ReadonlySet<number> = new Set([113, 118, 119, 120, 162]);

/**
 * "This method does not exist here": JSON-RPC 2.0's method not found,
 * EIP-1474's method not supported, and EIP-1193's unsupported method.
 */
const UNSUPPORTED_METHOD_CODES: ReadonlySet<number> = new Set([-32601, -32004, 4200]);

const MISSING_METHOD_PATTERNS: readonly RegExp[] = [
  /\bmethod not found\b/i,
  /\bunknown (?:rpc )?(?:method|request)\b/i,
  /\bunsupported (?:rpc )?(?:method|request)\b/i,
  /\bnot implemented\b/i,
  /\bmethod\b.{0,80}\b(?:does not exist|is not available|(?:is )?not supported|not found)\b/i,
];

/** Longest message the classifier reads; anything past it is ignored. */
const MAX_CLASSIFIED_MESSAGE = 512;

function namesMissingMethod(error: unknown): boolean {
  const message = readMessage(error);
  if (message === null) return false;
  const bounded = message.slice(0, MAX_CLASSIFIED_MESSAGE);
  return MISSING_METHOD_PATTERNS.some((pattern) => pattern.test(bounded));
}

/** A thrown string, or the first own string `message` down `error` and `cause`. */
function readMessage(error: unknown, seen = new Set<object>()): string | null {
  if (typeof error === 'string') return error;
  if (!error || typeof error !== 'object') return null;
  if (seen.has(error)) return null;
  seen.add(error);
  const message = readProperty(error, 'message');
  if (typeof message === 'string' && message.length > 0) return message;
  return readMessage(readProperty(error, 'error'), seen) ?? readMessage(readProperty(error, 'cause'), seen);
}

/**
 * The wallet's own numeric error code, read without running a getter, or
 * null. Codes only: the probe logs (D-069) record this and never the
 * message, which a wallet may fill with an address.
 */
export function walletErrorCode(error: unknown): number | null {
  const code = readCode(error);
  return code !== null && Number.isSafeInteger(code) ? code : null;
}

/** JSON-RPC 2.0's "method not found". */
const JSON_RPC_METHOD_NOT_FOUND = -32601;

function isPrivacyError(error: unknown): error is PrivacyError {
  try {
    return error instanceof PrivacyError;
  } catch {
    return false;
  }
}

function isAbortError(error: unknown): boolean {
  try {
    if (error instanceof DOMException) {
      try {
        return error.name === 'AbortError';
      } catch {
        return false;
      }
    }
    return Boolean(error && typeof error === 'object' && readProperty(error, 'name') === 'AbortError');
  } catch {
    return false;
  }
}

function readCode(error: unknown, seen = new Set<object>()): number | null {
  if (!error || typeof error !== 'object') return null;
  if (seen.has(error)) return null;
  seen.add(error);
  const code = readProperty(error, 'code');
  if (typeof code === 'number') return code;
  return readCode(readProperty(error, 'error'), seen) ?? readCode(readProperty(error, 'cause'), seen);
}

/** Read error metadata without invoking hostile accessors. */
function readProperty(value: object, key: PropertyKey): unknown {
  try {
    let current: object | null = value;
    while (current !== null) {
      const descriptor = Object.getOwnPropertyDescriptor(current, key);
      if (descriptor) {
        if ('value' in descriptor) return descriptor.value;
        return undefined;
      }
      current = Object.getPrototypeOf(current) as object | null;
    }
  } catch {
    // Malformed wallet errors must still map to an opaque PrivacyError.
  }
  return undefined;
}

function safeMessage(kind: PrivacyErrorKind): string {
  switch (kind) {
    case 'user-rejected': return 'The wallet request was declined.';
    case 'not-registered': return 'This wallet is not registered with the privacy pool.';
    case 'recipient-not-registered': return 'The recipient is not registered with the privacy pool.';
    case 'insufficient-balance': return 'The private balance cannot cover the amount and fees.';
    case 'privacy-leak': return 'The wallet refused an action that could weaken privacy.';
    case 'unsupported-wallet': return 'This wallet does not support the required STRK20 Wallet API.';
    case 'shadow-accounts-unsupported': return 'This wallet does not support STRK20 shadow accounts yet.';
    case 'unreachable': return 'The wallet or network could not be reached.';
    default: return 'The privacy operation failed.';
  }
}
