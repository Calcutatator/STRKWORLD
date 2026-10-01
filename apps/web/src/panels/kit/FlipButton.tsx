import { COPY } from '../../copy.js';

/** The round "swap direction" button between a swap's two sides. */
export function FlipButton({ onFlip, disabled = false, label = COPY.kit.flip }: { readonly onFlip: () => void; readonly disabled?: boolean; readonly label?: string }) {
  return (
    <div className="ui-flip">
      <button type="button" className="ui-icon-button ui-flip-button" aria-label={label} disabled={disabled} onClick={onFlip}>
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
          <path fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" d="M7 4v14m0 0-3-3m3 3 3-3M17 20V6m0 0-3 3m3-3 3 3" />
        </svg>
      </button>
    </div>
  );
}
