// @vitest-environment jsdom
import { Children, isValidElement, type ReactElement, type ReactNode, act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import type { WalletSessionSnapshot } from '@strkworld/privacy';

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
