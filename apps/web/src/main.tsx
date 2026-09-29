import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { ShellEvents, WorldEvents } from '@strkworld/shared';
import { createEventBus } from './bus/event-bus.js';
import { App } from './App.js';
import './styles.css';
import { createPresenceController, type PresenceController } from './presence/presence-controller.js';
import { lobbyEndpoint } from './presence/config.js';
import { LobbyClient } from '@strkworld/lobby/client';
import { createSandboxController } from './sandbox/sandbox-controller.js';
import { installPresenceTeardown } from './presence/lifecycle.js';
import { parseProductionWalletConfig, usesProductionWallet } from './production/config.js';
import { startProductionWalletBootstrap } from './production/bootstrap.js';
import { ProductionRoot, type ShieldPlannerFactory } from './production/ProductionRoot.js';
import { createBackendDegenCatalog } from './panels/exchange/degen-catalog.js';
import { createBackendPoolStats } from './plaza/pool-stats.js';

/**
 * STRKWORLD shell entry point.
 *
 * Two buses, created once here and never again. They are the world↔shell seam
 * (D-010): the world emits `WorldEvents` and listens for `ShellEvents`, the
 * shell does the reverse. Creating them at module scope keeps the references
 * stable across React's renders — including StrictMode's deliberate
 * double-mount, which would otherwise hand the world a fresh bus on the second
 * pass and strand every subscription made against the first.
 *
 * The world's own lifecycle (Three.js, WebGL) is ref-counted inside
 * `@strkworld/world` precisely so that double-mount is safe; nothing here needs
 * to defend against it beyond keeping these two references fixed.
 */
const worldOut = createEventBus<WorldEvents>();
const shellIn = createEventBus<ShellEvents>();
const hot = (import.meta as ImportMeta & { hot?: { dispose(callback: () => void): void } }).hot;
const environment = (import.meta as ImportMeta & {
  env: Record<string, string | boolean | undefined>;
}).env;
/**
 * D-069: opt-in remote debug logs, for a test deployment only. The logger is
 * compiled in only when VITE_DEBUG_LOGS=true, and even then does nothing
 * unless this page was opened with ?debug=1. A launch build leaves the flag
 * unset: Vite replaces the read below with `undefined`, so the dynamic import
 * is dead code and the logger's chunk is never emitted.
 */
const debugLogsBuildFlag = (import.meta as unknown as { env: { VITE_DEBUG_LOGS?: string } }).env.VITE_DEBUG_LOGS;
const debugLogsReady: Promise<unknown> | null = debugLogsBuildFlag === 'true'
  ? import('./debug/debug-logs.js')
    .then(({ startDebugLogs }) => startDebugLogs({ buildFlag: debugLogsBuildFlag, world: worldOut }))
    // A debug logger that fails to load or start must never hold up the city.
    .catch(() => null)
  : null;
let activePresence: PresenceController | null = null;
// The shared block sandbox (D-060): the lobby is its authority whenever a lobby
// client is connected, and the same rules run locally for solo play. Created
// once, like the buses, so the World always holds one stable channel.
const sandbox = createSandboxController();
const stopSandboxWorld = sandbox.listen(worldOut);
const createPresence = (): PresenceController => {
  const next = createPresenceController({
    endpoint: lobbyEndpoint(),
    factory: (options) => sandbox.adopt(new LobbyClient(options)),
    sandbox: sandbox.channel,
  });
  activePresence = next;
  return next;
};
// One teardown for everything multiplayer: Vite keeps a single `hot.dispose`
// callback per module, so the sandbox rides on the presence lifecycle rather
// than registering a second one that would silently replace it.
const presenceLifecycle = {
  destroy: async () => {
    stopSandboxWorld();
    sandbox.destroy();
    await activePresence?.destroy();
  },
};
installPresenceTeardown(presenceLifecycle, typeof window === 'undefined' ? undefined : window, hot);

const container = document.getElementById('root');
if (!container) {
  throw new Error('STRKWORLD: no #root element to mount into — check index.html.');
}
const root = createRoot(container);

function renderWalletFailure(): void {
  root.render(
    <StrictMode>
      <div className="shell-crashed" role="alert">
        The production wallet configuration is invalid.
      </div>
    </StrictMode>,
  );
}

async function loadProductionBridgeRuntime() {
  try {
    const { createProductionBridgeRuntime } = await import('./bridge/production-runtime.js');
    return createProductionBridgeRuntime({ storage: globalThis.localStorage });
  } catch {
    // Optional public-funding recovery must never replace wallet admission or
    // the city. The BridgeProvider keeps this one route unavailable instead.
    return null;
  }
}

if (usesProductionWallet(environment)) {
  root.render(
    <StrictMode>
      <div className="shell-boot" role="status">Loading the wallet connection…</div>
    </StrictMode>,
  );
  try {
    const config = parseProductionWalletConfig(environment);
    // The degen floor's list (D-067), read from the same-origin backend only
    // when the degen counter opens; while swap is off that counter is locked.
    const degenCatalog = createBackendDegenCatalog({ baseUrl: config.backendBaseUrl });
    // The Privacy Plaza's public pool stats (D-076), read from the same-origin
    // backend only while the plaza is in view or its monument window is open.
    const poolStats = createBackendPoolStats({ baseUrl: config.backendBaseUrl });
    // D-061's reserve planner arrives with the same lazy privacy import.
    // ProductionRoot uses it only while config.policy enables shield.
    let createShieldPlanner: ShieldPlannerFactory | undefined;
    // Keep the Starknet/Wallet API implementation out of the initial shell
    // graph. Production still always takes this path; the dynamic boundary only
    // lets the city render its honest loading surface before chain code arrives.
    startProductionWalletBootstrap({
      load: async () => {
        // The relay client binds fetch when the session is built, so an
        // opted-in debug logger must wrap it first (D-069).
        if (debugLogsReady) await debugLogsReady;
        const { createProductionWalletSession, ReservePublicShieldPlanner } = await import('@strkworld/privacy');
        createShieldPlanner = (options) => new ReservePublicShieldPlanner(options);
        return createProductionWalletSession(config);
      },
      render: (session) => {
        root.render(
          <StrictMode>
            <ProductionRoot
              session={session}
              worldOut={worldOut}
              shellIn={shellIn}
              createPresence={createPresence}
              bridge={{ loadRuntime: loadProductionBridgeRuntime }}
              policy={config.policy}
              createShieldPlanner={createShieldPlanner}
              degenCatalog={degenCatalog}
              poolStats={poolStats}
            />
          </StrictMode>,
        );
      },
      failure: renderWalletFailure,
      hot,
    });
  } catch {
    renderWalletFailure();
  }
} else {
  const presence = createPresence();
  root.render(
    <StrictMode>
      <App worldOut={worldOut} shellIn={shellIn} presence={presence} />
    </StrictMode>,
  );
}
