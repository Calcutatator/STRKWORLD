import { describe, expect, it } from 'vitest';
import { HmacAuthorizationCodec, MemoryAuthorizationCodec } from './authorization.js';
import type { FeeAuthorizationClaims } from './types.js';

const SECRET = 'a-long-production-secret-that-is-not-committed';
const CLAIMS: FeeAuthorizationClaims = {
  v: 1, route: 'transfer', feeToken: '0x1', operationToken: '0x2', token: '0x1',
  recipient: '0x3', amount: 7n, issuedAtBlock: 1_000, expiresAtBlock: 1_450,
};

function encodeWire(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

describe('authorization wire codecs', () => {
  it('does not source a missing required claim from Object.prototype', async () => {
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'amount');
    Object.defineProperty(Object.prototype, 'amount', { value: '7', configurable: true });
    try {
      const wire = { ...CLAIMS };
      Reflect.deleteProperty(wire, 'amount');
      await expect(new MemoryAuthorizationCodec().verify(encodeWire(wire))).resolves.toBeNull();
    } finally {
      if (previous) Object.defineProperty(Object.prototype, 'amount', previous);
      else Reflect.deleteProperty(Object.prototype, 'amount');
    }
  });

  it.each([' +7 ', '0x7', '007'])('rejects a signed authorization with noncanonical amount %s', async (amount) => {
    const codec = new HmacAuthorizationCodec(SECRET);
    const token = await codec.issue({ ...CLAIMS, amount: amount as never });
    await expect(codec.verify(token)).resolves.toBeNull();
  });

  it('rejects a signed authorization with an incomplete swap binding', async () => {
    const codec = new HmacAuthorizationCodec(SECRET);
    const token = await codec.issue({ ...CLAIMS, route: 'swap', swap: { sellAmount: '7' } as never });
    await expect(codec.verify(token)).resolves.toBeNull();
  });
});
