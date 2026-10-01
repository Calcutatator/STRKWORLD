import { describe, expect, it } from 'vitest';
import {
  formatRatePercent,
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

describe('formatRatePercent (D-079)', () => {
  it.each([
    // Vesu's Prime supply APYs as its API stated them on 2026-09-30.
    [27351899613523568n, 18, '2.73%'],
    [30925508207480051n, 18, '3.09%'],
    [118732256710697075n, 18, '11.87%'],
    [403060248317937n, 18, '0.04%'],
    [3324823423464714n, 18, '0.33%'],
    [0n, 18, '0.00%'],
    [1n, 2, '1.00%'],
    [5n, 0, '500.00%'],
  ] as const)('shows %s at %s decimals as %s, truncated', (value, decimals, text) => {
    expect(formatRatePercent(value, decimals)).toBe(text);
  });

  it('never rounds a rate up', () => {
    expect(formatRatePercent(27_999_999_999_999_999n, 18)).toBe('2.79%');
  });

  it('shows a rate above zero but below a hundredth of a percent as under it, never as zero (D-081)', () => {
    // Vesu's supply APY for strkBTC in Re7 xBTC on 2026-09-30: 0.0006%.
    expect(formatRatePercent(5_981_411_732_929n, 18)).toBe('<0.01%');
    expect(formatRatePercent(1n, 18)).toBe('<0.01%');
    expect(formatRatePercent(99_999_999_999_999n, 18)).toBe('<0.01%');
    expect(formatRatePercent(100_000_000_000_000n, 18)).toBe('0.01%');
    expect(formatRatePercent(0n, 18)).toBe('0.00%');
  });
});
