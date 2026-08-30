import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { ShellEvents, WorldEvents } from '@strkworld/shared';
import { createEventBus } from './bus/event-bus.js';
import { App } from './App.js';
import './styles.css';
import { createPresenceController, type PresenceController } from './presence/presence-controller.js';
import { lobbyEndpoint } from './presence/config.js';
import { installPresenceTeardown } from './presence/lifecycle.js';
import { parseProductionWalletConfig, usesProductionWallet } from './production/config.js';
import { startProductionWalletBootstrap } from './production/bootstrap.js';
import { ProductionRoot } from './production/ProductionRoot.js';

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
 * The world's own lifecycle (Phaser, WebGL) is ref-counted inside
 * `@strkworld/world` precisely so that double-mount is safe; nothing here needs
 * to defend against it beyond keeping these two references fixed.
 */
const worldOut = createEventBus<WorldEvents>();
const shellIn = createEventBus<ShellEvents>();
const hot = (import.meta as ImportMeta & { hot?: { dispose(callback: () => void): void } }).hot;
const environment = (import.meta as ImportMeta & {
  env: Record<string, string | boolean | undefined>;
}).env;
let activePresence: PresenceController | null = null;
const createPresence = (): PresenceController => {
  const next = createPresenceController({ endpoint: lobbyEndpoint() });
  activePresence = next;
  return next;
};
const presenceLifecycle = {
  destroy: async () => {
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
    // Keep the Starknet/Wallet API implementation out of the initial shell
    // graph. Production still always takes this path; the dynamic boundary only
    // lets the city render its honest loading surface before chain code arrives.
    startProductionWalletBootstrap({
      load: async () => {
        const { createProductionWalletSession } = await import('@strkworld/privacy');
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
