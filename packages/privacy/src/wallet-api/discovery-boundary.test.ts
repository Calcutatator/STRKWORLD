import { describe, expect, it } from 'vitest';
import { StarknetInjectedWallet } from '@starknet-io/get-starknet-wallet-standard';
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

describe('WalletSession discovery lists wallets whose display fields are getters', () => {
  const options = {
    rpcUrl: 'https://rpc.example',
    backendBaseUrl: '/api',
    policy: {
      maxIntents: 0,
      maxRelayFee: 0n,
      enabledRoutes: [],
      allowedTokens: { shield: [], unshield: [], transfer: [], swap: [] },
    },
  } as const;
  const sessionWith = (wallets: unknown[]) =>
    createWalletSession(options, {
      discovery: { getWallets: () => wallets as WalletHandle[], subscribe: () => () => undefined, refresh: () => undefined },
      connectWallet: async () => {
        throw new Error('connection should not be attempted');
      },
    });

  it("lists a legacy injected wallet wrapped by get-starknet's own StarknetInjectedWallet", () => {
    // Exactly what discovery registers for a `window.starknet_*` wallet: its
    // name and icon are prototype getters, not own data properties.
    const injected = {
      id: 'ready',
      name: 'Ready',
      icon: 'data:image/svg+xml,ready',
      version: '1.0.0',
      request: async () => undefined,
      on: () => undefined,
      off: () => undefined,
    };
    const wallet = new StarknetInjectedWallet(injected as never);
    expect(Object.getOwnPropertyDescriptor(wallet, 'name')).toBeUndefined();
    expect(sessionWith([wallet]).getSnapshot().wallets).toEqual([
      { key: 'wallet-1', name: 'Ready', icon: 'data:image/svg+xml,ready' },
    ]);
  });

  it('lists a class-based Wallet Standard wallet with getter fields', () => {
    class XverseLike {
      get name() {
        return 'Xverse';
      }
      get icon() {
        return 'data:image/svg+xml,xverse';
      }
    }
    expect(sessionWith([new XverseLike()]).getSnapshot().wallets).toEqual([
      { key: 'wallet-1', name: 'Xverse', icon: 'data:image/svg+xml,xverse' },
    ]);
  });

  it('drops a wallet whose getter throws or returns a non-string, without escaping', () => {
    class Broken {
      get name(): string {
        throw new Error('broken wallet');
      }
      get icon() {
        return 'data:image/svg+xml,x';
      }
    }
    const numeric = { name: 7, icon: 'data:image/svg+xml,x' };
    expect(() => sessionWith([new Broken(), numeric])).not.toThrow();
    expect(sessionWith([new Broken(), numeric]).getSnapshot().wallets).toEqual([]);
  });
});
