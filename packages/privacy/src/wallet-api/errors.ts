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
  if (error instanceof PrivacyError) return error;
  const code = readCode(error);
  const kind = isAbortError(error)
    ? 'user-rejected'
    : code === null
      ? 'unreachable'
      : (CODE_TO_KIND[code as keyof typeof CODE_TO_KIND] ?? 'unknown');
  return new PrivacyError(kind, safeMessage(kind), error);
}

function isAbortError(error: unknown): boolean {
  if (error instanceof DOMException) {
    try {
      return error.name === 'AbortError';
    } catch {
      return false;
    }
  }
  return Boolean(error && typeof error === 'object' && readProperty(error, 'name') === 'AbortError');
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
    case 'insufficient-balance': return 'The private balance cannot cover the amount and fees.';
    case 'privacy-leak': return 'The wallet refused an action that could weaken privacy.';
    case 'unsupported-wallet': return 'This wallet does not support the required STRK20 Wallet API.';
    case 'unreachable': return 'The wallet or network could not be reached.';
    default: return 'The privacy operation failed.';
  }
}
