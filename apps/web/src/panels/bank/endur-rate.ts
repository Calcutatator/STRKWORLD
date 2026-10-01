import { useEffect, useState } from 'react';
import type { PrivacyOperations } from '@strkworld/privacy';
import { COPY } from '../../copy.js';
import { formatTokenAmount } from '../../format.js';
import type { DetailRow } from '../kit/index.js';

/**
 * xSTRK's live exchange rate for the staking counter's preview rows (D-091).
 *
 * One public read when the staking view opens, through the seam and the
 * backend: no wallet is asked and no address is named, so reading it without
 * a click breaks none of the Bank's "nothing that could prompt is read on its
 * own" rules. It never refreshes on a timer.
 *
 * The figures it gives are estimates and are labelled so ("≈"). A stake's
 * xSTRK and an unstake request's STRK are fixed by Endur's vault when the
 * transaction runs, so the commit point still shows no figure from here
 * (D-063, D-041).
 */

export type EndurRateView =
  | { readonly status: 'loading' }
  | { readonly status: 'loaded'; readonly strkPerXstrk: bigint; readonly demo: boolean }
  | { readonly status: 'unavailable' };

const ONE_XSTRK = 10n ** 18n;

/** About how much xSTRK `strk` stakes for at this rate: ERC-4626 `convert_to_shares`, floored. */
export function xstrkForStrk(strk: bigint, strkPerXstrk: bigint): bigint {
  if (strk <= 0n || strkPerXstrk <= 0n) return 0n;
  return (strk * ONE_XSTRK) / strkPerXstrk;
}

/** About how much STRK `xstrk` unstakes for at this rate: `convert_to_assets`, floored. */
export function strkForXstrk(xstrk: bigint, strkPerXstrk: bigint): bigint {
  if (xstrk <= 0n || strkPerXstrk <= 0n) return 0n;
  return (xstrk * strkPerXstrk) / ONE_XSTRK;
}

/** "1 xSTRK = 1.1834 STRK". */
export function rateText(strkPerXstrk: bigint): string {
  return COPY.stake.rateLine.replace('{rate}', formatTokenAmount(strkPerXstrk, 18, 4));
}

/** "≈ 4.2251 xSTRK" style estimate, or null when there is nothing to estimate. */
export function estimateText(amount: bigint, symbol: string): string | null {
  return amount > 0n ? `≈ ${formatTokenAmount(amount, 18, 4)} ${symbol}` : null;
}

/** Read the rate once while `active`; a failed read is "unavailable", never a guess. */
export function useEndurRate(operations: PrivacyOperations, active: boolean): EndurRateView {
  const [view, setView] = useState<EndurRateView>({ status: 'loading' });
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setView({ status: 'loading' });
    operations.endurRate(controller.signal).then(
      (rate) => {
        if (!controller.signal.aborted) setView({ status: 'loaded', strkPerXstrk: rate.strkPerXstrk, demo: rate.origin === 'demo' });
      },
      () => {
        if (!controller.signal.aborted) setView({ status: 'unavailable' });
      },
    );
    return () => controller.abort();
  }, [operations, active]);
  return view;
}

/** The exchange rate row, shared with the unstaking counter (D-091). */
export function rateRow(rate: EndurRateView): DetailRow {
  return {
    id: 'rate',
    label: COPY.stake.exchangeRate,
    value: rate.status === 'loaded'
      ? rateText(rate.strkPerXstrk)
      : rate.status === 'loading' ? COPY.stake.rateLoading : COPY.stake.rateUnavailable,
    note: rate.status === 'loaded' && rate.demo ? COPY.stake.demoRate : undefined,
  };
}
