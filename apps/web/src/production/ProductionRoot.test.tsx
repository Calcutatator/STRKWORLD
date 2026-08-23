// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { FakePrivacyOperations, type WalletSession } from '@strkworld/privacy';
import { createEventBus } from '../bus/event-bus.js';
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

import { capabilityAdmits, ProductionRoot } from './ProductionRoot.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('ProductionRoot', () => {
  it('keeps the connected tree behind capability admission', () => {
    captured.current = null;
    renderToStaticMarkup(
      <ProductionRoot
        session={sessionAt('connected', '0xabc')}
        worldOut={createEventBus<WorldEvents>()}
        shellIn={createEventBus<ShellEvents>()}
        presence={createPresenceController({})}
      />,
    );

    expect(captured.current).toBeNull();
    expect(capabilityAdmits({ name: 'unsupported-wallet', walletApiVersion: '0.9.0' })).toBe(false);
    expect(capabilityAdmits({ name: 'unreachable' })).toBe(false);
    expect(capabilityAdmits({ name: 'not-registered' })).toBe(true);
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
      />,
    );

    expect(markup).toContain('Switch this wallet to Starknet mainnet');
    expect(markup).not.toContain('production app');
    expect(captured.current).toBeNull();
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
          />
        </StrictMode>,
      );
      await flushReact();
    });

    expect(container.textContent).toContain(COPY.unsupported.title);
    expect(captured.current).toBeNull();
    expect(createPresence).not.toHaveBeenCalled();
    root.unmount();
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
          />
        </StrictMode>,
      );
      await flushReact();
    });

    expect(container.textContent).toContain(COPY.connect.retry);
    expect(createPresence).not.toHaveBeenCalled();
    root.unmount();
    container.remove();
  });

  it('owns one live presence across StrictMode and tears it down before a fresh reconnect owner', async () => {
    captured.current = null;
    const first = fakePresence();
    const second = fakePresence();
    const createPresence = vi.fn()
      .mockReturnValueOnce(first)
      .mockReturnValueOnce(second);
    const session = reactiveSession('selection-required', null);
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
    expect(createPresence).toHaveBeenCalledTimes(2);
    expect(second.destroy).not.toHaveBeenCalled();

    root.unmount();
    await flushReact();
    expect(second.destroy).toHaveBeenCalledOnce();
    container.remove();
  });

});

function sessionAt(
  phase: 'connected' | 'selection-required' | 'wrong-network',
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
): WalletSession & { publish(nextPhase: 'connected' | 'selection-required', nextAccount: string | null): void } {
  let current = sessionAt(phase, account);
  const listeners = new Set<() => void>();
  return {
    ...current,
    getSnapshot: () => current.getSnapshot(),
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

async function flushReact(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
