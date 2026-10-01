import { describe, expect, it } from 'vitest';
import { COPY } from '../../copy.js';
import { estimateText, rateRow, rateText, strkForXstrk, xstrkForStrk } from './endur-rate.js';

/** D-091: the staking counter's estimates at xSTRK's live rate. */

const ONE = 10n ** 18n;
/** Read from xSTRK's `convert_to_assets(10^18)` at block 15,734,660. */
const LIVE = 1_183_444_769_437_096_259n;

describe("xSTRK's rate in the staking counter's rows (D-091)", () => {
  it('converts both ways, flooring as an ERC-4626 vault does', () => {
    expect(xstrkForStrk(10n * ONE, LIVE)).toBe(8_449_908_486_017_885_818n);
    expect(strkForXstrk(10n * ONE, LIVE)).toBe(11_834_447_694_370_962_590n);
    expect(xstrkForStrk(5n * ONE, 5n * ONE / 4n)).toBe(4n * ONE);
    expect(strkForXstrk(4n * ONE, 5n * ONE / 4n)).toBe(5n * ONE);
  });

  it('estimates nothing from nothing, or from no rate', () => {
    expect(xstrkForStrk(0n, LIVE)).toBe(0n);
    expect(strkForXstrk(1n, 0n)).toBe(0n);
    expect(estimateText(0n, 'xSTRK')).toBeNull();
  });

  it('writes the rate and an estimate as Endur does, to four places', () => {
    expect(rateText(LIVE)).toBe('1 xSTRK = 1.1834 STRK');
    expect(estimateText(8_449_908_486_017_885_818n, 'xSTRK')).toBe('≈ 8.4499 xSTRK');
  });

  it('says when the rate is loading, unavailable, or the demo fake\'s', () => {
    expect(rateRow({ status: 'loading' }).value).toBe(COPY.stake.rateLoading);
    expect(rateRow({ status: 'unavailable' }).value).toBe(COPY.stake.rateUnavailable);
    expect(rateRow({ status: 'loaded', strkPerXstrk: LIVE, demo: false }).note).toBeUndefined();
    expect(rateRow({ status: 'loaded', strkPerXstrk: 5n * ONE / 4n, demo: true }).note).toBe(COPY.stake.demoRate);
  });
});
