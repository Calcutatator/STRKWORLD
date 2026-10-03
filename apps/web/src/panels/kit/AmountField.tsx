import { useId, type ReactNode } from 'react';
import { COPY } from '../../copy.js';
import { formatTokenAmountExact, parseTokenAmount } from '../../format.js';
import { balanceText, checkAmount, fillFromBalance, fractionOf, type AmountCheck } from './amount-math.js';

/**
 * One amount input: label, the token beside the number, an optional balance
 * line, optional Max and 50%, an optional USD line and the field's own
 * validation message. See `index.ts` for when to use which part.
 */
export interface AmountFieldProps {
  readonly label: ReactNode;
  readonly value: string;
  readonly onChange: (text: string) => void;
  /** The token's decimals and ticker, for parsing, Max and messages. */
  readonly decimals: number;
  readonly symbol: string;
  /** The token slot: a `TokenSelect`, or nothing for a static ticker. */
  readonly token?: ReactNode;
  /**
   * The figure the field checks against and the balance line shows. Omit (or
   * `null`) and there is no balance line and no "exceeds" check.
   */
  readonly balance?: bigint | null;
  /**
   * The figure the amount is checked against when it is not `balance`
   * itself: a shield's wallet balance less the pool fee on top (D-094).
   * Omit to check against `balance`.
   */
  readonly limit?: bigint | null;
  /** The balance line's words; the pool balance by default. */
  readonly balanceLabel?: string;
  /**
   * D-131: a fee charged in **this same asset** on top of the amount, which a
   * press on the balance line keeps aside, as a Max does. Pass the figure the
   * panel already uses for its own `limit` and review — `feeReserve(token,
   * pool)`. Omit or `0n` when this action charges none in this asset, and the
   * press fills the balance exactly. `null` is "not known yet", and the line
   * cannot be pressed until it is.
   */
  readonly balanceFee?: bigint | null;
  /** A small control beside the balance line, such as re-reading it. */
  readonly balanceAction?: ReactNode;
  /** The message for an amount above `balance`; "More than your pool balance" by default. */
  readonly exceedsMessage?: string;
  /**
   * Opt-in Max: absent, there is no Max button. Called at render; `null`
   * disables the button (no honest maximum, see `maxAfterReserve`).
   */
  readonly max?: () => bigint | null;
  /** Opt-in 50% of what `max` returns. Needs `max`. */
  readonly half?: boolean;
  /** A smallest acceptable amount, checked as "below the minimum". */
  readonly minimum?: bigint | null;
  /** A pre-formatted USD value, shown under the field. */
  readonly usd?: string | null;
  /** A short line under the field, such as why Max left some behind. */
  readonly hint?: ReactNode;
  readonly name?: string;
  readonly disabled?: boolean;
  /**
   * A figure the player reads, not types: a swap's Buy side, filled from the
   * quote. No validation, no Max.
   */
  readonly readOnly?: boolean;
  /** The figure is being worked out (a quote in flight): shown as a skeleton, never as final. */
  readonly busy?: boolean;
  /** The figure is out of date (a quote that ran out): shown dimmed. */
  readonly stale?: boolean;
}

export function AmountField({
  label, value, onChange, decimals, symbol, token, balance = null, limit, balanceLabel = COPY.kit.poolBalance, balanceFee, balanceAction,
  exceedsMessage = COPY.kit.exceedsBalance, max, half = false, minimum = null, usd = null, hint, name = 'amount', disabled = false,
  readOnly = false, busy = false, stale = false,
}: AmountFieldProps) {
  const id = useId();
  const messageId = `${id}-message`;
  const hintId = `${id}-hint`;
  const check = checkAmount(readOnly ? '' : value, { decimals, balance: limit === undefined ? balance : limit, minimum });
  const message = amountMessage(check, minimum, decimals, symbol, exceedsMessage);
  const quick = max && !readOnly ? max : undefined;
  const maximum = quick ? quick() : null;
  const halfValue = maximum === null ? null : fractionOf(maximum, 1n, 2n);
  const fill = (amount: bigint | null) => {
    if (amount !== null && amount > 0n) onChange(formatTokenAmountExact(amount, decimals));
  };
  // D-131: what the balance line fills in, and the line explaining what it
  // kept aside, which supersedes the panel's own line while it applies.
  const fillable = readOnly ? null : fillFromBalance(balance, { fee: balanceFee, limit });
  const aside = keptAside(value, fillable, balanceFee, decimals);
  const note = aside === null ? hint : COPY.kit.feeKeptAside.replace('{amount}', balanceText(aside, decimals, symbol));
  const describedBy = [message ? messageId : null, note ? hintId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div
      className="ui-amount"
      data-invalid={message ? 'true' : undefined}
      data-readonly={readOnly ? 'true' : undefined}
      data-busy={busy ? 'true' : undefined}
      data-stale={stale && !busy ? 'true' : undefined}
    >
      <div className="ui-amount-head">
        <label htmlFor={id}>{label}</label>
        {balance !== null ? (
          <span className="ui-amount-balance">
            {balanceLabel}:{' '}
            <BalanceFigure
              balance={balance}
              fill={fillable}
              fee={balanceFee}
              decimals={decimals}
              symbol={symbol}
              disabled={disabled}
              onFill={() => fill(fillable)}
            />
          </span>
        ) : null}
        {balance !== null && balanceAction ? balanceAction : null}
        {quick ? (
          <span className="ui-amount-quick">
            {half ? (
              <button type="button" className="ui-chip" aria-label={COPY.kit.halfLabel} disabled={disabled || halfValue === null || halfValue === 0n} onClick={() => fill(halfValue)}>
                {COPY.kit.half}
              </button>
            ) : null}
            <button type="button" className="ui-chip" aria-label={COPY.kit.maxLabel} disabled={disabled || maximum === null} onClick={() => fill(maximum)}>
              {COPY.kit.max}
            </button>
          </span>
        ) : null}
      </div>
      <div className="ui-amount-box">
        <input
          id={id}
          name={name}
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          placeholder="0"
          value={busy ? '' : value}
          disabled={disabled}
          readOnly={readOnly}
          aria-busy={busy ? true : undefined}
          aria-invalid={message ? true : undefined}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
        />
        <span className="ui-amount-token">{token ?? <span className="ui-amount-symbol">{symbol}</span>}</span>
      </div>
      {usd ? <p className="ui-amount-usd">{usd}</p> : null}
      {note ? <p className="ui-amount-hint" id={hintId}>{note}</p> : null}
      <p className="ui-amount-message" id={messageId} aria-live="polite">{message}</p>
    </div>
  );
}

/**
 * The balance line's figure (D-131): a button that fills the amount with it,
 * or, where there is nothing honest to fill, the plain figure with a short
 * reason. The figure reads the same either way, in the numeric face every
 * amount uses (D-121).
 */
function BalanceFigure({
  balance, fill, fee, decimals, symbol, disabled, onFill,
}: {
  balance: bigint;
  /** What a press fills in; `null` leaves the figure unpressable. */
  fill: bigint | null;
  fee: bigint | null | undefined;
  decimals: number;
  symbol: string;
  disabled: boolean;
  onFill: () => void;
}) {
  const shown = balanceText(balance, decimals, symbol);
  if (fill === null) {
    // Not pressable: either the fee is unknown, or it is the whole of this
    // balance. Nothing read yet shows no line at all, so it never lands here.
    const why = fee === null
      ? COPY.kit.balanceFeeUnknown
      : fee !== undefined && fee > 0n ? COPY.kit.balanceUnderFee.replace('{fee}', balanceText(fee, decimals, symbol)) : null;
    return <span className="ui-figure ui-balance-fill-off" {...(why ? { title: why } : {})}>{shown}</span>;
  }
  const label = fill === balance
    ? COPY.kit.useBalance.replace('{amount}', shown)
    : COPY.kit.useBalanceLessFee
      .replace('{amount}', balanceText(fill, decimals, symbol))
      .replace('{fee}', balanceText(balance - fill, decimals, symbol));
  return (
    <button type="button" className="ui-figure ui-balance-fill" aria-label={label} disabled={disabled} onClick={onFill}>
      {shown}
    </button>
  );
}

/**
 * The same-asset fee the amount on the field is keeping aside, if any: the
 * field holds the most the balance leaves after it. `null` whenever no fee in
 * this asset applies, or the amount is some other figure.
 */
function keptAside(value: string, fill: bigint | null, fee: bigint | null | undefined, decimals: number): bigint | null {
  if (fill === null || fee === undefined || fee === null || fee <= 0n) return null;
  return parseTokenAmount(value.trim(), decimals) === fill ? fee : null;
}

function amountMessage(check: AmountCheck, minimum: bigint | null, decimals: number, symbol: string, exceeds: string): string | null {
  switch (check.status) {
    case 'invalid':
      return COPY.kit.invalidDetail;
    case 'exceeds-balance':
      return exceeds;
    case 'below-minimum':
      return minimum === null ? COPY.kit.belowMinimum : COPY.kit.belowMinimumDetail.replace('{minimum}', `${formatTokenAmountExact(minimum, decimals)} ${symbol}`);
    default:
      return null;
  }
}
