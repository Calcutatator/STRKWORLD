import { COPY } from '../copy.js';
import { useStore } from '../store/use-store.js';
import { usePrivacy } from './PrivacyProvider.js';

/** The browser-session notice sits above every station/Menu window and room. */
export function SessionNoticeLayer() {
  const { submissionUncertainty } = usePrivacy();
  const state = useStore(submissionUncertainty.store);
  return (
    <SubmissionUncertaintyNotice
      active={state.active}
      acknowledged={state.acknowledged}
      onAcknowledge={() => submissionUncertainty.acknowledge()}
    />
  );
}

/** Pure render half for exact-copy and no-retry assertions. */
export function SubmissionUncertaintyNotice({
  active,
  acknowledged,
  onAcknowledge,
}: {
  active: boolean;
  acknowledged: boolean;
  onAcknowledge: () => void;
}) {
  if (!active) return null;
  return (
    <aside className="session-notice submission-uncertainty" role="alert">
      <p>
        {acknowledged ? COPY.submissionUncertainty.acknowledged : COPY.errors['submission-uncertain']}
      </p>
      {!acknowledged ? (
        <button type="button" onClick={onAcknowledge}>
          {COPY.submissionUncertainty.acknowledge}
        </button>
      ) : null}
    </aside>
  );
}
