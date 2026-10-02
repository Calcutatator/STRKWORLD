import type { ReactNode } from 'react';
import { DetailRows, type DetailRow } from './DetailRows.js';

/**
 * Every counter's amounts, read the same way (D-103, the owner's standard):
 *
 * 1. **What you enter** — "You shield 25 STRK". The typed amount is the
 *    amount that moves; no fee is ever taken out of it.
 * 2. **What you get out directly** — "You receive 25 STRK", "≈ 4 xSTRK", the
 *    redeemed asset, the borrowed token. Left out only where nothing comes
 *    back to name.
 * 3. **The fees, added separately** — the pool fee, and a network fee where
 *    the wallet states one.
 * 4. **The total cost** — "Total from your wallet" or "from your pool": the
 *    amount plus the fees, in each token they are paid in.
 *
 * Rows that are not amounts (a rate, a waiting time, an APY, a health) come
 * after the total, so the four amounts always read top to bottom as one sum.
 * The building's look comes from `DetailRows`' `--ui-*` tokens.
 */
export interface AmountSummaryProps {
  /** One typed amount, or each of them in the form's order (a borrow's collateral, then its loan). */
  readonly entered: AmountRow | readonly AmountRow[];
  readonly receive?: { readonly label: ReactNode; readonly value: ReactNode; readonly note?: ReactNode } | null;
  readonly fees: readonly DetailRow[];
  readonly total?: { readonly label: ReactNode; readonly value: ReactNode; readonly note?: ReactNode } | null;
  readonly details?: readonly DetailRow[];
  readonly label?: string;
}

/** A label and its figure. */
export interface AmountRow {
  readonly label: ReactNode;
  readonly value: ReactNode;
}

/** The summary's rows, in the standard's order; exported so a review can assert on them. */
export function amountSummaryRows({ entered, receive, fees, total, details = [] }: AmountSummaryProps): DetailRow[] {
  const typed: readonly AmountRow[] = Array.isArray(entered) ? entered : [entered as AmountRow];
  const rows: DetailRow[] = typed.map((row, index) => ({ id: index === 0 ? 'entered' : `entered-${index + 1}`, label: row.label, value: row.value }));
  if (receive) rows.push({ id: 'receive', label: receive.label, value: receive.value, note: receive.note });
  rows.push(...fees);
  if (total) rows.push({ id: 'total', label: total.label, value: total.value, note: total.note, tone: 'emphasis' });
  rows.push(...details);
  return rows;
}

export function AmountSummary(props: AmountSummaryProps) {
  return (
    <div className="ui-amount-summary">
      <DetailRows rows={amountSummaryRows(props)} label={props.label} />
    </div>
  );
}

/**
 * A total across the tokens it is paid in, largest first by position:
 * "31 STRK", or "20 USDC + 6 STRK" when the amount and the fee differ.
 * Amounts in the same token are added before formatting.
 */
export function totalAcross(parts: readonly { readonly token: string; readonly amount: bigint; readonly format: (amount: bigint) => string }[]): string {
  const merged: { token: string; amount: bigint; format: (amount: bigint) => string }[] = [];
  for (const part of parts) {
    if (part.amount === 0n) continue;
    const same = merged.find((entry) => entry.token.toLowerCase() === part.token.toLowerCase());
    if (same) same.amount += part.amount;
    else merged.push({ ...part });
  }
  if (merged.length === 0) return parts[0] ? parts[0].format(0n) : '0';
  return merged.map((entry) => entry.format(entry.amount)).join(' + ');
}
