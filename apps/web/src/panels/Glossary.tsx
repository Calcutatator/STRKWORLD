import type { ReactNode } from 'react';

/**
 * An inline "what's this?" disclosure for one piece of review jargon.
 *
 * Plain `<details>`/`<summary>` — the same primitive the Bridge already uses
 * for its own progressive disclosure (`BridgePanel.tsx`'s "Quote details",
 * "Recover a saved deposit"). Native, so it needs no ARIA wiring of its own:
 * the summary is keyboard-reachable (Tab, then Enter/Space to toggle) and
 * exposed to a screen reader as an expandable disclosure, never hover-only.
 *
 * `term` is rendered as the visible, clickable summary — usually the same
 * label already shown beside a figure (`COPY.bank.poolFee`), so the control
 * does not add a second, separate label to read. `definition` is plain-English
 * copy from the `glossary` section of `copy.ts`, shown only once expanded.
 */
export function GlossaryTerm({ term, definition }: { term: ReactNode; definition: ReactNode }) {
  return (
    <details className="glossary-term">
      <summary>{term}</summary>
      <p className="glossary-definition">{definition}</p>
    </details>
  );
}
