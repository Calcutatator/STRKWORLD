import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
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
});
