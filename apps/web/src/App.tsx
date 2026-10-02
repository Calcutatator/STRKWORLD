import type { EventBus, ShellEvents, WorldEvents } from '@strkworld/shared';
import type { PrivacyOperations, WalletSession } from '@strkworld/privacy';
import type { ConnectState } from './connect/connect-machine.js';
import { COPY } from './copy.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { PrivacyProvider } from './privacy/PrivacyProvider.js';
import { SessionNoticeLayer } from './privacy/SessionNoticeLayer.js';
import { VisitLayer } from './visits/VisitLayer.js';
import { WorldHost } from './world/WorldHost.js';
import type { PresenceController } from './presence/presence-controller.js';
import { PresenceStatusLayer } from './presence/PresenceStatusLayer.js';
import { BridgeProvider, type BridgeProviderProps } from './bridge/BridgeProvider.js';
import { ArrivalNudgeProvider } from './bridge/ArrivalNudgeProvider.js';
import { HudLayer } from './hud/HudLayer.js';
import { ArenaHud } from './arena/ArenaHud.js';
import type { DegenCatalogSource } from './panels/exchange/degen-catalog.js';
import { DegenCatalogProvider } from './panels/exchange/DegenCatalogProvider.js';
import { SeamEntryGate } from './connect/EntryGate.js';
import { PlazaProvider } from './plaza/PlazaProvider.js';
import type { PoolStatsSource } from './plaza/pool-stats.js';
import { vaultDoorOpen } from './panels/routes.js';
import { detectPlacementStand } from './production/config.js';

/**
 * The composition root, as a component.
 *
 * Everything the shell is made of, wired together and nothing more: the
 * financial seam over the top, the world underneath, and the HUD and visit
 * controls above it. Both the demo and the production entry render this tree,
 * so the HUD and the Bridge arrival nudge exist in exactly one place.
 * It takes the two buses as props rather than constructing them, so the
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
 * The production entry point injects the privacy-owned wallet session and its
 * stable `PrivacyOperations` facade. Local development may omit them only for
 * the explicit deterministic demo, which refuses to load in a production build
 * (`PrivacyProvider`, `build-context`). A mis-wired production bundle therefore
 * shows a configuration failure rather than a practice balance.
 *
 * The city opens only past D-072's entry gate. Whoever supplies the seam owns
 * that admission: the production root runs the gate before it mounts this
 * tree, and the demo seam, which this tree loads itself, is gated here.
 */
export function App({
  worldOut,
  shellIn,
  presence,
  bridge,
  operations,
  walletSession,
  initialConnectState,
  degenCatalog,
  poolStats,
}: {
  worldOut: EventBus<WorldEvents>;
  shellIn: EventBus<ShellEvents>;
  presence: PresenceController;
  /** Real composition supplies the frozen financial seam as one dependency. */
  operations?: PrivacyOperations;
  /** Production-only wallet lifecycle; demo composition leaves it absent. */
  walletSession?: WalletSession;
  /** Capability verdict already established before the production tree mounted. */
  initialConnectState?: ConnectState;
  /** Real composition supplies the service, account reader and planner together. */
  bridge?: Omit<BridgeProviderProps, 'children' | 'demo' | 'fallback' | 'build'>;
  /** The degen floor's list from the backend (D-067); the demo uses its own static list. */
  degenCatalog?: DegenCatalogSource;
  /** The Privacy Plaza's pool stats from the backend (D-076); the demo uses sample figures. */
  poolStats?: PoolStatsSource;
}) {
  // Presence owns one explicit lifecycle. Effect cleanup only removes event
  // listeners; the controller is destroyed by the composition root's owner.
  // D-077: the Vault's door follows the register and this build's own
  // fail-closed switch, which are fixed for the bundle's life.
  const city = (
    <main className="strkworld">
      <WorldHost
        out={worldOut}
        in={shellIn}
        remotePeers={presence.remotePeers}
        sandbox={presence.sandbox}
        football={presence.football}
        arena={presence.arena}
        vaultOpen={VAULT_DOOR_OPEN}
        placementStand={PLACEMENT_STAND}
      />
      <HudLayer shell={shellIn} />
      {presence.arena ? <ArenaHud arena={presence.arena} /> : null}
      <VisitLayer world={worldOut} shell={shellIn} />
      <PresenceStatusLayer presence={presence} world={worldOut} />
      <SessionNoticeLayer />
    </main>
  );
  return (
    <ErrorBoundary fallback={(message) => <BootFailure message={message} />}>
      <PrivacyProvider
        operations={operations}
        walletSession={walletSession}
        initialConnectState={initialConnectState}
        demo={!operations}
        shellBus={shellIn}
        fallback={<Boot />}
      >
        <BridgeProvider {...bridge} demo={!bridge}>
          <DegenCatalogProvider source={degenCatalog} demo={!operations}>
            <PlazaProvider world={worldOut} shell={shellIn} source={poolStats} demo={!operations}>
              <ArrivalNudgeProvider world={worldOut}>
                {operations ? city : <SeamEntryGate>{city}</SeamEntryGate>}
              </ArrivalNudgeProvider>
            </PlazaProvider>
          </DegenCatalogProvider>
        </BridgeProvider>
      </PrivacyProvider>
    </ErrorBoundary>
  );
}

/**
 * Read once, when the shell loads: the register and `import.meta.env` do not
 * change while a bundle runs, and the World builds its street once (D-077).
 */
const VAULT_DOOR_OPEN = vaultDoorOpen();

/**
 * Leaderboard phase 1: whether the placement stand stands by the plaza. Read
 * once, like the Vault's door: the World builds its street once.
 */
const PLACEMENT_STAND = detectPlacementStand();

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
