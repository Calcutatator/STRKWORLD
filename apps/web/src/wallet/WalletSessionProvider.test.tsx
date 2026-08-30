// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { WalletSession } from '@strkworld/privacy';
import {
  WalletSessionProvider,
  useWalletSessionOptional,
  type WalletSessionRuntime,
} from './WalletSessionProvider.js';

function sessionFixture(): WalletSession {
  const snapshot = Object.freeze({
    phase: 'connected' as const,
    wallets: Object.freeze([]),
    selectedKey: 'wallet-1',
    account: '0xabc',
    generation: 1,
  });
  return {
    operations: {} as never,
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    connect: async () => snapshot,
    refreshDiscovery: () => undefined,
    readAccount: () => snapshot.account,
    disconnect: async () => undefined,
    destroy: () => undefined,
  };
}

describe('WalletSessionProvider', () => {
  it('publishes an immutable runtime context snapshot', () => {
    const session = sessionFixture();
    let captured!: WalletSessionRuntime;
    function Capture() {
      captured = useWalletSessionOptional()!;
      return null;
    }

    renderToStaticMarkup(
      <WalletSessionProvider session={session}>
        <Capture />
      </WalletSessionProvider>,
    );

    expect(Object.isFrozen(captured)).toBe(true);
    expect(Reflect.set(captured, 'session', null)).toBe(false);
    expect(Reflect.set(captured, 'disconnect', async () => undefined)).toBe(false);
    expect(captured.session).toBe(session);
    expect(captured.snapshot.account).toBe('0xabc');
  });

  it('retains the WalletSession receiver for external-store callbacks', () => {
    const session = sessionFixture();
    const snapshot = session.getSnapshot();
    session.getSnapshot = function (this: WalletSession) {
      if (this !== session) throw new Error('WalletSession receiver lost');
      return snapshot;
    };
    session.subscribe = function (this: WalletSession) {
      if (this !== session) throw new Error('WalletSession receiver lost');
      return () => undefined;
    };

    expect(() => renderToStaticMarkup(
      <WalletSessionProvider session={session}><span>ready</span></WalletSessionProvider>,
    )).not.toThrow();
  });

  it('keeps a replacement session subscribed when the old unsubscribe throws', async () => {
    const first = sessionFixture();
    const second = sessionFixture();
    const firstUnsubscribe = vi.fn(() => {
      throw new Error('old session unsubscribe failed');
    });
    const secondSubscribe = vi.fn(() => () => undefined);
    first.subscribe = vi.fn(() => firstUnsubscribe);
    second.subscribe = secondSubscribe;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<WalletSessionProvider session={first}><span>ready</span></WalletSessionProvider>);
      await Promise.resolve();
    });
    await act(async () => {
      root.render(<WalletSessionProvider session={second}><span>ready</span></WalletSessionProvider>);
      await Promise.resolve();
    });

    expect(firstUnsubscribe).toHaveBeenCalledOnce();
    expect(secondSubscribe).toHaveBeenCalledOnce();
    expect(container.textContent).toBe('ready');
    root.unmount();
    container.remove();
  });
});
