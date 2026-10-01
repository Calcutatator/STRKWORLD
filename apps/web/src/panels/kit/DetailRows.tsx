import { useState, type ReactNode } from 'react';
import { COPY } from '../../copy.js';

/**
 * Label and value rows for a review or a live preview: rate, minimum
 * received, price impact, fees, route, health before → after, APY. Keep them
 * few; a row only earns its place if the player would act on it.
 *
 * `tone` colours the value: `emphasis` for the figure being agreed to,
 * `warning` and `danger` for one the player should look at twice. The tone is
 * also written out as `data-tone`, never carried by colour alone: pair a
 * warning tone with words in the value or a `note`.
 */
export type DetailTone = 'default' | 'emphasis' | 'warning' | 'danger';

export interface DetailRow {
  readonly id: string;
  readonly label: ReactNode;
  readonly value: ReactNode;
  readonly tone?: DetailTone;
  /** A short line under the value, e.g. why a figure is high. */
  readonly note?: ReactNode;
}

export function DetailRows({ rows, label }: { readonly rows: readonly DetailRow[]; readonly label?: string }) {
  if (rows.length === 0) return null;
  return (
    <dl className="ui-details" aria-label={label}>
      {rows.map((row) => (
        <div className="ui-detail" key={row.id} data-tone={row.tone && row.tone !== 'default' ? row.tone : undefined}>
          <dt>{row.label}</dt>
          <dd>
            {row.value}
            {row.note ? <span className="ui-detail-note">{row.note}</span> : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A rate that the player can flip between "1 A ≈ x B" and "1 B ≈ y A". The
 * caller formats both, since only it knows the decimals and precision.
 */
export function InvertibleRate({ forward, inverse }: { readonly forward: string; readonly inverse: string }) {
  const [inverted, setInverted] = useState(false);
  return (
    <span className="ui-rate">
      <span className="ui-figure">{inverted ? inverse : forward}</span>
      <button type="button" className="ui-icon-button ui-rate-invert" aria-label={COPY.kit.invert} aria-pressed={inverted} onClick={() => setInverted((current) => !current)}>
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" focusable="false">
          <path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M7 4v14m0 0-3-3m3 3 3-3M17 20V6m0 0-3 3m3-3 3 3" />
        </svg>
      </button>
    </span>
  );
}

/** "before → after", for health factor and the like. */
export function BeforeAfter({ before, after }: { readonly before: ReactNode; readonly after: ReactNode }) {
  return (
    <span className="ui-before-after">
      <span className="ui-figure">{before}</span>
      <span aria-hidden="true"> → </span>
      <span className="ui-visually-hidden"> to </span>
      <span className="ui-figure">{after}</span>
    </span>
  );
}
