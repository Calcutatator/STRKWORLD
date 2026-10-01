import { describe, expect, it } from 'vitest';
import { REQUIRED_WALLET_API_VERSION, type WalletSessionSnapshot } from '@strkworld/privacy';
import {
  REQUIRED_WALLET_API_LABEL,
  selectedWalletName,
  unsupportedCopy,
  unsupportedRoomCopy,
} from './unsupported-copy.js';

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

describe('unsupportedRoomCopy', () => {
  it('names the version the adapter actually requires', () => {
    expect(REQUIRED_WALLET_API_LABEL).toBe(REQUIRED_WALLET_API_VERSION);
  });

  it('says plainly that a too-old Wallet API is too old, naming both versions', () => {
    expect(unsupportedRoomCopy('Xverse', { walletApiVersion: '0.10.2', versionTooOld: true })).toEqual({
      title: "Xverse can't open the privacy pool yet",
      body: 'Xverse is connected, but it reports Wallet API 0.10.2 and STRKWORLD needs 0.10.3 or later, so the city stays closed. Your funds are fine. Update Xverse and check again, or connect a wallet that supports STRK20 private balances.',
      detail: null,
    });
    expect(unsupportedRoomCopy(null, { walletApiVersion: '0.9.0', versionTooOld: true }).body)
      .toMatch(/^Your wallet is connected, but it reports Wallet API 0\.9\.0 .* Update your wallet and check again,/);
  });

  it('keeps the no-STRK20 body for a wallet without the method, with no version line', () => {
    expect(unsupportedRoomCopy('Xverse', { walletApiVersion: null })).toEqual({
      ...unsupportedCopy('Xverse'),
      detail: null,
    });
  });

  it('keeps the version line for a 162 met after the city admitted the version', () => {
    expect(unsupportedRoomCopy('Ready', { walletApiVersion: '0.10.4' })).toEqual({
      ...unsupportedCopy('Ready'),
      detail: 'Wallet API 0.10.4',
    });
  });

  it('inserts a version as it stands, expanding nothing inside it', () => {
    const copy = unsupportedRoomCopy('{version}', { walletApiVersion: '$&{wallet}', versionTooOld: true });
    expect(copy.title).toBe("{version} can't open the privacy pool yet");
    expect(copy.body).toMatch(/^\{version\} is connected, but it reports Wallet API \$&\{wallet\} and /);
  });
});
