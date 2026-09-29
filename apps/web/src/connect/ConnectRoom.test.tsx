// @vitest-environment jsdom
import { Children, isValidElement, type ReactElement, type ReactNode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { WalletSessionSnapshot } from '@strkworld/privacy';
import type { ConnectFlow, ConnectState } from './connect-machine.js';

const harness = vi.hoisted(() => ({
  privacy: null as { connect: { connect: () => Promise<unknown> }; connectState: { name: 'disconnected' } } | null,
  wallet: null as {
    snapshot: WalletSessionSnapshot;
    connect: (key: string) => Promise<void>;
    refreshDiscovery: () => void;
  } | null,
}));

vi.mock('../privacy/PrivacyProvider.js', () => ({
  usePrivacy: () => harness.privacy,
}));
vi.mock('../wallet/WalletSessionProvider.js', () => ({
  useWalletSessionOptional: () => harness.wallet,
}));

import { ConnectRoom, ConnectRoomView } from './ConnectRoom.js';

describe('ConnectRoomView', () => {
  it('retains the ConnectFlow receiver after wallet selection', async () => {
    let detectCalls = 0;
    let connect!: Pick<ConnectFlow, 'connect' | 'recheck'>;
    const connectedState: ConnectState = {
      name: 'connected',
      capability: { supportsStrk20: true, walletApiVersion: '0.10.3', registration: 'unknown' },
      registrationConfirmed: false,
    };
    connect = {
      connect(this: unknown) {
        if (this !== connect) throw new Error('ConnectFlow receiver lost');
        detectCalls += 1;
        return Promise.resolve(connectedState);
      },
      recheck: async () => connectedState,
    };
    const snapshot: WalletSessionSnapshot = {
      phase: 'selection-required',
      wallets: [{ key: 'wallet-1', name: 'Ready', icon: 'data:image/svg+xml,ready' }],
      selectedKey: null,
      account: null,
      generation: 0,
    };
    const view = ConnectRoomView({
      connect,
      connectState: { name: 'disconnected' },
      wallet: { snapshot, connect: async () => undefined, refreshDiscovery: vi.fn() },
    });

    await findButton(view, 'Ready').props.onClick?.();

    expect(detectCalls).toBe(1);
  });

  it('connects only the wallet choice the player explicitly selects', async () => {
    const connectWallet = vi.fn(async () => undefined);
    const detectCapability = vi.fn(async () => ({
      name: 'connected' as const,
      capability: { supportsStrk20: true, walletApiVersion: '0.10.3', registration: 'unknown' as const },
      registrationConfirmed: false,
    }));
    const snapshot: WalletSessionSnapshot = {
      phase: 'selection-required',
      wallets: [
        { key: 'wallet-1', name: 'First wallet', icon: 'data:image/svg+xml,first' },
        { key: 'wallet-2', name: 'Ready', icon: 'data:image/svg+xml,ready' },
      ],
      selectedKey: null,
      account: null,
      generation: 0,
    };
    const view = ConnectRoomView({
      connectState: { name: 'disconnected' },
      connect: { connect: detectCapability, recheck: detectCapability },
      wallet: { snapshot, connect: connectWallet, refreshDiscovery: vi.fn() },
    });

    await findButton(view, 'Ready').props.onClick?.();

    expect(connectWallet).toHaveBeenCalledOnce();
    expect(connectWallet).toHaveBeenCalledWith('wallet-2');
    expect(detectCapability).toHaveBeenCalledOnce();
  });

  it('does not detect capability after the room unmounts during wallet connection', async () => {
    let resolveConnection!: () => void;
    const connection = new Promise<void>((resolve) => { resolveConnection = resolve; });
    const detectCapability = vi.fn(async () => ({ name: 'connected' as const }));
    harness.privacy = {
      connect: { connect: detectCapability },
      connectState: { name: 'disconnected' },
    };
    harness.wallet = {
      snapshot: {
        phase: 'selection-required',
        wallets: [{ key: 'wallet-1', name: 'Ready', icon: 'data:image/svg+xml,ready' }],
        selectedKey: null,
        account: null,
        generation: 0,
      },
      connect: vi.fn(() => connection),
      refreshDiscovery: vi.fn(),
    };
    const container = document.createElement('div');
    const root = createRoot(container);

    await act(async () => {
      root.render(<ConnectRoom />);
      await Promise.resolve();
    });
    const button = container.querySelector('button');
    expect(button).not.toBeNull();

    await act(async () => { button!.click(); });
    await act(async () => { root.unmount(); });
    expect(harness.wallet.connect).toHaveBeenCalledOnce();
    resolveConnection();
    await connection;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(detectCapability).not.toHaveBeenCalled();
  });
});

function findButton(node: ReactNode, label: string): ReactElement<{
  children?: ReactNode;
  onClick?: () => void | Promise<void>;
}> {
  let found: ReactElement<{ children?: ReactNode; onClick?: () => void | Promise<void> }> | null = null;
  const visit = (current: ReactNode): void => {
    if (found || !isValidElement<{ children?: ReactNode; onClick?: () => void | Promise<void> }>(current)) return;
    if (current.type === 'button' && current.props.children === label) {
      found = current;
      return;
    }
    Children.forEach(current.props.children, visit);
  };
  visit(node);
  if (!found) throw new Error(`Button not found: ${label}`);
  return found;
}

describe('the choose-a-wallet card (D-073)', () => {
  const ICON = 'data:image/svg+xml,wallet';
  const choosing = (wallets: WalletSessionSnapshot['wallets']): WalletSessionSnapshot => ({
    phase: 'selection-required',
    wallets,
    selectedKey: null,
    account: null,
    generation: 0,
  });

  async function renderView(wallets: WalletSessionSnapshot['wallets']) {
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      root.render(ConnectRoomView({
        connect: { connect: vi.fn(), recheck: vi.fn() } as unknown as Pick<ConnectFlow, 'connect' | 'recheck'>,
        connectState: { name: 'disconnected' },
        wallet: { snapshot: choosing(wallets), connect: vi.fn(async () => undefined), refreshDiscovery: vi.fn() },
      }));
    });
    return { container, unmount: () => act(async () => { root.unmount(); }) };
  }

  it('offers install links only while no wallet is discovered', async () => {
    const none = await renderView([]);
    expect(none.container.querySelector('[data-testid="get-a-wallet"]')?.textContent)
      .toBe('Get a wallet: Ready · Xverse');
    expect([...none.container.querySelectorAll('a')].map((link) => [
      link.textContent,
      link.getAttribute('href'),
      link.getAttribute('target'),
      link.getAttribute('rel'),
    ])).toEqual([
      ['Ready', 'https://www.ready.co', '_blank', 'noopener noreferrer'],
      ['Xverse', 'https://www.xverse.app', '_blank', 'noopener noreferrer'],
    ]);
    await none.unmount();

    const some = await renderView([{ key: 'wallet-1', name: 'Xverse', icon: ICON }]);
    expect(some.container.querySelector('[data-testid="get-a-wallet"]')).toBeNull();
    expect(some.container.querySelector('a')).toBeNull();
    expect([...some.container.querySelectorAll('button')].map((button) => button.textContent))
      .toEqual(['Xverse', 'Look again']);
    await some.unmount();
  });

  it('looks again when it mounts and when the page becomes visible, and connects nothing', async () => {
    const refreshDiscovery = vi.fn();
    const connectWallet = vi.fn(async () => undefined);
    const detect = vi.fn(async () => ({ name: 'disconnected' as const }));
    harness.privacy = { connect: { connect: detect }, connectState: { name: 'disconnected' } };
    harness.wallet = { snapshot: choosing([]), connect: connectWallet, refreshDiscovery };
    let visibility: DocumentVisibilityState = 'visible';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(<ConnectRoom />);
      });
      expect(refreshDiscovery).toHaveBeenCalledOnce();

      visibility = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
      expect(refreshDiscovery).toHaveBeenCalledOnce();
      visibility = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
      expect(refreshDiscovery).toHaveBeenCalledTimes(2);

      await act(async () => { root.unmount(); });
      document.dispatchEvent(new Event('visibilitychange'));
      expect(refreshDiscovery).toHaveBeenCalledTimes(2);
      expect(connectWallet).not.toHaveBeenCalled();
      expect(detect).not.toHaveBeenCalled();
    } finally {
      Reflect.deleteProperty(document, 'visibilityState');
    }
  });
});

describe('the unsupported-wallet room (D-073)', () => {
  async function renderRoom(wallet: Parameters<typeof ConnectRoomView>[0]['wallet']) {
    const recheck = vi.fn(async () => ({ name: 'unsupported-wallet' as const, walletApiVersion: '0.9.0' }));
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      root.render(ConnectRoomView({
        connect: { connect: vi.fn(), recheck } as unknown as Pick<ConnectFlow, 'connect' | 'recheck'>,
        connectState: { name: 'unsupported-wallet', walletApiVersion: '0.9.0' },
        wallet,
      }));
    });
    return { container, recheck, unmount: () => act(async () => { root.unmount(); }) };
  }

  it('names the connected wallet, says the city stays closed, and keeps the recheck', async () => {
    const { COPY } = await import('../copy.js');
    const { container, recheck, unmount } = await renderRoom({
      snapshot: {
        phase: 'connected',
        wallets: [
          { key: 'wallet-1', name: 'Ready', icon: 'data:image/svg+xml,ready' },
          { key: 'wallet-2', name: 'Xverse', icon: 'data:image/svg+xml,xverse' },
        ],
        selectedKey: 'wallet-2',
        account: '0xabc',
        generation: 1,
      },
      connect: vi.fn(async () => undefined),
      refreshDiscovery: vi.fn(),
    });

    const room = container.querySelector('.room-unsupported')!;
    expect(room.querySelector('h2')?.textContent).toBe("Xverse can't open the privacy pool yet");
    expect(room.querySelector('p')?.textContent).toBe(
      "Xverse is connected but doesn't yet offer the STRK20 privacy methods STRKWORLD needs, so the city stays closed. Your funds are fine. Connect a wallet that supports STRK20 private balances, or check again once Xverse adds them.",
    );
    expect(room.querySelector('.room-detail')?.textContent).toBe('Wallet API 0.9.0');
    const button = room.querySelector('button')!;
    expect(button.textContent).toBe(COPY.unsupported.action);
    await act(async () => { button.click(); });
    expect(recheck).toHaveBeenCalledOnce();
    await unmount();
  });

  it('says "Your wallet" when the shell has no name for the wallet', async () => {
    const { container, unmount } = await renderRoom(null);

    const room = container.querySelector('.room-unsupported')!;
    expect(room.querySelector('h2')?.textContent).toBe("Your wallet can't open the privacy pool yet");
    expect(room.querySelector('p')?.textContent).toMatch(/^Your wallet is connected but doesn't yet offer /);
    expect(room.querySelector('p')?.textContent).toMatch(/, or check again once your wallet adds them\.$/);
    await unmount();
  });
});

describe('the not-registered room, folded into the entry gate (D-072)', () => {
  it('renders the gate\'s not-registered card inside a building, with the connect flow\'s recheck', async () => {
    const { COPY } = await import('../copy.js');
    const recheck = vi.fn(async () => ({ name: 'not-registered' as const }));
    const view = ConnectRoomView({
      connect: { connect: vi.fn(), recheck } as unknown as Pick<ConnectFlow, 'connect' | 'recheck'>,
      connectState: { name: 'not-registered' },
      wallet: null,
    });
    const container = document.createElement('div');
    const root = createRoot(container);
    await act(async () => {
      root.render(view);
    });

    const card = container.querySelector('[data-testid="not-registered"]')!;
    expect(card.classList.contains('room')).toBe(true);
    expect(card.querySelector('h2')?.textContent).toBe(COPY.notRegistered.title);
    expect(card.textContent).toContain(COPY.notRegistered.body);
    expect(card.querySelector('.room-detail')?.textContent).toBe(COPY.notRegistered.hint);
    const button = card.querySelector('button')!;
    expect(button.textContent).toBe(COPY.notRegistered.action);
    await act(async () => { button.click(); });
    expect(recheck).toHaveBeenCalledOnce();
    await act(async () => { root.unmount(); });
  });
});
