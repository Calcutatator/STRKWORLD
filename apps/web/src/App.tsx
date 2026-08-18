import type { EventBus, ShellEvents, WorldEvents } from '@strkworld/shared';
import { COPY } from './copy.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { PrivacyProvider } from './privacy/PrivacyProvider.js';
import { SessionNoticeLayer } from './privacy/SessionNoticeLayer.js';
import { VisitLayer } from './visits/VisitLayer.js';
import { WorldHost } from './world/WorldHost.js';
import type { PresenceController } from './presence/presence-controller.js';
import { PresenceStatusLayer } from './presence/PresenceStatusLayer.js';
import { BridgeProvider, type BridgeProviderProps } from './bridge/BridgeProvider.js';

/**
 * The composition root, as a component.
 *
 * Everything the shell is made of, wired together and nothing more: the
 * financial seam over the top, the world underneath, and the visit controls
 * above it. It takes the two buses as props rather than constructing them, so the
 * same tree can be mounted by `main.tsx` against the real page and by a test
 * against buses it controls — the buses are the seam between world and shell,
 * and a composition root that manufactures its own seam cannot be driven from
 * outside.
 *
 * The world receives the world-out bus to emit on and the shell-in bus to
 * listen on; the shell listens on world-out and pushes on shell-in. One
 * direction each, which is the whole point of two buses rather than one
 * (D-010).
 *
 * `demo` is deliberate: v1 has no live wallet adapter wired yet, so the shell
 * runs against the deterministic fake. That path refuses to load in a
 * production build (`PrivacyProvider`, `build-context`), so a served production
 * bundle shows the "not wired yet" surface rather than a practice balance —
 * the bundle still builds, it just declines to invent money.
 */
export function App({
  worldOut,
  shellIn,
  presence,
  bridge,
}: {
  worldOut: EventBus<WorldEvents>;
  shellIn: EventBus<ShellEvents>;
  presence: PresenceController;
  /** Real composition supplies the service, account reader and planner together. */
  bridge?: Omit<BridgeProviderProps, 'children' | 'demo' | 'fallback' | 'build'>;
}) {
  // Presence owns one explicit lifecycle. Effect cleanup only removes event
  // listeners; the controller is destroyed by the composition root's owner.
  return (
    <ErrorBoundary fallback={(message) => <BootFailure message={message} />}>
      <PrivacyProvider demo shellBus={shellIn} fallback={<Boot />}>
        <BridgeProvider {...bridge} demo={!bridge}>
          <main className="strkworld">
            <WorldHost out={worldOut} in={shellIn} remotePeers={presence.remotePeers} />
            <VisitLayer world={worldOut} shell={shellIn} />
            <PresenceStatusLayer presence={presence} world={worldOut} />
            <SessionNoticeLayer />
          </main>
        </BridgeProvider>
      </PrivacyProvider>
    </ErrorBoundary>
  );
}

function Boot() {
  return (
    <div className="shell-boot" role="status">
      {COPY.boot}
    </div>
  );
}

/**
 * Shown when the tree throws — most usefully, when a production build reaches
 * the refused practice seam. The message carried by the throw is preferred, so
 * the deliberate production refusal reads as an intent, with a generic line
 * behind it for anything unexpected.
 */
function BootFailure({ message }: { message: string }) {
  return (
    <div className="shell-crashed" role="alert">
      <p>{message || COPY.crashed}</p>
    </div>
  );
}
