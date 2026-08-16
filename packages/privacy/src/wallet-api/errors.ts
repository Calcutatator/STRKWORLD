import { PrivacyError } from '../types.js';

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
  const message = readMessage(error) ?? safeMessage(kind);
  return new PrivacyError(kind, message, error);
}

function readCode(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null;
  const candidate = error as { code?: unknown; error?: unknown; cause?: unknown };
  if (typeof candidate.code === 'number') return candidate.code;
  return readCode(candidate.error) ?? readCode(candidate.cause);
}

function readMessage(error: unknown): string | null {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return null;
}

function safeMessage(kind: ReturnType<typeof mapKind>): string {
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

function mapKind():
  | 'user-rejected'
  | 'not-registered'
  | 'insufficient-balance'
  | 'privacy-leak'
  | 'unsupported-wallet'
  | 'unreachable'
  | 'unknown' {
  return 'unknown';
}
