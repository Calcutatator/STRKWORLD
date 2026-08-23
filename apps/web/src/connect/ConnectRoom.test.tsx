import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { WalletSessionSnapshot } from '@strkworld/privacy';
import { ConnectRoomView } from './ConnectRoom.js';

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
