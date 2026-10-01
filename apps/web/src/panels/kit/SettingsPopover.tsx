import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { COPY } from '../../copy.js';

/**
 * A cog that opens a small popover of presets plus a custom value, with a
 * slot for warnings. Generic: slippage is the first use, but the presets,
 * their words and the custom input's meaning are the caller's.
 *
 * Advanced on purpose: the panel shows the current value in its review rows,
 * and only a player who wants to change it opens this.
 *
 * Escape and a press outside close it and hand focus back to the cog.
 * Escape stops here, so the visit layer's window listener does not also
 * read it as "close the counter" (as `GettingStarted` does).
 */
export interface SettingsPreset {
  readonly value: string;
  readonly label: string;
}

export interface SettingsPopoverProps {
  /** The popover's heading and the cog's accessible name, e.g. "Slippage". */
  readonly title: string;
  readonly presets: readonly SettingsPreset[];
  /** The chosen value: one preset's, or the custom text. */
  readonly value: string;
  readonly onChange: (value: string) => void;
  /** The custom input's label and unit; absent, there is no custom input. */
  readonly custom?: { readonly label?: string; readonly unit?: string; readonly inputMode?: 'decimal' | 'numeric' };
  /** One plain line under the title: what the setting does. */
  readonly hint?: ReactNode;
  /** Shown under the choices, e.g. "High slippage: you may get a poor price." */
  readonly warning?: ReactNode;
  /** Start open (tests, stories). */
  readonly defaultOpen?: boolean;
}

export function SettingsPopover({ title, presets, value, onChange, custom, hint, warning, defaultOpen = false }: SettingsPopoverProps) {
  const [open, setOpen] = useState(defaultOpen);
  const root = useRef<HTMLDivElement>(null);
  const cog = useRef<HTMLButtonElement>(null);
  const id = useId();
  const headingId = `${id}-title`;
  const customId = `${id}-custom`;
  const isPreset = presets.some((preset) => preset.value === value);
  // What the player typed in the custom box, kept while it is the value, so
  // typing "1.5" does not clear itself when "1" matches a preset on the way.
  const [customText, setCustomText] = useState(isPreset ? '' : value);
  const customShown = value === customText ? customText : isPreset ? '' : value;

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) cog.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent | MouseEvent) => {
      if (root.current && event.target instanceof Node && !root.current.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('mousedown', onPointer);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('mousedown', onPointer);
    };
  }, [open]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Escape' || !open) return;
    event.preventDefault();
    event.stopPropagation();
    close(true);
  };

  return (
    <div className="ui-settings" ref={root} onKeyDown={onKeyDown}>
      <button
        type="button"
        ref={cog}
        className="ui-icon-button ui-settings-cog"
        aria-label={`${COPY.kit.settings}: ${title}`}
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <CogIcon />
      </button>
      {open ? (
        <div className="ui-settings-popover" id={id} role="group" aria-labelledby={headingId}>
          <p className="ui-settings-title" id={headingId}>{title}</p>
          {hint ? <p className="ui-settings-hint">{hint}</p> : null}
          <div className="ui-settings-presets">
            {presets.map((preset) => (
              <button
                key={preset.value}
                type="button"
                className="ui-chip"
                aria-pressed={preset.value === value && customShown === ''}
                onClick={() => { setCustomText(''); onChange(preset.value); }}
              >
                {preset.label}
              </button>
            ))}
            {custom ? (
              <span className="ui-settings-custom">
                <label htmlFor={customId} className="ui-visually-hidden">{custom.label ?? COPY.kit.custom}</label>
                <input
                  id={customId}
                  inputMode={custom.inputMode ?? 'decimal'}
                  autoComplete="off"
                  placeholder={custom.label ?? COPY.kit.custom}
                  value={customShown}
                  onChange={(event) => { setCustomText(event.target.value); onChange(event.target.value); }}
                />
                {custom.unit ? <span aria-hidden="true">{custom.unit}</span> : null}
              </span>
            ) : null}
          </div>
          {warning ? <div className="ui-settings-warning" role="status">{warning}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

function CogIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M19.4 13a7.6 7.6 0 0 0 0-2l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-1.7-1L15 3.5h-4L10.7 6a7.4 7.4 0 0 0-1.7 1l-2.4-1-2 3.4L4.6 11a7.6 7.6 0 0 0 0 2l-2 1.6 2 3.4 2.4-1a7.4 7.4 0 0 0 1.7 1l.3 2.5h4l.3-2.5a7.4 7.4 0 0 0 1.7-1l2.4 1 2-3.4zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"
      />
    </svg>
  );
}
