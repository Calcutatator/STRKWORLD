import type { AuthorizationCodec, FeeAuthorizationClaims } from './types.js';

function toWire(claims: FeeAuthorizationClaims) {
  return {
    ...claims,
    amount: claims.amount.toString(),
    swap: claims.swap
      ? { ...claims.swap, sellAmount: claims.swap.sellAmount.toString() }
      : undefined,
  };
}

function fromWire(value: unknown): FeeAuthorizationClaims | null {
  if (!isRecord(value)) return null;
  const record = value as Record<string, unknown>;
  try {
    if (
      !hasOwnDataFields(record, ['v', 'route', 'feeToken', 'operationToken', 'token', 'recipient', 'amount', 'issuedAtBlock', 'expiresAtBlock']) ||
      record.v !== 1 ||
      (record.route !== 'transfer' && record.route !== 'unshield' && record.route !== 'swap') ||
      !isStringRecord(record, ['feeToken', 'operationToken', 'token', 'recipient']) ||
      !isCanonicalDecimal(record.amount) ||
      !Number.isSafeInteger(record.issuedAtBlock) ||
      !Number.isSafeInteger(record.expiresAtBlock)
    ) return null;
    const swapDescriptor = Object.getOwnPropertyDescriptor(record, 'swap');
    if (swapDescriptor && !('value' in swapDescriptor)) return null;
    let swap: Record<string, unknown> | undefined;
    const wireSwap = swapDescriptor?.value;
    if (wireSwap !== undefined) {
      if (
        !isRecord(wireSwap) ||
        !hasOwnDataFields(wireSwap, ['executor', 'sellToken', 'buyToken', 'sellAmount', 'quoteExpiresAt', 'invokePrefix']) ||
        !isStringRecord(wireSwap, ['executor', 'sellToken', 'buyToken']) ||
        !isCanonicalDecimal(wireSwap.sellAmount) ||
        !Number.isSafeInteger(wireSwap.quoteExpiresAt) ||
        !Array.isArray(wireSwap.invokePrefix) ||
        wireSwap.invokePrefix.some((entry) => typeof entry !== 'string')
      ) return null;
      swap = wireSwap;
    }
    return {
      ...record,
      amount: BigInt(record.amount),
      swap: swap
        ? { ...swap, sellAmount: BigInt(swap.sellAmount as string) }
        : undefined,
    } as unknown as FeeAuthorizationClaims;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwnDataFields(record: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((field) => {
    const descriptor = Object.getOwnPropertyDescriptor(record, field);
    return Boolean(descriptor && 'value' in descriptor);
  });
}

function isStringRecord(record: Record<string, unknown>, fields: readonly string[]): boolean {
  return fields.every((field) => typeof record[field] === 'string');
}

function isCanonicalDecimal(value: unknown): value is string {
  return typeof value === 'string' && /^(?:0|[1-9][0-9]*)$/.test(value);
}

/** Test/local codec. Production must use HMAC; this only proves stateless flow. */
export class MemoryAuthorizationCodec implements AuthorizationCodec {
  async issue(claims: FeeAuthorizationClaims): Promise<string> {
    return base64UrlEncode(JSON.stringify(toWire(claims)));
  }

  async verify(token: string): Promise<FeeAuthorizationClaims | null> {
    try { return fromWire(JSON.parse(base64UrlDecode(token))); } catch { return null; }
  }
}

/** Stateless HMAC authorization; no per-request fee record is retained. */
export class HmacAuthorizationCodec implements AuthorizationCodec {
  private readonly keyPromise: Promise<CryptoKey>;

  constructor(secret: string) {
    if (secret.length < 32) throw new Error('Fee authorization secret must be at least 32 characters.');
    this.keyPromise = crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    );
  }

  async issue(claims: FeeAuthorizationClaims): Promise<string> {
    const payload = base64UrlEncode(JSON.stringify(toWire(claims)));
    const signature = await crypto.subtle.sign(
      'HMAC',
      await this.keyPromise,
      new TextEncoder().encode(payload),
    );
    return `${payload}.${bytesToBase64Url(new Uint8Array(signature))}`;
  }

  async verify(token: string): Promise<FeeAuthorizationClaims | null> {
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra) return null;
    try {
      const valid = await crypto.subtle.verify(
        'HMAC',
        await this.keyPromise,
        toArrayBuffer(base64UrlToBytes(signature)),
        new TextEncoder().encode(payload),
      );
      if (!valid) return null;
      return fromWire(JSON.parse(base64UrlDecode(payload)));
    } catch {
      return null;
    }
  }
}

function base64UrlEncode(value: string): string {
  return bytesToBase64Url(new TextEncoder().encode(value));
}

function base64UrlDecode(value: string): string {
  return new TextDecoder().decode(base64UrlToBytes(value));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}
