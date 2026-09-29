/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createProductionWalletSession,
  createWalletSession,
  type WalletDiscoveryPort,
  type WalletHandle,
  type WalletSession,
} from './session.js';

/**
 * D-073. The discovery store scans legacy `window.starknet*` globals once, as
 * it is built, so the session looks again on a short schedule. A look adds a
 * wallet to the list and does nothing else: no selection, no connection, no
 * duplicate, and no wallet already listed changes place.
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

const injectedKeys: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const key of injectedKeys.splice(0)) Reflect.deleteProperty(window, key);
  vi.useRealTimers();
});

describe('WalletSession looks again for late wallets (D-073)', () => {
  it('looks again 250 ms, 1 s, 2.5 s and 5 s after it starts, then stops', () => {
    const start = Date.now();
    const looks: number[] = [];
    const session = createWalletSession(OPTIONS, {
      discovery: portWith(() => looks.push(Date.now() - start)),
      connectWallet: refuseConnection,
    });

    expect(looks).toEqual([]);
    vi.advanceTimersByTime(60_000);

    expect(looks).toEqual([250, 1_000, 2_500, 5_000]);
    expect(vi.getTimerCount()).toBe(0);
    session.destroy();
  });

  it('stops looking when the session is destroyed', () => {
    const refresh = vi.fn();
    const session = createWalletSession(OPTIONS, { discovery: portWith(refresh), connectWallet: refuseConnection });

    vi.advanceTimersByTime(300);
    expect(refresh).toHaveBeenCalledOnce();
    session.destroy();

    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    session.refreshDiscovery();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('keeps looking after a look throws, and never lets the throw escape', () => {
    const refresh = vi.fn(() => {
      throw new Error('a hostile page global');
    });
    const session = createWalletSession(OPTIONS, { discovery: portWith(refresh), connectWallet: refuseConnection });

    expect(() => vi.advanceTimersByTime(60_000)).not.toThrow();
    expect(refresh).toHaveBeenCalledTimes(4);
    expect(() => session.refreshDiscovery()).not.toThrow();
    expect(refresh).toHaveBeenCalledTimes(5);
    session.destroy();
  });

  it('keeps every listed wallet in place and adds a new one at the end', () => {
    const first = wallet('First');
    const second = wallet('Second');
    const late = wallet('Late');
    const later = wallet('Later');
    const discovery = controllableDiscovery(first, second);
    const session = createWalletSession(OPTIONS, { discovery: discovery.port, connectWallet: refuseConnection });
    const listed = session.getSnapshot().wallets;

    // The discovery store puts its newest wallet first.
    discovery.replace(late, first, second);
    expect(names(session)).toEqual(['First', 'Second', 'Late']);
    expect(session.getSnapshot().wallets.slice(0, 2)).toEqual(listed);

    discovery.replace(later, late, first, second);
    expect(names(session)).toEqual(['First', 'Second', 'Late', 'Later']);

    // A wallet that leaves closes its gap; the others keep their order.
    discovery.replace(later, first);
    expect(names(session)).toEqual(['First', 'Later']);
    expect(session.getSnapshot()).toMatchObject({ phase: 'selection-required', selectedKey: null, account: null });
    session.destroy();
  });

  it('lists a late window.starknet_xverse without a click, after the wallets already listed, and connects nothing', () => {
    expect(Object.getOwnPropertyNames(window).filter((key) => key.startsWith('starknet'))).toEqual([]);
    const ready = inject('starknet_ready', injectedWallet('ready', 'Ready'));
    const session = createProductionWalletSession(OPTIONS);
    expect(names(session)).toEqual(['Ready']);
    const listener = vi.fn();
    session.subscribe(listener);

    const xverse = inject('starknet_xverse', injectedWallet('xverse', 'Xverse'));
    expect(names(session)).toEqual(['Ready']);
    vi.advanceTimersByTime(250);

    // The store alone would now list Xverse first.
    expect(names(session)).toEqual(['Ready', 'Xverse']);
    expect(listener).toHaveBeenCalled();
    expect(session.getSnapshot()).toMatchObject({ phase: 'selection-required', selectedKey: null, account: null });

    // Every later look, scheduled or pressed, finds the same two wallets.
    const keys = session.getSnapshot().wallets.map((choice) => choice.key);
    vi.advanceTimersByTime(60_000);
    session.refreshDiscovery();
    session.refreshDiscovery();
    expect(session.getSnapshot().wallets.map((choice) => choice.key)).toEqual(keys);
    expect(names(session)).toEqual(['Ready', 'Xverse']);

    // Nothing asked either wallet for anything: no account request, no connection.
    expect(ready.request).not.toHaveBeenCalled();
    expect(xverse.request).not.toHaveBeenCalled();
    expect(session.getSnapshot()).toMatchObject({ phase: 'selection-required', selectedKey: null, account: null });
    session.destroy();
  });

  it('never selects a late wallet even when it is the only one', () => {
    const session = createProductionWalletSession(OPTIONS);
    expect(names(session)).toEqual([]);

    const xverse = inject('starknet_xverse', injectedWallet('xverse', 'Xverse'));
    vi.advanceTimersByTime(1_000);

    expect(names(session)).toEqual(['Xverse']);
    expect(session.getSnapshot()).toMatchObject({ phase: 'selection-required', selectedKey: null, account: null });
    expect(xverse.request).not.toHaveBeenCalled();
    session.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });
});

function names(session: WalletSession): string[] {
  return session.getSnapshot().wallets.map((choice) => choice.name);
}

function wallet(label: string): WalletHandle {
  return { name: label, icon: `data:image/svg+xml,${label}` };
}

function portWith(refresh: () => void): WalletDiscoveryPort {
  return {
    getWallets: () => [wallet('Ready')],
    subscribe: () => () => undefined,
    refresh,
  };
}

function controllableDiscovery(...initialWallets: WalletHandle[]) {
  let wallets = initialWallets;
  const listeners = new Set<(wallets: readonly WalletHandle[]) => void>();
  const port: WalletDiscoveryPort = {
    getWallets: () => wallets,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh: () => undefined,
  };
  return {
    port,
    replace(...next: WalletHandle[]) {
      wallets = next;
      listeners.forEach((listener) => listener(wallets));
    },
  };
}

async function refuseConnection(): Promise<never> {
  throw new Error('a look must never connect a wallet');
}

/** A legacy injected wallet object, as an extension puts on `window.starknet_*`. */
function injectedWallet(id: string, label: string) {
  return {
    id,
    name: label,
    version: '1.0.0',
    icon: `data:image/svg+xml,${id}`,
    request: vi.fn(async () => {
      throw new Error('no wallet request expected');
    }),
    on: vi.fn(),
    off: vi.fn(),
  };
}

function inject<T>(key: string, value: T): T {
  Object.defineProperty(window, key, { configurable: true, enumerable: true, writable: true, value });
  injectedKeys.push(key);
  return value;
}
