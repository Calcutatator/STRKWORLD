import { describe, expect, it } from 'vitest';
import { createWalletSession, type WalletHandle } from './session.js';

describe('WalletSession discovery boundary', () => {
  it('owns descriptor-valid wallet display fields without invoking a hostile get trap', () => {
    const wallet = new Proxy(
      { name: 'Ready', icon: 'data:image/svg+xml,wallet' },
      { get() { throw new Error('wallet display getter must not run'); } },
    ) as WalletHandle;

    const session = createWalletSession(
      {
        rpcUrl: 'https://rpc.example',
        backendBaseUrl: '/api',
        policy: {
          maxIntents: 0,
          maxRelayFee: 0n,
          enabledRoutes: [],
          allowedTokens: { shield: [], unshield: [], transfer: [], swap: [] },
        },
      },
      {
        discovery: {
          getWallets: () => [wallet],
          subscribe: () => () => undefined,
          refresh: () => undefined,
        },
        connectWallet: async () => {
          throw new Error('connection should not be attempted');
        },
      },
    );

    expect(session.getSnapshot().wallets).toEqual([{
      key: 'wallet-1',
      name: 'Ready',
      icon: 'data:image/svg+xml,wallet',
    }]);
  });
});
