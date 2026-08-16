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
  const kind = code === null ? 'unreachable' : (CODE_TO_KIND[code as keyof typeof CODE_TO_KIND] ?? 'unknown');
  return new PrivacyError(kind, safeMessage(kind), error);
}

function readCode(error: unknown, seen = new Set<object>()): number | null {
  if (!error || typeof error !== 'object') return null;
  if (seen.has(error)) return null;
  seen.add(error);
  const candidate = error as { code?: unknown; error?: unknown; cause?: unknown };
  if (typeof candidate.code === 'number') return candidate.code;
  return readCode(candidate.error, seen) ?? readCode(candidate.cause, seen);
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
