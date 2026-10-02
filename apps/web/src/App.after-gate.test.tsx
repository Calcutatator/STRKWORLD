// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakePrivacyOperations, type WalletSession } from '@strkworld/privacy';
import type { ShellEvents, WorldEvents } from '@strkworld/shared';
import type { BridgeRuntime } from './bridge/BridgeProvider.js';
import { createEventBus } from './bus/event-bus.js';
import { COPY } from './copy.js';
import { createPresenceController } from './presence/presence-controller.js';

/**
 * After the entry gate (D-072), in both compositions: the city mounts late, so
 * everything in it must still learn the current wallet status, and a Bank
 * counter must open. Only the renderer and the demo Bridge runtime are stood
 * in; the HUD, the visit layer, the providers and the gate are the real ones.
 * The test plays the World by emitting its semantic events.
 */

// The provider imports the demo Bridge runtime at boot, and where it landed
// used to depend on the machine's load: under the full suite it could land
// in the Bank and publish the Bank's stations a second time. This stand-in
// carries the account and planner VisitLayer reads, loads no chunk, and
// lands only once the provider has asked for it and the test says so.
const demoBridge = vi.hoisted(() => {
  let markRequested = (): void => undefined;
  let land = (): void => undefined;
  const requested = new Promise<void>((resolve) => {
    markRequested = () => resolve();
  });
  const landing = new Promise<void>((resolve) => {
    land = () => resolve();
  });
  return { requested, landing, markRequested: () => markRequested(), land: () => land() };
});

vi.mock('./privacy/demo-loader.js', async () => {
  const { createDemoOperations } = await import('./privacy/demo-operations.js');
  return { loadDemoOperations: async () => createDemoOperations({ funded: true }) };
});
vi.mock('./bridge/demo-runtime.js', () => ({
  createDemoBridgeRuntime: async (): Promise<BridgeRuntime> => {
    demoBridge.markRequested();
    await demoBridge.landing;
    return Object.freeze({
      service: {} as never,
      loadSources: async () => [],
      readAccount: () => '0x123',
      planner: { planMax: async () => { throw new Error('not planned in this test'); } },
      account: '0x123',
      available: () => true,
      load: () => undefined,
    });
  },
}));
vi.mock('./world/WorldHost.js', () => ({
  WorldHost: () => <div data-testid="world-host">world</div>,
}));

import { App } from './App.js';
import { ProductionRoot } from './production/ProductionRoot.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  sessionStorage.clear();
});

afterEach(() => {
  const owner = root;
  root = null;
  if (owner) act(() => owner.unmount());
  container?.remove();
  container = null;
});

async function settle(): Promise<void> {
  for (let turn = 0; turn < 6; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function button(label: string): HTMLButtonElement {
  const found = [...container!.querySelectorAll('button')].find((candidate) => candidate.textContent === label);
  if (!found) throw new Error(`No button labelled ${label}`);
  return found;
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.click();
  });
  await settle();
}

function hudWallet(): string | null | undefined {
  return container!.querySelector('.journey-hud-wallet')?.textContent;
}

function mount(element: React.ReactElement): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(element));
}

/** Walk into the Bank and up to its shield counter, as the World reports it. */
async function openBankCounter(worldOut: ReturnType<typeof createEventBus<WorldEvents>>): Promise<void> {
  await act(async () => {
    worldOut.emit('building:entered', { building: 'bank' });
  });
  await act(async () => {
    worldOut.emit('station:activated', { building: 'bank', station: 'bank:shielding' });
  });
  await settle();
}

/** Let the held demo Bridge runtime land, once the provider has asked for it. */
async function landDemoBridge(): Promise<void> {
  await act(async () => {
    await demoBridge.requested;
    demoBridge.land();
  });
  await settle();
}

function bankStations(snapshots: ShellEvents['world:stations'][]): string[] {
  return snapshots
    .filter((snapshot) => snapshot.building === 'bank')
    .flatMap((snapshot) => snapshot.stations.map(({ station, status }) => `${station}:${status}`));
}

function bankPanel(): Element | null {
  // D-103: the SHIELD counter's own window, naming its one action.
  return container!.querySelector('section.panel[data-building="bank"] .counter-action');
}

describe('the city behind the entry gate (D-072)', () => {
  it('demo: the HUD shows the real status, and a Bank counter opens once the demo wallet connects', async () => {
    const worldOut = createEventBus<WorldEvents>();
    const shellIn = createEventBus<ShellEvents>();
    const stations: ShellEvents['world:stations'][] = [];
    shellIn.on('world:stations', (payload) => stations.push(payload));
    mount(<App worldOut={worldOut} shellIn={shellIn} presence={createPresenceController({})} />);
    await settle();
    await click(button(COPY.entry.action));

    expect(container!.querySelector('[data-testid="world-host"]')).not.toBeNull();
    // The status was published before the HUD existed; it must not stay "Checking wallet…".
    expect(hudWallet()).toBe(COPY.hud.wallet.disconnected);
    expect(hudWallet()).not.toBe(COPY.hud.wallet.unknown);

    await openBankCounter(worldOut);
    // The Bridge runtime lands with the player at the Bank counter. Only the
    // Bridge's stations read it, so the Bank's door snapshot stays the only one.
    await landDemoBridge();
    expect(bankStations(stations)).toEqual(['bank:shielding:available', 'bank:unshielding:available', 'bank:staking:available', 'bank:unstaking:available']);
    // The counter opens; in the demo the wallet still has to connect, as before D-072.
    expect(container!.textContent).toContain(COPY.connect.title);
    await click(button(COPY.connect.action));

    expect(bankPanel()).not.toBeNull();
    expect(hudWallet()).toBe(COPY.hud.wallet.connected);
  });

  it('production: the HUD reads "Wallet connected" and the Bank counter opens straight to the Bank', async () => {
    const worldOut = createEventBus<WorldEvents>();
    const shellIn = createEventBus<ShellEvents>();
    const stations: ShellEvents['world:stations'][] = [];
    shellIn.on('world:stations', (payload) => stations.push(payload));
    const operations = new FakePrivacyOperations({
      balances: { [STRK]: 1n },
      capability: { supportsStrk20: true, walletApiVersion: '0.10.3', registration: 'unknown' },
    });
    mount(
      <ProductionRoot
        session={connectedSession('0xabc', operations)}
        worldOut={worldOut}
        shellIn={shellIn}
        createPresence={() => createPresenceController({})}
        bridge={{ loadRuntime: async () => ({ service: {} as never, loadSources: async () => [] }) }}
        policy={null}
      />,
    );
    await settle();
    await click(button(COPY.entry.action));

    expect(container!.querySelector('[data-testid="world-host"]')).not.toBeNull();
    expect(hudWallet()).toBe(COPY.hud.wallet.connected);

    await openBankCounter(worldOut);
    expect(bankStations(stations)).toEqual(['bank:shielding:available', 'bank:unshielding:available', 'bank:staking:available', 'bank:unstaking:available']);
    expect(bankPanel()).not.toBeNull();
  });
});

function connectedSession(account: string, operations: FakePrivacyOperations): WalletSession {
  const snapshot = {
    phase: 'connected' as const,
    wallets: [{ key: 'wallet-1', name: 'Ready', icon: 'data:image/svg+xml,ready' }],
    selectedKey: 'wallet-1',
    account,
    generation: 1,
  };
  return {
    operations,
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    connect: async () => snapshot,
    refreshDiscovery: () => undefined,
    readAccount: () => account,
    disconnect: async () => undefined,
    destroy: () => undefined,
  };
}
