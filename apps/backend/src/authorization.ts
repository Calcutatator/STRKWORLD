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
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  try {
    if (record.v !== 1 || typeof record.amount !== 'string') return null;
    const swap = record.swap && typeof record.swap === 'object'
      ? record.swap as Record<string, unknown>
      : undefined;
    return {
      ...record,
      amount: BigInt(record.amount),
      swap: swap
        ? { ...swap, sellAmount: BigInt(String(swap.sellAmount)) }
        : undefined,
    } as unknown as FeeAuthorizationClaims;
  } catch {
    return null;
  }
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
