import { describe, expect, it } from 'vitest';
import { COPY } from '../../copy.js';
import { balanceText, checkAmount, feeReserve, fractionOf, maxAfterReserve, primaryAction } from './amount-math.js';

const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const USDC = '0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb';
const ONE = 10n ** 18n;
const POOL = { feeAmount: 6n * ONE, feeToken: STRK };

describe('Max less the pool fee', () => {
  it('leaves the 6 STRK pool fee behind when the token pays it', () => {
    expect(maxAfterReserve(12n * ONE + 5n * 10n ** 17n, feeReserve(STRK, POOL))).toBe(6n * ONE + 5n * 10n ** 17n);
  });

  it('matches the fee token however its address is padded', () => {
    expect(feeReserve('0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d', POOL)).toBe(6n * ONE);
  });

  it('reserves nothing for a token that does not pay the fee', () => {
    expect(feeReserve(USDC, POOL)).toBe(0n);
    expect(maxAfterReserve(25_000_000n, feeReserve(USDC, POOL))).toBe(25_000_000n);
  });

  it('has no honest maximum when the fee, or the spendable figure, is unknown', () => {
    expect(feeReserve(STRK, null)).toBeNull();
    expect(maxAfterReserve(100n * ONE, null)).toBeNull();
    expect(maxAfterReserve(null, 0n)).toBeNull();
  });

  it('has no maximum when the fee eats the whole balance, or more', () => {
    expect(maxAfterReserve(6n * ONE, 6n * ONE)).toBeNull();
    expect(maxAfterReserve(5n * ONE, 6n * ONE)).toBeNull();
    expect(maxAfterReserve(6n * ONE + 1n, 6n * ONE)).toBe(1n);
  });

  it('keeps every wei of a balance far past Number.MAX_SAFE_INTEGER', () => {
    const balance = 123_456_789_012_345_678_901_234_567n;
    expect(maxAfterReserve(balance, 6n * ONE)).toBe(123_456_783_012_345_678_901_234_567n);
  });
});

describe('fractionOf', () => {
  it('halves, truncating towards zero', () => {
    expect(fractionOf(3n, 1n, 2n)).toBe(1n);
    expect(fractionOf(13n * ONE, 1n, 2n)).toBe(6n * ONE + 5n * 10n ** 17n);
  });

  it('refuses a zero denominator or a negative figure', () => {
    expect(() => fractionOf(1n, 1n, 0n)).toThrow(RangeError);
    expect(() => fractionOf(-1n, 1n, 2n)).toThrow(RangeError);
  });
});

describe('checkAmount', () => {
  const options = { decimals: 18, balance: 10n * ONE, minimum: ONE };

  it('treats blank and zero as nothing yet, not an error', () => {
    expect(checkAmount('', options).status).toBe('empty');
    expect(checkAmount('  ', options).status).toBe('empty');
    expect(checkAmount('0.0', options).status).toBe('empty');
  });

  it('calls malformed input, and more decimals than the token has, invalid', () => {
    for (const text of ['abc', '1.2.3', '-1', '1e3', '0.0000001']) {
      expect(checkAmount(text, { decimals: 6 }).status, text).toBe('invalid');
    }
  });

  it('flags more than the balance before less than the minimum', () => {
    expect(checkAmount('10.000000000000000001', options)).toEqual({ status: 'exceeds-balance', amount: 10n * ONE + 1n });
    expect(checkAmount('0.5', options)).toEqual({ status: 'below-minimum', amount: 5n * 10n ** 17n });
    expect(checkAmount('10', options)).toEqual({ status: 'ok', amount: 10n * ONE });
  });

  it('skips the checks it has no figure for', () => {
    expect(checkAmount('1000000', { decimals: 18 }).status).toBe('ok');
    expect(checkAmount('1000000', { decimals: 18, balance: null, minimum: null }).status).toBe('ok');
  });
});

describe('primaryAction', () => {
  const ready = 'Review swap';

  it('walks from busy, to no token, to no amount, to a bad one, to ready', () => {
    expect(primaryAction({ check: checkAmount('1', { decimals: 18 }), symbol: 'STRK', ready, busy: 'Preparing…' })).toEqual({ label: 'Preparing…', disabled: true });
    expect(primaryAction({ check: checkAmount('1', { decimals: 18 }), symbol: null, ready })).toEqual({ label: COPY.kit.chooseToken, disabled: true });
    expect(primaryAction({ check: checkAmount('', { decimals: 18 }), symbol: 'STRK', ready })).toEqual({ label: 'Enter an amount', disabled: true });
    expect(primaryAction({ check: checkAmount('x', { decimals: 18 }), symbol: 'STRK', ready })).toEqual({ label: COPY.kit.invalidAmount, disabled: true });
    expect(primaryAction({ check: checkAmount('11', { decimals: 18, balance: 10n * ONE }), symbol: 'STRK', ready })).toEqual({ label: 'Insufficient STRK', disabled: true });
    expect(primaryAction({ check: checkAmount('0.1', { decimals: 18, minimum: ONE }), symbol: 'STRK', ready })).toEqual({ label: COPY.kit.belowMinimum, disabled: true });
    expect(primaryAction({ check: checkAmount('1', { decimals: 18 }), symbol: 'STRK', ready })).toEqual({ label: ready, disabled: false });
  });

  it('says a panel\'s own words for an amount above its figure, as a repay above the debt', () => {
    expect(primaryAction({ check: checkAmount('11', { decimals: 18, balance: 10n * ONE }), symbol: 'USDC', ready, exceeds: 'More than you owe' }))
      .toEqual({ label: 'More than you owe', disabled: true });
  });
});

describe('balanceText', () => {
  it('shortens without rounding up', () => {
    expect(balanceText(12n * ONE + 5n * 10n ** 17n, 18, 'STRK')).toBe('12.5 STRK');
    expect(balanceText(1_999_999n, 6, 'USDC')).toBe('1.9999 USDC');
  });
});
