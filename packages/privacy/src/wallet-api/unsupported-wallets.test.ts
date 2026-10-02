/**
 * @vitest-environment jsdom
 */

import { createStore } from '@starknet-io/get-starknet-discovery';
import { StarknetInjectedWallet } from '@starknet-io/get-starknet-wallet-standard';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWalletDiscovery } from './discovery.js';
import {
  createProductionWalletSession,
  createWalletSession,
  type WalletDiscoveryPort,
  type WalletHandle,
} from './session.js';
import {
  isUnsupportedWallet,
  matchesUnsupportedIdentity,
  UNSUPPORTED_WALLETS,
} from './unsupported-wallets.js';

/**
 * D-108. MetaMask's Starknet Snap does not implement the STRK20 Wallet API.
 * It is left out of discovery, and a wallet whose connect fails is asked
 * exactly once per click: nothing in the session retries it.
 */

const OPTIONS = {
  rpcUrl: 'https://rpc.invalid',
  backendBaseUrl: '/api',
  policy: {
    maxIntents: 0,
    maxRelayFee: 0n,
    enabledRoutes: [],
    allowedTokens: { shield: [], unshield: [], transfer: [], swap: [] },
  },
} as const;

const MAINNET = '0x534e5f4d41494e';
const ICON = 'data:image/svg+xml,wallet';

/** Shaped like get-starknet's MetaMaskVirtualWallet: prototype getters only. */
class MetaMaskLikeVirtualWallet {
  get version() { return '1.0.0'; }
  get name() { return 'MetaMask'; }
  get icon() { return ICON; }
  get chains() { return [`starknet:${MAINNET}`]; }
  get accounts() { return []; }
  get features() {
    return {
      'standard:connect': { version: '1.0.0', connect: async () => ({ accounts: [] }) },
      'standard:disconnect': { version: '1.0.0', disconnect: async () => undefined },
      'standard:events': { version: '1.0.0', on: () => () => undefined },
      'starknet:walletApi': { id: 'metamask', version: '1.0.0', walletVersion: '2.0.0', request: async () => null },
    };
  }
}

function legacyInjected(id: string, name: string) {
  return { id, name, version: '1.0.0', icon: ICON, request: async () => null, on: () => undefined, off: () => undefined };
}

function wallet(name: string, extra: Record<string, unknown> = {}): WalletHandle {
  return { name, icon: `data:image/svg+xml,${name}`, ...extra } as WalletHandle;
}

function discoveryWith(...wallets: unknown[]): WalletDiscoveryPort {
  return {
    getWallets: () => wallets as WalletHandle[],
    subscribe: () => () => undefined,
    refresh: () => undefined,
  };
}

const refuseConnection = async (): Promise<never> => {
  throw new Error('connection should not be attempted');
};

describe('the unsupported-wallet denylist (D-108)', () => {
  it('has one entry, MetaMask', () => {
    expect(UNSUPPORTED_WALLETS.map(({ token }) => token)).toEqual(['metamask']);
  });

  it.each([
    'MetaMask',
    'metamask',
    'METAMASK',
    'Meta Mask',
    'MetaMask Starknet Snap',
    'metamask-snap',
    'io.metamask',
    'io.metamask.flask',
    'io.metamask.mmi',
    'npm:@consensys/starknet-snap/metamask',
  ])('matches the MetaMask id variant %j', (value) => {
    expect(matchesUnsupportedIdentity(value)).toBe(true);
  });

  it.each(['Ready', 'Ready Wallet (formerly Argent)', 'Argent X', 'argentX', 'Xverse', 'xverse', 'Braavos', 'braavos', 'OKX Wallet', 'Keplr', '', '...'])(
    'leaves %j alone',
    (value) => {
      expect(matchesUnsupportedIdentity(value)).toBe(false);
    },
  );

  it('matches MetaMask by name, own id, rdns, Wallet API id, or a wrapped legacy global', () => {
    expect(isUnsupportedWallet(wallet('MetaMask'))).toBe(true);
    expect(isUnsupportedWallet(wallet('Starknet Snap', { id: 'metamask' }))).toBe(true);
    expect(isUnsupportedWallet(wallet('Starknet Snap', { rdns: 'io.metamask.flask' }))).toBe(true);
    expect(isUnsupportedWallet(new MetaMaskLikeVirtualWallet())).toBe(true);
    expect(isUnsupportedWallet(new StarknetInjectedWallet(legacyInjected('metamask', 'Starknet Snap') as never)))
      .toBe(true);
  });

  it('never matches Ready or Xverse, as wrapped legacy globals or plain wallets', () => {
    expect(isUnsupportedWallet(new StarknetInjectedWallet(legacyInjected('argentX', 'Ready Wallet (formerly Argent)') as never)))
      .toBe(false);
    expect(isUnsupportedWallet(new StarknetInjectedWallet(legacyInjected('xverse', 'Xverse') as never))).toBe(false);
    expect(isUnsupportedWallet(wallet('Ready', { id: 'ready' }))).toBe(false);
    expect(isUnsupportedWallet(wallet('Xverse', { rdns: 'com.xverse' }))).toBe(false);
  });

  it('does not run own accessors and survives a hostile proxy', () => {
    let ran = false;
    const accessor = wallet('Ready');
    Object.defineProperty(accessor, 'id', { get() { ran = true; return 'metamask'; } });
    expect(isUnsupportedWallet(accessor)).toBe(false);
    expect(ran).toBe(false);

    const hostile = new Proxy({}, { get() { throw new Error('trap'); }, getOwnPropertyDescriptor() { throw new Error('trap'); } });
    expect(() => isUnsupportedWallet(hostile)).not.toThrow();
    expect(isUnsupportedWallet(hostile)).toBe(false);
    expect(isUnsupportedWallet(null)).toBe(false);
    expect(isUnsupportedWallet('MetaMask')).toBe(false);
  });
});

describe('WalletSession leaves MetaMask out of the picker (D-108)', () => {
  it('lists Ready and Xverse, in discovery order, and no MetaMask variant', () => {
    const session = createWalletSession(OPTIONS, {
      discovery: discoveryWith(
        new MetaMaskLikeVirtualWallet(),
        new StarknetInjectedWallet(legacyInjected('argentX', 'Ready Wallet (formerly Argent)') as never),
        wallet('MetaMask Starknet Snap'),
        new StarknetInjectedWallet(legacyInjected('xverse', 'Xverse') as never),
        new StarknetInjectedWallet(legacyInjected('metamask', 'Starknet Snap') as never),
      ),
      connectWallet: refuseConnection,
    });

    expect(session.getSnapshot().wallets.map(({ key, name }) => [key, name])).toEqual([
      ['wallet-1', 'Ready Wallet (formerly Argent)'],
      ['wallet-2', 'Xverse'],
    ]);
    session.destroy();
  });

  it('keeps MetaMask out when a later discovery notification brings it', () => {
    let listener!: (wallets: readonly WalletHandle[]) => void;
    const ready = wallet('Ready');
    const xverse = wallet('Xverse');
    const session = createWalletSession(OPTIONS, {
      discovery: {
        getWallets: () => [ready],
        subscribe(next) { listener = next; return () => undefined; },
        refresh: () => undefined,
      },
      connectWallet: refuseConnection,
    });

    listener([new MetaMaskLikeVirtualWallet() as unknown as WalletHandle, ready, xverse]);

    expect(session.getSnapshot().wallets.map(({ name }) => name)).toEqual(['Ready', 'Xverse']);
    session.destroy();
  });

  it('shows no wallet, so the install links show, when MetaMask is the only wallet', () => {
    const session = createWalletSession(OPTIONS, {
      discovery: discoveryWith(new MetaMaskLikeVirtualWallet()),
      connectWallet: refuseConnection,
    });

    expect(session.getSnapshot().wallets).toEqual([]);
    session.destroy();
  });
});

describe('production discovery builds no MetaMask adapter (D-108)', () => {
  let announce: (() => void) | null = null;

  beforeEach(() => {
    announce = () => {
      window.dispatchEvent(Object.assign(new Event('eip6963:announceProvider'), {
        detail: {
          info: { uuid: 'mm', name: 'MetaMask', icon: ICON, rdns: 'io.metamask' },
          provider: { isMetaMask: true, request: async () => null },
        },
      }));
    };
    window.addEventListener('eip6963:requestProvider', announce);
  });

  afterEach(() => {
    if (announce) window.removeEventListener('eip6963:requestProvider', announce);
    announce = null;
  });

  it('get-starknet would list an announced MetaMask by default', () => {
    expect(createStore().getWallets().map(({ name }) => name)).toEqual(['MetaMask']);
  });

  it('createWalletDiscovery lists nothing for the same announcement', () => {
    expect(createWalletDiscovery().getWallets()).toEqual([]);
  });
});

describe('a failing connect is attempted exactly once per click (D-108)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function unknownError(): Error {
    return Object.assign(new Error('UNKNOWN_ERROR'), { code: 163 });
  }

  it('does not retry after a 163, on rescans, discovery notifications or timers', async () => {
    let listener!: (wallets: readonly WalletHandle[]) => void;
    const ready = wallet('Ready');
    const xverse = wallet('Xverse');
    const connectWallet = vi.fn(async () => {
      throw unknownError();
    });
    const session = createWalletSession(OPTIONS, {
      discovery: {
        getWallets: () => [ready, xverse],
        subscribe(next) { listener = next; return () => undefined; },
        refresh: () => listener([ready, xverse]),
      },
      connectWallet,
    });
    const key = session.getSnapshot().wallets[1]!.key;

    await expect(session.connect(key)).rejects.toMatchObject({ kind: 'unknown' });
    expect(connectWallet).toHaveBeenCalledOnce();
    expect(session.getSnapshot().phase).toBe('failed');

    session.refreshDiscovery();
    listener([ready, xverse]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(connectWallet).toHaveBeenCalledOnce();

    await expect(session.connect(key)).rejects.toMatchObject({ kind: 'unknown' });
    expect(connectWallet).toHaveBeenCalledTimes(2);
    session.destroy();
  });

  it('asks a production Wallet Standard wallet to connect once per click when it fails', async () => {
    const standardConnect = vi.fn(async () => {
      throw unknownError();
    });
    const request = vi.fn(async () => {
      throw unknownError();
    });
    const failing = {
      version: '1.0.0',
      name: 'Some wallet',
      icon: ICON,
      chains: [`starknet:${MAINNET}`],
      accounts: [],
      features: {
        'standard:connect': { version: '1.0.0', connect: standardConnect },
        'standard:disconnect': { version: '1.0.0', disconnect: async () => undefined },
        'standard:events': { version: '1.0.0', on: () => () => undefined },
        'starknet:walletApi': { version: '1.0.0', walletVersion: '1.0.0', id: 'some', request },
      },
    };
    const session = createProductionWalletSession(OPTIONS, discoveryWith(failing));
    const key = session.getSnapshot().wallets[0]!.key;

    await expect(session.connect(key)).rejects.toMatchObject({ kind: 'unknown' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(standardConnect).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();

    await expect(session.connect(key)).rejects.toMatchObject({ kind: 'unknown' });
    expect(standardConnect).toHaveBeenCalledTimes(2);
    session.destroy();
  });
});
