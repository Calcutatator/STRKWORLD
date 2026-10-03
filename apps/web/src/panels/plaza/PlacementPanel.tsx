import { useEffect, useRef, useState } from 'react';
import { COPY } from '../../copy.js';
import { toFailure } from '../../privacy/errors.js';
import { usePrivacy } from '../../privacy/PrivacyProvider.js';
import {
  placementRecord,
  placementView,
  readPlacementRecord,
  writePlacementRecord,
  type PlacementRecord,
  type PlacementView,
} from '../../plaza/placement.js';
import { ConsentDialog } from '../ConsentDialog.js';
import { PanelFrame } from '../PanelFrame.js';

/**
 * Leaderboard phase 1: the placement stand's window, by the plaza.
 *
 * Nothing happens until the player asks. On "Check privately" the privacy
 * package asks the wallet for the season commitment (held in its memory
 * only), counts this player's receipts on-chain, refreshes their anonymous
 * entry at the blind tally and reads the season's histogram; this window then
 * works out the placement on the device. It is shown here and nowhere else:
 * never on the avatar, the HUD, presence or the lobby. The device keeps the
 * placement, the count, when, and the season, and nothing more.
 *
 * **The consent pop-up** (D-122, amended 2026-10-02 at the lead's request).
 * One check is one step in `packages/privacy`: it asks the wallet for the
 * season commitment `p` and sends it to the backend — to the pinned shadow
 * read, which needs it to find this player's receipt accounts, and then to
 * the tally. There is no part of a check that reads the player's own count
 * without the backend, so the question is asked before the whole step, and
 * `p` cannot leave the device until the player has answered Continue. It is
 * asked again before every check: consent is never remembered, here or on
 * the device.
 *
 * **One wallet prompt at most** (D-122, amended 2026-10-03). After Continue
 * the privacy package asks the wallet for the season commitment only if this
 * connection has not already shared it; it caches every commitment in memory
 * for the life of the connection, and a check sends only the feature partials
 * that connection already holds, so it never prompts to collect them. When a
 * prompt is coming the waiting state says so, and a second check in the same
 * session says nothing because nothing is asked.
 */

export type PlacementPhase =
  | { readonly name: 'ready' }
  /** `prompting`: the wallet is about to ask for the season commitment. */
  | { readonly name: 'checking'; readonly prompting?: boolean }
  | { readonly name: 'result'; readonly view: PlacementView }
  | { readonly name: 'refused' }
  | { readonly name: 'failed' };

export function PlacementPanel({ onClose, now = Date.now }: { onClose: () => void; now?: () => number }) {
  const { operations, account } = usePrivacy();
  const [phase, setPhase] = useState<PlacementPhase>({ name: 'ready' });
  const [previous, setPrevious] = useState<PlacementRecord | null>(() => readPlacementRecord());
  /** True only while the disclosure is on screen, unanswered. Never persisted. */
  const [asking, setAsking] = useState(false);
  const running = useRef<AbortController | null>(null);

  useEffect(() => () => running.current?.abort(), []);

  const check = async (): Promise<void> => {
    if (running.current) return;
    const controller = new AbortController();
    running.current = controller;
    // D-122 (amended 2026-10-03): a check makes at most one wallet prompt, and
    // none when the season commitment is already in this connection's memory.
    // Asked before the check starts, so the waiting state can warn in time.
    setPhase({ name: 'checking', prompting: account !== null && (operations.placementWillPrompt?.() ?? true) });
    try {
      const result = await operations.checkPlacement(controller.signal);
      if (controller.signal.aborted) return;
      const last = readPlacementRecord();
      const view = placementView(result, last);
      writePlacementRecord(placementRecord(view, now()));
      setPrevious(last);
      setPhase({ name: 'result', view });
    } catch (error) {
      if (controller.signal.aborted) return;
      setPhase(toFailure(error).kind === 'user-rejected' ? { name: 'refused' } : { name: 'failed' });
    } finally {
      if (running.current === controller) running.current = null;
    }
  };

  return (
    <PlacementPanelView
      phase={phase}
      previous={previous}
      demo={account === null}
      asking={asking}
      onCheck={() => setAsking(true)}
      onConsent={() => {
        setAsking(false);
        void check();
      }}
      onDecline={() => setAsking(false)}
      onClose={onClose}
    />
  );
}

/** Pure render half, so every state is a static-render test. */
export function PlacementPanelView({
  phase,
  previous,
  demo,
  asking = false,
  onCheck,
  onConsent,
  onDecline,
  onClose,
}: {
  phase: PlacementPhase;
  previous: PlacementRecord | null;
  demo: boolean;
  /** The disclosure is on screen, waiting for an answer. */
  asking?: boolean;
  onCheck: () => void;
  /** Continue: the one path on which a check may start. */
  onConsent?: () => void;
  /** Cancel, Escape or a press outside: nothing is sent. */
  onDecline?: () => void;
  onClose: () => void;
}) {
  const copy = COPY.plaza.placement;
  const busy = phase.name === 'checking';
  return (
    <>
      <PanelFrame title={copy.title} building="plaza" disclosure={null} onClose={onClose}>
        <div className="placement" data-phase={phase.name}>
          <p className="placement-season">{copy.season}</p>
          {phase.name === 'result' ? (
            <PlacementResult view={phase.view} />
          ) : (
            <>
              <p className="panel-intro">{copy.intro}</p>
              {previous && previous.placement ? (
                <p className="placement-last">
                  {copy.lastCheck(previous.placement.topPercent, previous.count)}
                </p>
              ) : null}
            </>
          )}
          {phase.name === 'checking' && phase.prompting ? (
            <p className="panel-notice placement-wallet-prompt" role="status">{copy.walletPrompt}</p>
          ) : null}
          {phase.name === 'refused' ? <p className="panel-notice" role="status">{copy.refused}</p> : null}
          {phase.name === 'failed' ? <p className="panel-notice placement-failed" role="status">{copy.failed}</p> : null}
          {demo ? <p className="panel-notice placement-demo" role="note">{copy.demo}</p> : null}
          <p className="placement-trust">{copy.trust}</p>
          <button
            type="button"
            className="placement-check"
            onClick={onCheck}
            disabled={busy}
            aria-busy={busy ? true : undefined}
          >
            {busy ? copy.checking : phase.name === 'result' ? copy.again : copy.check}
          </button>
          {phase.name === 'result' ? <p className="placement-saved">{copy.saved}</p> : null}
        </div>
      </PanelFrame>
      {/* Over the window, never inside its scrolling card: the disclosure is
          laid out against the panel layer, as the Bridge's nested window is. */}
      {asking ? (
        <ConsentDialog
          title={copy.consent.title}
          body={copy.consent.body}
          confirmLabel={copy.consent.confirm}
          cancelLabel={copy.consent.cancel}
          onConfirm={() => onConsent?.()}
          onCancel={() => onDecline?.()}
        />
      ) : null}
    </>
  );
}

function PlacementResult({ view }: { view: PlacementView }) {
  const copy = COPY.plaza.placement;
  const { placement, progress } = view;
  return (
    <div className="placement-result" aria-live="polite">
      {placement ? (
        <>
          <p className="placement-top" data-stat="top">{copy.top(placement.topPercent)}</p>
          <p className="placement-rank" data-stat="rank">{copy.rank(placement.rank, placement.total)}</p>
        </>
      ) : (
        <p className="placement-unranked">{view.count === 0 ? copy.none : copy.unranked}</p>
      )}
      <p className="placement-count" data-stat="count">{copy.count(view.count)}</p>
      {progress && (progress.newActions > 0 || progress.placesUp !== 0) ? (
        <p className="placement-progress" data-stat="progress">{copy.progress(progress.newActions, progress.placesUp)}</p>
      ) : null}
      {view.defiOnly > 0 && placement ? <p className="placement-note">{copy.defi(view.ranked, view.defiOnly)}</p> : null}
      {!view.ranking ? <p className="placement-note">{copy.rankingDown}</p> : null}
    </div>
  );
}
