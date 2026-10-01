import { useId, type ReactNode } from 'react';
import { COPY } from '../../copy.js';
import { formatTokenAmountExact } from '../../format.js';
import { balanceText, checkAmount, fractionOf, type AmountCheck } from './amount-math.js';

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
  /** The balance line's words; the pool balance by default. */
  readonly balanceLabel?: string;
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
}

export function AmountField({
  label, value, onChange, decimals, symbol, token, balance = null, balanceLabel = COPY.kit.poolBalance,
  exceedsMessage = COPY.kit.exceedsBalance, max, half = false, minimum = null, usd = null, hint, name = 'amount', disabled = false,
}: AmountFieldProps) {
  const id = useId();
  const messageId = `${id}-message`;
  const hintId = `${id}-hint`;
  const check = checkAmount(value, { decimals, balance, minimum });
  const message = amountMessage(check, minimum, decimals, symbol, exceedsMessage);
  const maximum = max ? max() : null;
  const halfValue = maximum === null ? null : fractionOf(maximum, 1n, 2n);
  const fill = (amount: bigint | null) => {
    if (amount !== null && amount > 0n) onChange(formatTokenAmountExact(amount, decimals));
  };
  const describedBy = [message ? messageId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className="ui-amount" data-invalid={message ? 'true' : undefined}>
      <div className="ui-amount-head">
        <label htmlFor={id}>{label}</label>
        {balance !== null ? (
          <span className="ui-amount-balance">
            {balanceLabel}: <span className="ui-figure">{balanceText(balance, decimals, symbol)}</span>
          </span>
        ) : null}
        {max ? (
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
          value={value}
          disabled={disabled}
          aria-invalid={message ? true : undefined}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
        />
        <span className="ui-amount-token">{token ?? <span className="ui-amount-symbol">{symbol}</span>}</span>
      </div>
      {usd ? <p className="ui-amount-usd">{usd}</p> : null}
      {hint ? <p className="ui-amount-hint" id={hintId}>{hint}</p> : null}
      <p className="ui-amount-message" id={messageId} aria-live="polite">{message}</p>
    </div>
  );
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
