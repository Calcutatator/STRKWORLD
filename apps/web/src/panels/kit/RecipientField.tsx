import { useId, useState, type ReactNode } from 'react';
import { COPY } from '../../copy.js';

/**
 * A send's recipient, wallet style: a "To" field, a Paste button, and an
 * inline message when the address cannot be one.
 *
 * The format is checked when the player leaves the field or pastes, never on
 * every keystroke, so a half-typed address is not called wrong. Whether the
 * address can receive (D-074: a private transfer's recipient must be
 * registered) is the panel's check at Add, not this field's: that is a chain
 * read, and its words belong to the panel.
 *
 * Paste reads the clipboard only when pressed, and only where the browser
 * offers `navigator.clipboard.readText`; elsewhere there is no button. A
 * refused or empty clipboard changes nothing.
 */
export interface RecipientFieldProps {
  readonly label: ReactNode;
  readonly value: string;
  readonly onChange: (text: string) => void;
  /** The message for a value that cannot be an address, or null when it could be. */
  readonly validate: (text: string) => string | null;
  readonly placeholder?: string;
  readonly name?: string;
  readonly disabled?: boolean;
  /** Injectable for tests; the browser's clipboard by default. */
  readonly readClipboard?: (() => Promise<string>) | null;
}

export function RecipientField({
  label, value, onChange, validate, placeholder = COPY.kit.addressPlaceholder, name = 'recipient', disabled = false,
  readClipboard = browserClipboard(),
}: RecipientFieldProps) {
  const id = useId();
  const messageId = `${id}-message`;
  // The text the format was last checked against: on blur or paste. An edit
  // after that clears the message until the next check.
  const [checked, setChecked] = useState<string | null>(null);
  const message = checked !== null && checked === value && value.trim() !== '' ? validate(value) : null;
  const paste = async () => {
    if (!readClipboard) return;
    let text: string;
    try {
      text = (await readClipboard()).trim();
    } catch {
      return;
    }
    if (text === '') return;
    onChange(text);
    setChecked(text);
  };
  return (
    <div className="ui-recipient" data-invalid={message ? 'true' : undefined}>
      <label htmlFor={id}>{label}</label>
      <div className="ui-recipient-box">
        <input
          id={id}
          name={name}
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          value={value}
          disabled={disabled}
          aria-invalid={message ? true : undefined}
          aria-describedby={messageId}
          onChange={(event) => onChange(event.target.value)}
          onBlur={(event) => {
            const trimmed = event.target.value.trim();
            if (trimmed !== event.target.value) onChange(trimmed);
            setChecked(trimmed);
          }}
        />
        {readClipboard ? (
          <button type="button" className="ui-chip" aria-label={COPY.kit.pasteLabel} disabled={disabled} onClick={() => void paste()}>
            {COPY.kit.paste}
          </button>
        ) : null}
      </div>
      <p className="ui-amount-message" id={messageId} aria-live="polite">{message}</p>
    </div>
  );
}

function browserClipboard(): (() => Promise<string>) | null {
  const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
  return clipboard && typeof clipboard.readText === 'function' ? () => clipboard.readText() : null;
}
