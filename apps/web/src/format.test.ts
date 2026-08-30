import { describe, expect, it } from 'vitest';
import {
  formatStrk,
  formatTokenAmount,
  formatTokenAmountExact,
  looksLikeAddress,
  parseTokenAmount,
  sameAddress,
  shortenAddress,
} from './format.js';

describe('parseTokenAmount', () => {
  it('parses whole and fractional input at 18 decimals', () => {
    expect(parseTokenAmount('1')).toBe(1_000000000000000000n);
    expect(parseTokenAmount('0.5')).toBe(500000000000000000n);
    expect(parseTokenAmount(' 12.25 ')).toBe(12_250000000000000000n);
  });

  it('survives amounts past Number.MAX_SAFE_INTEGER', () => {
    expect(parseTokenAmount('123456789.123456789012345678')).toBe(
      123456789_123456789012345678n,
    );
  });

  it('refuses input it would have to change to accept', () => {
    // Truncating a digit off somebody's amount is not a rounding decision.
    expect(parseTokenAmount('1.0000000000000000001')).toBeNull();
    expect(parseTokenAmount('-1')).toBeNull();
    expect(parseTokenAmount('1e18')).toBeNull();
    expect(parseTokenAmount('')).toBeNull();
    expect(parseTokenAmount('abc')).toBeNull();
    expect(parseTokenAmount('1.2.3')).toBeNull();
  });
});

describe('formatting', () => {
  it('round-trips exact values', () => {
    const amount = 123456789_123456789012345678n;
    expect(parseTokenAmount(formatTokenAmountExact(amount))).toBe(amount);
  });

  it('truncates towards zero for ambient display', () => {
    expect(formatTokenAmount(1_999999999999999999n)).toBe('1.9999');
    expect(formatTokenAmount(1_000000000000000000n)).toBe('1');
    expect(formatTokenAmount(0n)).toBe('0');
    expect(formatStrk(12_500000000000000000n)).toBe('12.5 STRK');
  });
});

describe('addresses', () => {
  it('compares padded and unpadded spellings as one address', () => {
    expect(sameAddress('0x04ab', '0x4ab')).toBe(true);
    expect(sameAddress('0x04ab', '0x04ac')).toBe(false);
    expect(sameAddress('not-hex', 'not-hex')).toBe(false);
    expect(sameAddress('1234', '1234')).toBe(false);
    expect(sameAddress('0X04ab', '0X04ab')).toBe(false);
    expect(
      sameAddress(
        { toString: () => '0x04ab' } as never,
        { toString: () => '0x04ab' } as never,
      ),
    ).toBe(false);
  });

  it('shape-checks player input', () => {
    expect(looksLikeAddress('0x04718f5a')).toBe(true);
    expect(looksLikeAddress('0x')).toBe(false);
    expect(looksLikeAddress('bob.stark')).toBe(false);
  });

  it('shortens for display only', () => {
    expect(shortenAddress('0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd')).toBe('0x0471…1f5cd');
  });
});
