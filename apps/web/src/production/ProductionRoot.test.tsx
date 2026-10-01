// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakePrivacyOperations,
  ReservePublicShieldPlanner,
  type PublicShieldPlanner,
  type WalletRoutePolicy,
  type WalletSession,
} from '@strkworld/privacy';
import { createEventBus } from '../bus/event-bus.js';
import { parseRoutePolicy } from './config.js';
import type { ShellEvents, WorldEvents } from '@strkworld/shared';
import { createPresenceController, type PresenceController } from '../presence/presence-controller.js';
import { COPY } from '../copy.js';

const captured = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock('../App.js', () => ({
  App: (props: Record<string, unknown>) => {
    captured.current = props;
    return <div>production app</div>;
  },
}));

import {
  capabilityAdmits,
  ProductionRoot,
  shieldPlanningEnabled,
  type ShieldPlannerFactory,
} from './ProductionRoot.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const STRK_TOKEN = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';

// D-072's once-per-session pass lives in this tab's session storage; every
// test starts with a tab that has let nobody in.
beforeEach(() => {
  sessionStorage.clear();
});

/** An admitted wallet whose account already holds something in the pool. */
function fundedOperations(registration: 'unknown' | 'registered' = 'unknown'): FakePrivacyOperations {
  return new FakePrivacyOperations({
    balances: { [STRK_TOKEN]: 1n },
    capability: { supportsStrk20: true, walletApiVersion: '0.10.3', registration },
  });
}

/** Let the gate finish recalling this tab's pass: its key is an async SHA-256. */
async function settleGate(container: HTMLElement): Promise<void> {
  for (let turn = 0; turn < 50 && container.querySelector('[data-gate="recalling"]'); turn += 1) {
    await act(async () => {
      await flushReact();
    });
  }
  expect(container.querySelector('[data-gate="recalling"]')).toBeNull();
}

/**
 * Press the entry gate's one button, as the player does. With `remembered`,
 * this tab already let the account in, so there must be no gate at all.
 */
async function enterCity(container: HTMLElement, { remembered = false } = {}): Promise<void> {
  await settleGate(container);
  const gate = container.querySelector('[data-testid="entry-gate"]');
  if (remembered) {
    expect(gate, 'a remembered pass skips the gate').toBeNull();
    return;
  }
  expect(gate, 'the entry gate should be showing').not.toBeNull();
  const button = gate!.querySelector('button');
  expect(button?.textContent).toBe(COPY.entry.action);
  await act(async () => {
    button!.click();
    await flushReact();
  });
}

describe('ProductionRoot', () => {
  it('keeps the connected tree behind capability admission', () => {
    captured.current = null;
    renderToStaticMarkup(
      <ProductionRoot
        session={sessionAt('connected', '0xabc')}
        worldOut={createEventBus<WorldEvents>()}
        shellIn={createEventBus<ShellEvents>()}
        presence={createPresenceController({})}
        bridge={recoveryBridge()}
      />,
    );

    expect(captured.current).toBeNull();
    expect(capabilityAdmits({ name: 'unsupported-wallet', walletApiVersion: '0.9.0' })).toBe(false);
    expect(capabilityAdmits({ name: 'unreachable' })).toBe(false);
    expect(capabilityAdmits({ name: 'not-registered' })).toBe(true);
    expect(capabilityAdmits({ name: 'connected' } as never)).toBe(false);
    expect(capabilityAdmits({
      name: 'connected',
      capability: { supportsStrk20: 'yes', walletApiVersion: {}, registration: 'registered' },
      registrationConfirmed: true,
    } as never)).toBe(false);
    const inherited = Object.create({
      name: 'connected',
      capability: { supportsStrk20: true, walletApiVersion: '0.10.3', registration: 'registered' },
      registrationConfirmed: true,
    });
    expect(capabilityAdmits(inherited as never)).toBe(false);
  });

  it('keeps the production app and its World out of the tree before wallet connection', () => {
    captured.current = null;
    const createPresence = vi.fn(() => createPresenceController({}));
    const session = sessionAt('selection-required', null);
    const markup = renderToStaticMarkup(
      <ProductionRoot
        session={session}
        worldOut={createEventBus<WorldEvents>()}
        shellIn={createEventBus<ShellEvents>()}
        createPresence={createPresence}
        bridge={recoveryBridge()}
      />,
    );

    expect(markup).toContain('data-testid="wallet-entry-gate"');
    expect(markup).toContain('Ready');
    expect(markup).toContain('Look again');
    expect(markup).not.toContain('production app');
    expect(captured.current).toBeNull();
    expect(createPresence).not.toHaveBeenCalled();
  });

  it('returns to the wallet gate when the session reports a wrong network', () => {
    captured.current = null;
    const markup = renderToStaticMarkup(
      <ProductionRoot
        session={sessionAt('wrong-network', null)}
        worldOut={createEventBus<WorldEvents>()}
        shellIn={createEventBus<ShellEvents>()}
        presence={createPresenceController({})}
        bridge={recoveryBridge()}
      />,
    );

    expect(markup).toContain('Switch this wallet to Starknet mainnet');
    expect(markup).not.toContain('production app');
    expect(captured.current).toBeNull();
  });

  it('shows the avatar attention cue only while the selected wallet connection is pending', () => {
    const connecting = renderToStaticMarkup(
      <ProductionRoot
        session={sessionAt('connecting', null)}
        worldOut={createEventBus<WorldEvents>()}
        shellIn={createEventBus<ShellEvents>()}
        presence={createPresenceController({})}
        bridge={recoveryBridge()}
      />,
    );
    const choosing = renderToStaticMarkup(
      <ProductionRoot
        session={sessionAt('selection-required', null)}
        worldOut={createEventBus<WorldEvents>()}
        shellIn={createEventBus<ShellEvents>()}
        presence={createPresenceController({})}
        bridge={recoveryBridge()}
      />,
    );

    expect(connecting).toContain('data-wallet-attention="connect"');
    expect(connecting).toMatch(/<img[^>]+avatar-walker\/walk\.png/);
    expect(choosing).not.toContain('data-wallet-attention');
  });

  it('does not mount or create presence for an unsupported connected wallet', async () => {
    captured.current = null;
    const createPresence = vi.fn(() => createPresenceController({}));
    const session = sessionAt('connected', '0xabc', new FakePrivacyOperations({
      capability: { supportsStrk20: false, walletApiVersion: '0.9.0' },
    }));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <StrictMode>
          <ProductionRoot
            session={session}
            worldOut={createEventBus<WorldEvents>()}
            shellIn={createEventBus<ShellEvents>()}
            createPresence={createPresence}
            bridge={recoveryBridge()}
          />
        </StrictMode>,
      );
      await flushReact();
    });

    // D-073: the room names the connected wallet by the picker's display name.
    const room = container.querySelector('[data-testid="wallet-capability-gate"]');
    expect(room?.querySelector('h2')?.textContent).toBe("Ready can't open the privacy pool yet");
    // A reported version below the required one says so plainly, naming both.
    expect(room?.querySelector('p')?.textContent).toBe(
      'Ready is connected, but it reports Wallet API 0.9.0 and STRKWORLD needs 0.10.3 or later, so the city stays closed. Your funds are fine. Update Ready and check again, or connect a wallet that supports STRK20 private balances.',
    );
    expect(room?.querySelector('.room-detail')).toBeNull();
    expect(room?.querySelector('button')?.textContent).toBe(COPY.unsupported.action);
    expect(captured.current).toBeNull();
    expect(createPresence).not.toHaveBeenCalled();
    await unmountReactRoot(root);
    container.remove();
  });

  it('offers install links on the entry card only while no wallet is discovered (D-073)', () => {
    const empty = sessionAt('selection-required', null);
    const emptySnapshot = { ...empty.getSnapshot(), wallets: [] };
    const none = renderToStaticMarkup(
      <ProductionRoot
        session={{ ...empty, getSnapshot: () => emptySnapshot }}
        worldOut={createEventBus<WorldEvents>()}
        shellIn={createEventBus<ShellEvents>()}
        presence={createPresenceController({})}
        bridge={recoveryBridge()}
      />,
    );
    const some = renderToStaticMarkup(
      <ProductionRoot
        session={sessionAt('selection-required', null)}
        worldOut={createEventBus<WorldEvents>()}
        shellIn={createEventBus<ShellEvents>()}
        presence={createPresenceController({})}
        bridge={recoveryBridge()}
      />,
    );

    expect(none).toContain(COPY.connect.none);
    expect(none).toContain('data-testid="get-a-wallet"');
    expect(none).toContain('<a href="https://chromewebstore.google.com/detail/ready-x/dlcobpjiigpikoobohmabehhmhfoodbb" target="_blank" rel="noopener noreferrer">Ready</a>');
    expect(none).toContain('<a href="https://chromewebstore.google.com/detail/xverse-wallet/idnnbdplmphpflfnlkomgpfbpcgelopg" target="_blank" rel="noopener noreferrer">Xverse</a>');
    expect(some).not.toContain('data-testid="get-a-wallet"');
    expect(some).not.toContain('<a ');
  });

  it('looks again for wallets when the entry card mounts and when the page becomes visible (D-073)', async () => {
    const session = sessionAt('selection-required', null);
    const refreshDiscovery = vi.fn();
    const connect = vi.fn(session.connect);
    let visibility: DocumentVisibilityState = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <ProductionRoot
            session={{ ...session, refreshDiscovery, connect }}
            worldOut={createEventBus<WorldEvents>()}
            shellIn={createEventBus<ShellEvents>()}
            presence={createPresenceController({})}
            bridge={recoveryBridge()}
          />,
        );
        await flushReact();
      });
      expect(container.querySelector('[data-testid="wallet-entry-gate"]')).not.toBeNull();
      expect(refreshDiscovery).toHaveBeenCalledOnce();

      visibility = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
      expect(refreshDiscovery).toHaveBeenCalledOnce();
      visibility = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
      expect(refreshDiscovery).toHaveBeenCalledTimes(2);
      expect(connect).not.toHaveBeenCalled();

      await unmountReactRoot(root);
      document.dispatchEvent(new Event('visibilitychange'));
      expect(refreshDiscovery).toHaveBeenCalledTimes(2);
    } finally {
      Reflect.deleteProperty(document, 'visibilityState');
      container.remove();
    }
  });

  it('aborts capability detection when the connected gate is retired', async () => {
    const operations = new FakePrivacyOperations();
    const capturedSignals: AbortSignal[] = [];
    const capability = new Promise<{
      supportsStrk20: true;
      walletApiVersion: string;
      registration: 'unknown';
    }>(() => undefined);
    vi.spyOn(operations, 'capability').mockImplementation((signal) => {
      if (signal) capturedSignals.push(signal);
      return capability;
    });
    const session = reactiveSession('selection-required', null, operations);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <StrictMode>
          <ProductionRoot
            session={session}
            worldOut={createEventBus<WorldEvents>()}
            shellIn={createEventBus<ShellEvents>()}
            createPresence={() => createPresenceController({})}
            bridge={recoveryBridge()}
          />
        </StrictMode>,
      );
      await flushReact();
    });

    await act(async () => {
      session.publish('connected', '0xabc');
      await flushReact();
    });

    expect(session.getSnapshot().phase).toBe('connected');
    expect(container.querySelector('[data-testid="wallet-capability-gate"]')).not.toBeNull();
    expect(session.operations).toBe(operations);
    expect(operations.capability).toHaveBeenCalledOnce();
    expect(capturedSignals).toHaveLength(1);
    expect(capturedSignals.at(-1)?.aborted).toBe(false);

    await act(async () => {
      session.publish('connected', '0xdef');
      await flushReact();
    });

    expect(operations.capability).toHaveBeenCalledTimes(2);
    expect(capturedSignals[0]?.aborted).toBe(true);
    expect(capturedSignals.at(-1)?.aborted).toBe(false);

    await act(async () => {
      session.publish('selection-required', null);
      await flushReact();
    });
    await flushReact();

    expect(container.querySelector('[data-testid="wallet-entry-gate"]')).not.toBeNull();
    expect(capturedSignals.at(-1)?.aborted).toBe(true);
    await unmountReactRoot(root);
    container.remove();
  });

  it('passes the already-admitted capability into the financial composition', async () => {
    captured.current = null;
    const createPresence = vi.fn(() => createPresenceController({}));
    const session = sessionAt('connected', '0xabc', fundedOperations());
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <StrictMode>
          <ProductionRoot
            session={session}
            worldOut={createEventBus<WorldEvents>()}
            shellIn={createEventBus<ShellEvents>()}
            createPresence={createPresence}
            bridge={recoveryBridge()}
          />
        </StrictMode>,
      );
      await flushReact();
    });
    await enterCity(container);

    expect(captured.current).toMatchObject({
      initialConnectState: {
        name: 'connected',
        capability: {
          supportsStrk20: true,
          walletApiVersion: '0.10.3',
          registration: 'unknown',
        },
      },
    });
    await unmountReactRoot(root);
    container.remove();
  });

  it('composes production Bridge recovery while keeping new financial continuation locked', async () => {
    captured.current = null;
    const service = {} as never;
    const loadSources = vi.fn(async () => []);
    const loadRuntime = vi.fn(async () => ({ service, loadSources }));
    const bridge = { loadRuntime };
    const session = sessionAt('connected', '0xabc', fundedOperations());
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ProductionRoot
          session={session}
          worldOut={createEventBus<WorldEvents>()}
          shellIn={createEventBus<ShellEvents>()}
          createPresence={() => createPresenceController({})}
          bridge={bridge}
        />,
      );
      await flushReact();
    });
    await enterCity(container);

    expect((captured.current as Record<string, unknown> | null)?.bridge).toEqual({
      loadRuntime,
      account: '0xabc',
      readAccount: session.readAccount,
      planner: null,
    });
    expect(loadRuntime).not.toHaveBeenCalled();
    expect(loadSources).not.toHaveBeenCalled();
    await unmountReactRoot(root);
    container.remove();
  });

  it('keeps a rejected capability check at the gate with an explicit retry', async () => {
    const createPresence = vi.fn(() => createPresenceController({}));
    const operations = new FakePrivacyOperations();
    operations.injectFault({ kind: 'user-rejected', on: 'capability' });
    const session = sessionAt('connected', '0xabc', operations);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <StrictMode>
          <ProductionRoot
            session={session}
            worldOut={createEventBus<WorldEvents>()}
            shellIn={createEventBus<ShellEvents>()}
            createPresence={createPresence}
            bridge={recoveryBridge()}
          />
        </StrictMode>,
      );
      await flushReact();
    });

    expect(container.textContent).toContain(COPY.connect.retry);
    expect(createPresence).not.toHaveBeenCalled();
    await unmountReactRoot(root);
    container.remove();
  });

  it('owns one live presence across StrictMode and tears it down before a fresh reconnect owner', async () => {
    captured.current = null;
    const first = fakePresence();
    const second = fakePresence();
    const createPresence = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const session = reactiveSession('selection-required', null, fundedOperations());
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <StrictMode>
          <ProductionRoot
            session={session}
            worldOut={createEventBus<WorldEvents>()}
            shellIn={createEventBus<ShellEvents>()}
            createPresence={createPresence}
            bridge={recoveryBridge()}
          />
        </StrictMode>,
      );
    });
    expect(container.querySelector('[data-testid="wallet-entry-gate"]')).not.toBeNull();
    expect(createPresence).not.toHaveBeenCalled();

    await act(async () => {
      session.publish('connected', '0xabc');
      await flushReact();
    });
    // D-072: the presence owner waits for the entry gate.
    expect(createPresence).not.toHaveBeenCalled();
    await enterCity(container);
    expect(createPresence).toHaveBeenCalledOnce();
    expect(captured.current).toMatchObject({ walletSession: session });
    expect(first.destroy).not.toHaveBeenCalled();

    await act(async () => {
      session.publish('selection-required', null);
      await flushReact();
    });
    expect(first.destroy).toHaveBeenCalledOnce();
    expect(container.querySelector('[data-testid="wallet-entry-gate"]')).not.toBeNull();

    await act(async () => {
      session.publish('connected', '0xdef');
      await flushReact();
    });
    // Another account checks again before its city exists.
    expect(createPresence).toHaveBeenCalledOnce();
    await enterCity(container);
    expect(createPresence).toHaveBeenCalledTimes(2);
    expect(second.destroy).not.toHaveBeenCalled();

    await unmountReactRoot(root);
    expect(second.destroy).toHaveBeenCalledOnce();
    container.remove();
  });

  it('does not expose the previous session while replacing it with a disconnected session', async () => {
    captured.current = null;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const first = sessionAt('connected', '0xabc', fundedOperations());

    await act(async () => {
      root.render(
        <ProductionRoot
          session={first}
          worldOut={createEventBus<WorldEvents>()}
          shellIn={createEventBus<ShellEvents>()}
          createPresence={() => createPresenceController({})}
          bridge={recoveryBridge()}
        />,
      );
      await flushReact();
    });
    await enterCity(container);
    expect(captured.current).not.toBeNull();

    captured.current = null;
    await act(async () => {
      root.render(
        <ProductionRoot
          session={sessionAt('selection-required', null)}
          worldOut={createEventBus<WorldEvents>()}
          shellIn={createEventBus<ShellEvents>()}
          createPresence={() => createPresenceController({})}
          bridge={recoveryBridge()}
        />,
      );
      await flushReact();
    });

    expect(container.querySelector('[data-testid="wallet-entry-gate"]')).not.toBeNull();
    expect(captured.current).toBeNull();
    await unmountReactRoot(root);
    container.remove();
  });

  it('contains descriptor-valid hostile session snapshots at the production gate', () => {
    const base = sessionAt('selection-required', null);
    const raw = base.getSnapshot();
    const hostile = new Proxy(raw, {
      get(_target, key) {
        throw new Error(`session snapshot get trap must not escape for ${String(key)}`);
      },
    });
    const session = { ...base, getSnapshot: () => hostile };

    expect(() => renderToStaticMarkup(
      <ProductionRoot
        session={session}
        worldOut={createEventBus<WorldEvents>()}
        shellIn={createEventBus<ShellEvents>()}
        createPresence={() => createPresenceController({})}
        bridge={recoveryBridge()}
      />,
    )).not.toThrow();
  });

  it('fails closed when a session snapshot read throws after connection', () => {
    const base = sessionAt('connected', '0xabc');
    const session = { ...base, getSnapshot: () => { throw new Error('snapshot unavailable'); } };

    const markup = renderToStaticMarkup(
      <ProductionRoot
        session={session}
        worldOut={createEventBus<WorldEvents>()}
        shellIn={createEventBus<ShellEvents>()}
        createPresence={() => createPresenceController({})}
        bridge={recoveryBridge()}
      />,
    );

    expect(markup).toContain('data-testid="wallet-entry-gate"');
    expect(markup).not.toContain('production app');
  });

});

function sessionAt(
  phase: 'connected' | 'selection-required' | 'connecting' | 'wrong-network',
  account: string | null,
  operations = new FakePrivacyOperations(),
): WalletSession {
  const snapshot = {
    phase,
    wallets: [{ key: 'wallet-1', name: 'Ready', icon: 'data:image/svg+xml,ready' }],
    selectedKey: phase === 'connected' ? 'wallet-1' : null,
    account,
    generation: phase === 'connected' ? 1 : 0,
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

function reactiveSession(
  phase: 'connected' | 'selection-required',
  account: string | null,
  operations = new FakePrivacyOperations(),
): WalletSession & { publish(nextPhase: 'connected' | 'selection-required', nextAccount: string | null): void } {
  let current = sessionAt(phase, account, operations);
  const listeners = new Set<() => void>();
  return {
    ...current,
    getSnapshot: () => current.getSnapshot(),
    // As in the real session, the account read follows the published snapshot.
    readAccount: () => current.readAccount(),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    publish(nextPhase, nextAccount) {
      current = sessionAt(nextPhase, nextAccount, current.operations as FakePrivacyOperations);
      listeners.forEach((listener) => listener());
    },
  };
}

function fakePresence(): PresenceController {
  return {
    listen: () => () => undefined,
    subscribe: () => () => undefined,
    getState: () => ({ status: 'unavailable', canReconnect: false }),
    remotePeers: { subscribe: () => () => undefined },
    reconnect: vi.fn(),
    destroy: vi.fn(async () => undefined),
  };
}

function recoveryBridge() {
  return {
    loadRuntime: async () => ({ service: {} as never, loadSources: async () => [] }),
  };
}

async function flushReact(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function unmountReactRoot(root: ReturnType<typeof createRoot>): Promise<void> {
  await act(async () => {
    root.unmount();
    await flushReact();
  });
}

describe('ProductionRoot Bridge shield planner (D-061)', () => {
  const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
  const ONE_STRK = 10n ** 18n;
  const SHIELD_ENV = {
    VITE_STRK20_SHIELD_ENABLED: 'true',
    VITE_STRK20_SHIELD_MAX_INTENTS: '1',
    VITE_STRK20_SHIELD_ALLOWED_TOKENS: STRK,
  };
  const TRANSFER_ENV = {
    VITE_STRK20_TRANSFER_ENABLED: 'true',
    VITE_STRK20_TRANSFER_MAX_INTENTS: '1',
    VITE_STRK20_TRANSFER_MAX_RELAY_FEE: '5',
    VITE_STRK20_TRANSFER_ALLOWED_TOKENS: STRK,
  };
  const UNSHIELD_ENV = {
    VITE_STRK20_UNSHIELD_ENABLED: 'true',
    VITE_STRK20_UNSHIELD_MAX_INTENTS: '1',
    VITE_STRK20_UNSHIELD_MAX_RELAY_FEE: '5',
    VITE_STRK20_UNSHIELD_ALLOWED_TOKENS: STRK,
  };
  const shieldPolicy = parseRoutePolicy(SHIELD_ENV);
  const reservePlanner: ShieldPlannerFactory = (options) => new ReservePublicShieldPlanner(options);

  function admittedOperations(): FakePrivacyOperations {
    return fundedOperations();
  }

  async function mountConnected({
    policy,
    createShieldPlanner,
    operations = admittedOperations(),
    remembered = false,
  }: {
    policy: WalletRoutePolicy | null;
    createShieldPlanner?: ShieldPlannerFactory;
    operations?: FakePrivacyOperations;
    /** This tab already let the account in (D-072), so the city mounts straight away. */
    remembered?: boolean;
  }) {
    captured.current = null;
    const session = sessionAt('connected', '0xabc', operations);
    const worldOut = createEventBus<WorldEvents>();
    const shellIn = createEventBus<ShellEvents>();
    const createPresence = () => createPresenceController({});
    const bridge = recoveryBridge();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const render = async () => {
      await act(async () => {
        root.render(
          <ProductionRoot
            session={session}
            worldOut={worldOut}
            shellIn={shellIn}
            createPresence={createPresence}
            bridge={bridge}
            policy={policy}
            createShieldPlanner={createShieldPlanner}
          />,
        );
        await flushReact();
      });
    };
    await render();
    await enterCity(container, { remembered });
    return {
      render,
      planner: () => (captured.current?.bridge as { planner: PublicShieldPlanner | null } | undefined)?.planner,
      async unmount() {
        await unmountReactRoot(root);
        container.remove();
      },
    };
  }

  it('injects the reserve planner when shield is enabled, reading the live fee through the session', async () => {
    const operations = admittedOperations();
    const poolConfig = vi.spyOn(operations, 'poolConfig');
    const factory = vi.fn(reservePlanner);
    const mounted = await mountConnected({ policy: shieldPolicy, createShieldPlanner: factory, operations });

    const planner = mounted.planner();
    expect(planner).toBeInstanceOf(ReservePublicShieldPlanner);
    expect(factory).toHaveBeenCalledWith({ pool: { config: expect.any(Function) }, readAccount: expect.any(Function) });
    poolConfig.mockClear();

    await expect(planner!.planMax({ token: STRK, available: 100n * ONE_STRK, expectedRecipient: '0xabc' }))
      .resolves.toMatchObject({
        recipient: '0xabc',
        poolFee: 6n * ONE_STRK,
        plannedReserve: 10n * ONE_STRK,
        amountToShield: 90n * ONE_STRK,
      });
    expect(poolConfig).toHaveBeenCalledOnce();
    await mounted.unmount();
  });

  it.each([
    ['no production policy', null],
    ['a deny-all policy', parseRoutePolicy({})],
    ['a transfer-only policy', parseRoutePolicy(TRANSFER_ENV)],
    ['an unshield-only policy', parseRoutePolicy(UNSHIELD_ENV)],
    ['transfer and unshield without shield', parseRoutePolicy({ ...TRANSFER_ENV, ...UNSHIELD_ENV })],
  ])('keeps the Bridge recovery-only under %s, without building a planner', async (_name, policy) => {
    const factory = vi.fn(reservePlanner);
    const mounted = await mountConnected({ policy, createShieldPlanner: factory });

    expect(captured.current).not.toBeNull();
    expect(mounted.planner()).toBeNull();
    expect(factory).not.toHaveBeenCalled();
    await mounted.unmount();
  });

  it('stays recovery-only when shield is enabled but no planner was composed, or composing it throws', async () => {
    const absent = await mountConnected({ policy: shieldPolicy });
    expect(absent.planner()).toBeNull();
    await absent.unmount();

    const throwing = await mountConnected({
      policy: shieldPolicy,
      createShieldPlanner: () => { throw new Error('planner unavailable'); },
      // The same account, in the same tab: its pass from the first mount holds.
      remembered: true,
    });
    expect(captured.current).not.toBeNull();
    expect(throwing.planner()).toBeNull();
    await throwing.unmount();
  });

  it('keeps one planner across re-renders so an open Bridge panel is not reset', async () => {
    const factory = vi.fn(reservePlanner);
    const mounted = await mountConnected({ policy: shieldPolicy, createShieldPlanner: factory });
    const first = mounted.planner();

    await mounted.render();

    expect(first).toBeInstanceOf(ReservePublicShieldPlanner);
    expect(mounted.planner()).toBe(first);
    expect(factory).toHaveBeenCalledOnce();
    await mounted.unmount();
  });

  it('enables planning only for a policy that admits the STRK shield route', () => {
    const hostile = { ...shieldPolicy };
    Object.defineProperty(hostile, 'enabledRoutes', { get() { throw new Error('hostile policy'); } });

    expect(shieldPlanningEnabled(shieldPolicy)).toBe(true);
    expect(shieldPlanningEnabled(parseRoutePolicy({ ...SHIELD_ENV, ...TRANSFER_ENV, ...UNSHIELD_ENV }))).toBe(true);
    expect(shieldPlanningEnabled({ ...shieldPolicy, allowedTokens: { ...shieldPolicy.allowedTokens, shield: [`0x${STRK.slice(3)}`] } })).toBe(true);
    expect(shieldPlanningEnabled(null)).toBe(false);
    expect(shieldPlanningEnabled(undefined)).toBe(false);
    expect(shieldPlanningEnabled(parseRoutePolicy({}))).toBe(false);
    expect(shieldPlanningEnabled(parseRoutePolicy(TRANSFER_ENV))).toBe(false);
    expect(shieldPlanningEnabled(parseRoutePolicy(UNSHIELD_ENV))).toBe(false);
    expect(shieldPlanningEnabled({ ...shieldPolicy, allowedTokens: { ...shieldPolicy.allowedTokens, shield: ['0x123'] } })).toBe(false);
    // D-072: the Bridge still plans only a STRK shield, so a wider list keeps it
    // on while STRK is in it, and off when it is not.
    const railway = parseRoutePolicy({
      ...SHIELD_ENV,
      VITE_STRK20_SHIELD_ALLOWED_TOKENS: [
        STRK,
        '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7',
        '0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb',
        '0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8',
        '0x03fe2b97c1fd336e750087d68b9b867997fd64a2661ff3ca5a7c771641e8e7ac',
      ].join(','),
    });
    expect(railway.allowedTokens.shield).toHaveLength(5);
    expect(shieldPlanningEnabled(railway)).toBe(true);
    expect(shieldPlanningEnabled(parseRoutePolicy({
      ...SHIELD_ENV,
      VITE_STRK20_SHIELD_ALLOWED_TOKENS: '0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb',
    }))).toBe(false);
    expect(shieldPlanningEnabled(hostile as WalletRoutePolicy)).toBe(false);
  });
});

describe('ProductionRoot entry gate (D-072)', () => {
  const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
  const shieldPolicy = parseRoutePolicy({
    VITE_STRK20_SHIELD_ENABLED: 'true',
    VITE_STRK20_SHIELD_MAX_INTENTS: '1',
    VITE_STRK20_SHIELD_ALLOWED_TOKENS: STRK,
  });

  async function mount(session: WalletSession, {
    createPresence = vi.fn(() => createPresenceController({})),
    policy = shieldPolicy,
  }: {
    createPresence?: () => PresenceController;
    policy?: WalletRoutePolicy | null;
  } = {}) {
    captured.current = null;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <StrictMode>
          <ProductionRoot
            session={session}
            worldOut={createEventBus<WorldEvents>()}
            shellIn={createEventBus<ShellEvents>()}
            createPresence={createPresence}
            bridge={recoveryBridge()}
            policy={policy}
          />
        </StrictMode>,
      );
      await flushReact();
    });
    await settleGate(container);
    return {
      container,
      createPresence,
      async unmount() {
        await unmountReactRoot(root);
        container.remove();
      },
    };
  }

  function clickLabelled(container: HTMLElement, label: string): Promise<void> {
    const found = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent === label);
    if (!found) throw new Error(`No button labelled ${label}`);
    return act(async () => {
      found.click();
      await flushReact();
    });
  }

  it('holds the presence owner, the World and the HUD until the check passes', async () => {
    const operations = fundedOperations();
    const check = vi.spyOn(operations, 'hasPrivateFunds');
    const mounted = await mount(sessionAt('connected', '0xabc', operations));

    expect(mounted.container.querySelector('[data-testid="entry-gate"]')?.getAttribute('data-gate')).toBe('ready');
    expect(mounted.container.textContent).toContain(COPY.entry.title);
    expect(mounted.createPresence).not.toHaveBeenCalled();
    expect(captured.current).toBeNull();
    // Nothing reads a balance until the player asks.
    expect(check).not.toHaveBeenCalled();

    await enterCity(mounted.container);
    expect(check).toHaveBeenCalledOnce();
    expect(mounted.createPresence).toHaveBeenCalledOnce();
    expect(captured.current).toMatchObject({ operations });
    await mounted.unmount();
  });

  it('deposits its way in through the session, then opens the city once the receipt lands', async () => {
    const operations = new FakePrivacyOperations({
      capability: { supportsStrk20: true, walletApiVersion: '0.10.3', registration: 'unknown' },
    });
    const status = vi.spyOn(operations, 'depositStatus');
    const mounted = await mount(sessionAt('connected', '0xabc', operations));

    await enterCity(mounted.container);
    expect(mounted.container.querySelector('[data-gate="deposit"]')).not.toBeNull();
    expect(mounted.createPresence).not.toHaveBeenCalled();

    const input = mounted.container.querySelector<HTMLInputElement>('input[name="amount"]')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(input, '7');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await clickLabelled(mounted.container, COPY.entry.review);
    await clickLabelled(mounted.container, COPY.flow.confirm);

    expect(operations.submitted).toEqual([[{ kind: 'shield', token: STRK, amount: 7n * 10n ** 18n }]]);
    expect(status).toHaveBeenCalledWith('0xfake0001', expect.anything());
    expect(mounted.createPresence).toHaveBeenCalledOnce();
    expect(captured.current).not.toBeNull();
    await mounted.unmount();
  });

  it('admits a not-registered capability to the gate, never straight to the city', async () => {
    const operations = new FakePrivacyOperations({
      capability: { supportsStrk20: true, walletApiVersion: '0.10.3', registration: 'unregistered' },
    });
    const mounted = await mount(sessionAt('connected', '0xabc', operations));
    expect(mounted.container.querySelector('[data-testid="entry-gate"]')).not.toBeNull();
    expect(mounted.createPresence).not.toHaveBeenCalled();
    expect(captured.current).toBeNull();
    await mounted.unmount();
  });

  it('offers the deposit only through the build\'s shield policy', async () => {
    const mounted = await mount(sessionAt('connected', '0xabc', new FakePrivacyOperations()), { policy: parseRoutePolicy({}) });
    await enterCity(mounted.container);
    expect(mounted.container.querySelector('.room-locked')?.textContent).toBe(COPY.locked.notEnabled.shield);
    expect(mounted.container.querySelector('input[name="amount"]')).toBeNull();
    await mounted.unmount();
  });

  /**
   * A connected session whose wallet switches account in place, as Ready's
   * account switcher does: the snapshot moves to a new generation and
   * account, and `readAccount` answers the new one at once.
   */
  function switchingSession(account: string, operations: FakePrivacyOperations) {
    let current = account;
    let generation = 1;
    const listeners = new Set<() => void>();
    const build = () => ({
      phase: 'connected' as const,
      wallets: [{ key: 'wallet-1', name: 'Ready', icon: 'data:image/svg+xml,ready' }],
      selectedKey: 'wallet-1',
      account: current,
      generation,
    });
    let snapshot = build();
    const session: WalletSession = {
      operations,
      getSnapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      connect: async () => snapshot,
      refreshDiscovery: () => undefined,
      readAccount: () => current,
      disconnect: async () => undefined,
      destroy: () => undefined,
    };
    return {
      session,
      async switchTo(next: string) {
        await act(async () => {
          current = next;
          generation += 1;
          snapshot = build();
          listeners.forEach((listener) => listener());
          await flushReact();
        });
      },
    };
  }

  it('lets no one in when the account switches in place while the wallet is asking', async () => {
    const operations = fundedOperations();
    let answer!: (funded: boolean) => void;
    const check = vi.spyOn(operations, 'hasPrivateFunds').mockImplementationOnce(
      () => new Promise<boolean>((resolve) => { answer = resolve; }),
    );
    const wallet = switchingSession('0xabc', operations);
    const mounted = await mount(wallet.session);
    await enterCity(mounted.container);
    expect(mounted.container.querySelector('[data-gate="checking"]')).not.toBeNull();

    await wallet.switchTo('0xdef');
    await act(async () => {
      answer(true);
      await flushReact();
    });
    await settleGate(mounted.container);

    // The new account meets its own gate, and nobody was let in or remembered.
    expect(mounted.container.querySelector('[data-gate="ready"]')).not.toBeNull();
    expect(mounted.createPresence).not.toHaveBeenCalled();
    expect(captured.current).toBeNull();
    expect(check).toHaveBeenCalledOnce();
    for (let turn = 0; turn < 5; turn += 1) await act(async () => { await flushReact(); });
    expect(sessionStorage.length).toBe(0);
    await mounted.unmount();
  });

  it('lets no one in when the account switches in place while the wallet is signing the deposit', async () => {
    const operations = new FakePrivacyOperations();
    let sign!: () => void;
    vi.spyOn(operations, 'prepare').mockImplementationOnce(async (intents) => {
      const batch = await new FakePrivacyOperations().prepare(intents);
      return {
        ...batch,
        confirm: async (options: Parameters<typeof batch.confirm>[0]) => {
          options.onProgress?.({ stage: 'awaiting-approval', message: 'Confirm the shield in your wallet' });
          await new Promise<void>((resolve) => { sign = resolve; });
          return { transactionHash: '0x5eed' };
        },
      };
    });
    const status = vi.spyOn(operations, 'depositStatus').mockResolvedValue('landed');
    const wallet = switchingSession('0xabc', operations);
    const mounted = await mount(wallet.session);
    await enterCity(mounted.container);

    const input = mounted.container.querySelector<HTMLInputElement>('input[name="amount"]')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(input, '3');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await clickLabelled(mounted.container, COPY.entry.review);
    await clickLabelled(mounted.container, COPY.flow.confirm);
    expect(mounted.container.querySelector('[data-gate="depositing"]')).not.toBeNull();

    await wallet.switchTo('0xdef');
    await act(async () => {
      sign();
      await flushReact();
    });
    await settleGate(mounted.container);

    expect(mounted.container.querySelector('[data-gate="ready"]')).not.toBeNull();
    expect(mounted.createPresence).not.toHaveBeenCalled();
    expect(captured.current).toBeNull();
    // The old account's receipt is never read on the new account's behalf.
    expect(status).not.toHaveBeenCalled();
    for (let turn = 0; turn < 5; turn += 1) await act(async () => { await flushReact(); });
    expect(sessionStorage.length).toBe(0);
    await mounted.unmount();
  });

  it('lets the same account back in on a reload without a second balance prompt', async () => {
    const operations = fundedOperations();
    const check = vi.spyOn(operations, 'hasPrivateFunds');
    const first = await mount(sessionAt('connected', '0xabc', operations));
    await enterCity(first.container);
    for (let turn = 0; turn < 20 && sessionStorage.length === 0; turn += 1) await act(async () => { await flushReact(); });
    await first.unmount();

    const reload = await mount(sessionAt('connected', '0xabc', operations));
    await enterCity(reload.container, { remembered: true });
    expect(check).toHaveBeenCalledOnce();
    expect(reload.createPresence).toHaveBeenCalledOnce();
    await reload.unmount();

    const other = await mount(sessionAt('connected', '0xdef', operations));
    expect(other.container.querySelector('[data-gate="ready"]')).not.toBeNull();
    expect(other.createPresence).not.toHaveBeenCalled();
    await other.unmount();
  });
});
