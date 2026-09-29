import { describe, expect, it } from 'vitest';
import type { WalletSessionSnapshot } from '@strkworld/privacy';
import { selectedWalletName, unsupportedCopy } from './unsupported-copy.js';

const WALLETS: WalletSessionSnapshot['wallets'] = [
  { key: 'wallet-1', name: 'Ready', icon: 'data:image/svg+xml,ready' },
  { key: 'wallet-2', name: '  Xverse  ', icon: 'data:image/svg+xml,xverse' },
  { key: 'wallet-3', name: '   ', icon: 'data:image/svg+xml,blank' },
];

describe('selectedWalletName (D-073)', () => {
  it('reads the selected choice by the session key, trimmed', () => {
    expect(selectedWalletName({ wallets: WALLETS, selectedKey: 'wallet-1' })).toBe('Ready');
    expect(selectedWalletName({ wallets: WALLETS, selectedKey: 'wallet-2' })).toBe('Xverse');
  });

  it('is null with no snapshot, no selection, a key no longer listed or a blank name', () => {
    expect(selectedWalletName(null)).toBeNull();
    expect(selectedWalletName(undefined)).toBeNull();
    expect(selectedWalletName({ wallets: WALLETS, selectedKey: null })).toBeNull();
    expect(selectedWalletName({ wallets: WALLETS, selectedKey: 'wallet-9' })).toBeNull();
    expect(selectedWalletName({ wallets: WALLETS, selectedKey: 'wallet-3' })).toBeNull();
  });
});

describe('unsupportedCopy (D-073)', () => {
  it('inserts a wallet name as it stands, expanding nothing inside it', () => {
    const copy = unsupportedCopy('$& {wallet} {Wallet}');
    expect(copy.title).toBe("$& {wallet} {Wallet} can't open the privacy pool yet");
    expect(copy.body).toMatch(/^\$& \{wallet\} \{Wallet\} is connected /);
    expect(copy.body).toMatch(/ once \$& \{wallet\} \{Wallet\} adds them\.$/);
  });

  it('treats a blank name as no name', () => {
    expect(unsupportedCopy('   ')).toEqual(unsupportedCopy(null));
    expect(unsupportedCopy(' Xverse ')).toEqual(unsupportedCopy('Xverse'));
  });
});
