import { useId } from 'react';
import { formatTokenAmount } from '../../format.js';

/**
 * A token picker that shows each token's ticker and, where known, its
 * balance: "STRK · 12.5".
 *
 * Deliberately a styled native `<select>`: it is keyboard and screen-reader
 * complete for free, opens the platform's own picker on a phone, and is an
 * editable target, so the world's keyboard stays out of it (`dom-keyboard`).
 * A custom listbox would have to rebuild all of that to look slightly nicer.
 */
export interface TokenOption {
  readonly token: string;
  readonly symbol: string;
  readonly decimals: number;
  /** A name to show after the ticker, as the degen floor lists them. */
  readonly name?: string;
  readonly balance?: bigint | null;
  readonly disabled?: boolean;
}

export interface TokenSelectProps {
  readonly label: string;
  /** Hide the label visually (it stays the accessible name), as inside an `AmountField`. */
  readonly labelHidden?: boolean;
  readonly value: string;
  readonly options: readonly TokenOption[];
  readonly onChange: (token: string) => void;
  /** A first, empty choice ("Choose asset"); absent, a token is always chosen. */
  readonly placeholder?: string;
  readonly disabled?: boolean;
}

export function TokenSelect({ label, labelHidden = false, value, options, onChange, placeholder, disabled = false }: TokenSelectProps) {
  const id = useId();
  return (
    <span className="ui-token-select">
      <label htmlFor={id} className={labelHidden ? 'ui-visually-hidden' : undefined}>{label}</label>
      <select id={id} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
        {options.map((option) => (
          <option key={option.token} value={option.token} disabled={option.disabled}>
            {tokenOptionText(option)}
          </option>
        ))}
      </select>
    </span>
  );
}

/** An option's words: ticker, name if any, balance if known. */
export function tokenOptionText(option: TokenOption): string {
  const name = option.name ? `${option.symbol} · ${option.name}` : option.symbol;
  return option.balance === undefined || option.balance === null
    ? name
    : `${name} · ${formatTokenAmount(option.balance, option.decimals)}`;
}
