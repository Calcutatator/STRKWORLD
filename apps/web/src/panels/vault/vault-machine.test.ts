import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEMO_VAULT_STAND_IN, FakePrivacyOperations, type FakeConfig, type PrivacyOperations, type VaultStage, type WalletRoutePolicy } from '@strkworld/privacy';
import { COPY } from '../../copy.js';
import { attachDebugTap, type DebugTap, type VaultDebugStep } from '../../debug/debug-tap.js';
import { PRIVACY_REGISTER } from '../../privacy/register.js';
import type { ShellFailure } from '../../privacy/errors.js';
import { createReceiptLedger } from '../../receipts/receipt-ledger.js';
import { createVaultPanel, vaultTokenChoices, voyagerContractUrl, type VaultTokenView } from './vault-machine.js';

/**
 * The Vault's counter machine (D-077, D-079), against the deterministic fake:
 * what the player reads, what reaches the seam, and what the probe log is
 * told.
 */

const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const ETH = '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7';
const USDC = '0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb';
const USDT = '0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8';
const WBTC = '0x03fe2b97c1fd336e750087d68b9b867997fd64a2661ff3ca5a7c771641e8e7ac';
const STRKBTC = '0x0787150e306e6eae6e3f79dea881770e8bbff2c1b8eb490f969669ee945b3135';
const ONE = 10n ** 18n;
const USDC_ONE = 10n ** 6n;
const POOL_FEE = 6n * ONE;

afterEach(() => {
  attachDebugTap(null);
});

function fake(options: {
  balance?: bigint;
  shares?: bigint;
  capability?: Record<string, unknown>;
  balances?: Record<string, bigint>;
  vault?: FakeConfig['vault'];
} = {}) {
  return new FakePrivacyOperations({
    balances: { [STRK]: options.balance ?? 100n * ONE, ...options.balances },
    poolConfig: { noteMaturityBlocks: 0 },
    ...(options.shares !== undefined || options.vault ? { vault: { shares: options.shares, ...options.vault } } : {}),
    ...(options.capability ? { capability: options.capability } : {}),
  });
}

function machine(
  operations: PrivacyOperations,
  overrides: { canStart?: () => boolean; tokens?: readonly VaultTokenView[] } = {},
) {
  const receipts = createReceiptLedger();
  const failures: ShellFailure[] = [];
  const panel = createVaultPanel({
    operations,
    receipts,
    canStartFinancialAction: overrides.canStart ?? (() => true),
    onError: (failure) => failures.push(failure),
    ...(overrides.tokens ? { tokens: overrides.tokens } : {}),
  });
  return { panel, receipts, failures };
}

function vaultPolicy(tokens: string[]): WalletRoutePolicy {
  return {
    maxIntents: 1,
    maxRelayFee: 0n,
    enabledRoutes: ['vault'],
    allowedTokens: { shield: [], unshield: [], transfer: [], swap: [], vault: tokens },
  };
}

function probe(): VaultDebugStep[] {
  const steps: VaultDebugStep[] = [];
  const tap: DebugTap = {
    failure: () => undefined,
    connectState: () => undefined,
    walletSession: () => undefined,
    visit: () => undefined,
    bank: () => undefined,
    sandboxBurst: () => undefined,
    gate: () => undefined,
    vault: (step) => steps.push(step as VaultDebugStep),
  };
  attachDebugTap(tap);
  return steps;
}

describe('the Vault counter (D-077)', () => {
  it('opens on a version query and Vesu’s rates alone: no position read, no wallet prompt', async () => {
    const operations = fake();
    const position = vi.spyOn(operations, 'vaultPositions');
    const rates = vi.spyOn(operations, 'vaultRates');
    const { panel } = machine(operations);
    await panel.open();
    const state = panel.store.getState();
    expect(state.capability).toEqual({ status: 'supported' });
    expect(state.position).toEqual({ status: 'unrequested' });
    expect(state.rates).toEqual({ status: 'loaded', rates: [] });
    expect(state.mode).toBe('supply');
    expect(state.door.open).toBe(true);
    expect(state.disclosure).toBe(PRIVACY_REGISTER.find((entry) => entry.route === 'vault.supply')!.disclosure);
    expect(position).not.toHaveBeenCalled();
    expect(rates).toHaveBeenCalledTimes(1);
  });

  it('offers every pinned token in demo, STRK first, with the catalog’s symbols and decimals (D-079)', async () => {
    const { panel } = machine(fake());
    await panel.open();
    const { tokens, token } = panel.store.getState();
    expect(tokens).toEqual([
      { token: STRK, symbol: 'STRK', decimals: 18 },
      { token: ETH, symbol: 'ETH', decimals: 18 },
      { token: USDC, symbol: 'USDC', decimals: 6 },
      { token: USDT, symbol: 'USDT', decimals: 6 },
      { token: WBTC, symbol: 'WBTC', decimals: 8 },
    ]);
    expect(token).toBe(STRK);
  });

  it('reads every offered token’s position and the stand-in address only when asked', async () => {
    const { panel } = machine(fake({ shares: 50n * ONE, vault: { markets: { [USDC]: { shares: 50n * USDC_ONE } } } }));
    await panel.open();
    await panel.refreshPosition();
    const { position } = panel.store.getState();
    expect(position).toMatchObject({ status: 'loaded', standIn: DEMO_VAULT_STAND_IN });
    if (position.status !== 'loaded') return;
    expect(position.positions).toEqual([
      { token: STRK, shares: 50n * ONE, assets: 51n * ONE, redeemable: 51n * ONE },
      { token: ETH, shares: 0n, assets: 0n, redeemable: 0n },
      // In USDC's own base units.
      { token: USDC, shares: 50n * USDC_ONE, assets: 51n * USDC_ONE, redeemable: 51n * USDC_ONE },
      { token: USDT, shares: 0n, assets: 0n, redeemable: 0n },
      { token: WBTC, shares: 0n, assets: 0n, redeemable: 0n },
    ]);
  });

  it('supplies: reviews the exact amount and the approved disclosure, then records the receipt', async () => {
    const operations = fake();
    const { panel, receipts } = machine(operations);
    await panel.open();
    panel.setAmount('5');
    await panel.prepare();
    const review = panel.store.getState().flow;
    expect(review.name).toBe('review');
    if (review.name !== 'review') return;
    expect(review.summary.action).toEqual({ kind: 'supply', token: STRK, amount: 5n * ONE });
    expect(review.summary.poolFee).toBe(POOL_FEE);
    expect(review.summary.disclosures).toEqual([
      PRIVACY_REGISTER.find((entry) => entry.route === 'vault.supply')!.disclosure,
    ]);
    expect(review.summary.requiresDisclosure).toBe(true);
    expect(operations.vaultSubmitted).toEqual([]);

    await panel.confirm();
    const done = panel.store.getState();
    expect(done.flow).toMatchObject({ name: 'submitted', outcome: 'succeeded' });
    expect(operations.vaultSubmitted).toEqual([{ kind: 'supply', token: STRK, amount: 5n * ONE }]);
    expect(receipts.pending('vault')).toHaveLength(1);
    expect(done.position).toEqual({ status: 'unrequested' });
    expect(done.notice).toEqual({ tone: 'info', text: COPY.vault.position.changed });

    panel.acknowledge();
    expect(receipts.pending('vault')).toEqual([]);
    expect(panel.store.getState().flow).toEqual({ name: 'composing' });
  });

  it('supplies another token in its own units, and reviews that token', async () => {
    const operations = fake({ balances: { [USDC]: 100n * USDC_ONE } });
    const { panel } = machine(operations);
    await panel.open();
    panel.setAmount('7');
    panel.setToken(USDC);
    // Choosing a token starts the amount again: a figure typed for one token is not the other's.
    expect(panel.store.getState()).toMatchObject({ token: USDC, amountText: '' });
    panel.setAmount('12.5');
    await panel.prepare();
    const review = panel.store.getState().flow;
    expect(review.name).toBe('review');
    if (review.name !== 'review') return;
    expect(review.summary.action).toEqual({ kind: 'supply', token: USDC, amount: 12_500_000n });
    expect(review.summary.token).toEqual({ token: USDC, symbol: 'USDC', decimals: 6 });
    // The pool fee is the pool's, in STRK.
    expect(review.summary.poolFee).toBe(POOL_FEE);
    await panel.confirm();
    expect(operations.vaultSubmitted).toEqual([{ kind: 'supply', token: USDC, amount: 12_500_000n }]);
  });

  it('reads an amount with the chosen token’s decimals, and refuses more places than it has', async () => {
    const operations = fake({ balances: { [WBTC]: 10n ** 8n } });
    const prepare = vi.spyOn(operations, 'prepareVaultSupply');
    const { panel } = machine(operations);
    await panel.open();
    panel.setToken(WBTC);
    panel.setAmount('0.000000001');
    await panel.prepare();
    expect(panel.store.getState().notice).toEqual({ tone: 'error', text: COPY.notices.badAmount });
    expect(prepare).not.toHaveBeenCalled();
    panel.setAmount('0.00000001');
    await panel.prepare();
    expect(prepare).toHaveBeenCalledWith(WBTC, 1n, expect.anything());
  });

  it('redeems the chosen token from its own position', async () => {
    const operations = fake({ balance: 20n * ONE, vault: { markets: { [USDC]: { shares: 50n * USDC_ONE } } } });
    const { panel } = machine(operations);
    await panel.open();
    panel.setMode('redeem');
    panel.setToken(USDC);
    panel.setRedeemAll(true);
    await panel.prepare();
    const flow = panel.store.getState().flow;
    expect(flow.name === 'review' && flow.summary.action).toEqual({ kind: 'redeem', token: USDC, amount: 51n * USDC_ONE, all: true });
    await panel.confirm();
    expect(operations.vaultSubmitted.at(-1)).toEqual({ kind: 'redeem', token: USDC, amount: 51n * USDC_ONE, all: true });
  });

  it('ignores a token it does not offer, and a change while the wallet works', async () => {
    const { panel } = machine(fake(), { tokens: [{ token: STRK, symbol: 'STRK', decimals: 18 }, { token: USDC, symbol: 'USDC', decimals: 6 }] });
    await panel.open();
    panel.setToken(STRKBTC);
    panel.setToken(WBTC);
    expect(panel.store.getState().token).toBe(STRK);
    panel.setToken(`0x${USDC.slice(3).toUpperCase()}`);
    expect(panel.store.getState().token).toBe(USDC);
  });

  it('shows Vesu’s rates for the offered tokens it has, and a failed read as unavailable, reporting nothing', async () => {
    const rated = fake({ vault: { rates: { [USDC]: { value: 30925508207480051n, decimals: 18 }, [WBTC]: { value: 3n, decimals: 3 } } } });
    const { panel } = machine(rated, { tokens: [{ token: STRK, symbol: 'STRK', decimals: 18 }, { token: USDC, symbol: 'USDC', decimals: 6 }] });
    await panel.open();
    expect(panel.store.getState().rates).toEqual({
      status: 'loaded',
      rates: [{ token: USDC, value: 30925508207480051n, decimals: 18 }],
    });

    const failing = fake();
    failing.injectFault({ kind: 'unreachable', on: 'vaultRates', sticky: true });
    const { panel: other, failures } = machine(failing);
    await other.open();
    expect(other.store.getState().rates).toEqual({ status: 'failed' });
    // The counter still works: a rate is information, not a gate.
    expect(other.store.getState().capability).toEqual({ status: 'supported' });
    expect(failures).toEqual([]);
  });

  it('reads the rates once a recheck finds the wallet able, and never for an open that was overtaken', async () => {
    const operations = fake();
    const rates = vi.spyOn(operations, 'vaultRates');
    vi.spyOn(operations, 'capability').mockRejectedValueOnce(Object.assign(new Error('socket'), { kind: 'unreachable' }));
    const { panel } = machine(operations);
    await panel.open();
    expect(panel.store.getState().capability).toMatchObject({ status: 'failed' });
    expect(rates).not.toHaveBeenCalled();
    await panel.recheck();
    expect(panel.store.getState()).toMatchObject({ capability: { status: 'supported' }, rates: { status: 'loaded' } });
    expect(rates).toHaveBeenCalledTimes(1);

    const again = fake();
    const reads = vi.spyOn(again, 'vaultRates');
    const { panel: other } = machine(again);
    const first = other.open();
    const second = other.open();
    await Promise.all([first, second]);
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it('reads the rates again beside the positions', async () => {
    const operations = fake();
    const rates = vi.spyOn(operations, 'vaultRates');
    const { panel } = machine(operations);
    await panel.open();
    await panel.refreshPosition();
    expect(rates).toHaveBeenCalledTimes(2);
  });

  it('never hands the stand-in address to the probe log or the connect flow', async () => {
    const steps = probe();
    const operations = fake({ shares: ONE });
    const { panel, failures } = machine(operations);
    await panel.open();
    await panel.refreshPosition();
    expect(panel.store.getState().position).toMatchObject({ standIn: DEMO_VAULT_STAND_IN });
    vi.spyOn(operations, 'vaultPositions').mockRejectedValueOnce(
      Object.assign(new Error(`refused for ${DEMO_VAULT_STAND_IN}`), { kind: 'unknown' }),
    );
    await panel.refreshPosition();
    expect(JSON.stringify(steps)).not.toContain('de70');
    expect(failures).toEqual([{ kind: 'unknown', cause: null }]);
  });

  it('builds a Voyager link for a contract address only', () => {
    // The nonce-0 address the anonymizer derives for test commitment 0x5f2e1d (D-077's fixture).
    expect(voyagerContractUrl('0x24915cb456ef2876c9611af4f021747f8d9761ff2d7bc716722ce4527091ac9')).toBe(
      'https://voyager.online/contract/0x024915cb456ef2876c9611af4f021747f8d9761ff2d7bc716722ce4527091ac9',
    );
    for (const bad of ['', '0x0', 'shadow', `0x${(1n << 251n).toString(16)}`, `0x${'1'.repeat(65)}`]) {
      expect(voyagerContractUrl(bad), bad).toBeNull();
    }
  });

  it('redeems everything by the vault’s preview, without an amount', async () => {
    const operations = fake({ balance: 20n * ONE, shares: 50n * ONE });
    const { panel } = machine(operations);
    await panel.open();
    panel.setMode('redeem');
    expect(panel.store.getState().disclosure).toBe(PRIVACY_REGISTER.find((entry) => entry.route === 'vault.redeem')!.disclosure);
    panel.setRedeemAll(true);
    await panel.prepare();
    const flow = panel.store.getState().flow;
    expect(flow.name === 'review' && flow.summary.action).toEqual({ kind: 'redeem', token: STRK, amount: 51n * ONE, all: true });
    await panel.confirm();
    expect(operations.vaultSubmitted.at(-1)).toEqual({ kind: 'redeem', token: STRK, amount: 51n * ONE, all: true });
  });

  it('refuses a malformed amount before the seam', async () => {
    const operations = fake();
    const prepare = vi.spyOn(operations, 'prepareVaultSupply');
    const { panel } = machine(operations);
    await panel.open();
    for (const text of ['', '0', 'abc', '1.0000000000000000001']) {
      panel.setAmount(text);
      await panel.prepare();
      expect(panel.store.getState().notice).toEqual({ tone: 'error', text: COPY.notices.badAmount });
    }
    expect(prepare).not.toHaveBeenCalled();
  });

  it('says plainly that the wallet cannot run a shadow account yet, and offers no form', async () => {
    const operations = fake({ capability: { supportsShadowAccounts: false, walletApiVersion: '0.10.3' } });
    const prepare = vi.spyOn(operations, 'prepareVaultSupply');
    const steps = probe();
    const { panel, failures } = machine(operations);
    await panel.open();
    expect(panel.store.getState().capability).toEqual({ status: 'unsupported' });
    panel.setAmount('1');
    await panel.prepare();
    expect(prepare).not.toHaveBeenCalled();
    expect(failures).toEqual([]);
    expect(steps).toEqual([{ step: 'capability', supported: false, walletApi: '0.10.3' }]);
  });

  it('turns a wallet that refuses the commitment as unsupported into the same message, kept in the Vault', async () => {
    const operations = fake();
    vi.spyOn(operations, 'vaultPositions').mockRejectedValue(
      Object.assign(new Error('This wallet does not support STRK20 shadow accounts yet.'), { kind: 'shadow-accounts-unsupported' }),
    );
    const { panel, failures } = machine(operations);
    await panel.open();
    await panel.refreshPosition();
    const state = panel.store.getState();
    expect(state.capability).toEqual({ status: 'unsupported' });
    expect(state.position).toMatchObject({ status: 'failed', message: COPY.errors['shadow-accounts-unsupported'] });
    // Handed on by kind alone: nothing a wallet wrote travels with it.
    expect(failures).toEqual([{ kind: 'shadow-accounts-unsupported', cause: null }]);
  });

  it('hands a 118 to the connect flow by kind, and shows the account message', async () => {
    const operations = fake({ capability: { registration: 'unregistered' } });
    const { panel, failures } = machine(operations);
    await panel.open();
    await panel.refreshPosition();
    expect(panel.store.getState().position).toMatchObject({ status: 'failed', kind: 'not-registered', message: COPY.errors['not-registered'] });
    expect(failures).toEqual([{ kind: 'not-registered', cause: null }]);
  });

  it('refuses to sign when the pool fee moved above the prepared total', async () => {
    const operations = fake();
    const { panel } = machine(operations);
    await panel.open();
    panel.setAmount('1');
    await panel.prepare();
    vi.spyOn(operations, 'poolConfig').mockResolvedValue({
      feeAmount: POOL_FEE + 1n,
      feeToken: STRK,
      proofValidityBlocks: 450,
      noteMaturityBlocks: 0,
    });
    await panel.confirm();
    expect(panel.store.getState().flow).toMatchObject({ name: 'failed', message: COPY.notices.feeMoved, recovery: 'prepare-again' });
    expect(operations.vaultSubmitted).toEqual([]);
  });

  it('holds new work while the D-035 gate is closed', async () => {
    let open = true;
    const operations = fake();
    const { panel } = machine(operations, { canStart: () => open });
    await panel.open();
    panel.setAmount('1');
    open = false;
    await panel.prepare();
    expect(panel.store.getState().notice).toEqual({ tone: 'error', text: COPY.errors['submission-uncertain'] });
    open = true;
    await panel.prepare();
    open = false;
    await panel.confirm();
    expect(panel.store.getState().flow.name).toBe('review');
    expect(operations.vaultSubmitted).toEqual([]);
  });

  it('keeps a declined confirm recoverable, and a second confirm never starts', async () => {
    const operations = fake();
    operations.injectFault({ kind: 'user-rejected', on: 'vaultConfirm' });
    const { panel, failures } = machine(operations);
    await panel.open();
    panel.setAmount('1');
    await panel.prepare();
    const first = panel.confirm();
    const second = panel.confirm();
    await Promise.all([first, second]);
    expect(panel.store.getState().flow).toMatchObject({ name: 'failed', kind: 'user-rejected', recovery: 'prepare-again' });
    expect(failures).toEqual([{ kind: 'user-rejected', cause: null }]);
    panel.cancelPrepared();
    expect(panel.store.getState().flow).toEqual({ name: 'composing' });
  });

  it('shows a receipt that arrived while the window was shut when it reopens', async () => {
    const operations = fake();
    const { panel, receipts } = machine(operations);
    await panel.open();
    panel.setAmount('1');
    await panel.prepare();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const flow = panel.store.getState().flow;
    if (flow.name !== 'review') throw new Error('expected a review');
    // Close mid-confirm: the fake answers only once released.
    vi.spyOn(operations, 'poolConfig').mockImplementationOnce(async () => {
      await held;
      return { feeAmount: POOL_FEE, feeToken: STRK, proofValidityBlocks: 450, noteMaturityBlocks: 0 };
    });
    const confirming = panel.confirm();
    panel.close();
    release();
    await confirming;
    // Closed before the wallet was asked: nothing was sent, nothing recorded.
    expect(receipts.pending('vault')).toEqual([]);
    receipts.record({ building: 'vault', transactionHash: '0x5eed', intents: [] });
    await panel.open();
    expect(panel.store.getState().flow).toEqual({ name: 'submitted', transactionHash: '0x5eed', outcome: 'pending', restored: true });
  });

  it('tells the probe log codes and stage names only', async () => {
    const steps = probe();
    const { panel } = machine(fake({ shares: 50n * ONE }));
    await panel.open();
    await panel.refreshPosition();
    panel.setAmount('5');
    await panel.prepare();
    await panel.confirm();
    const seam = (stage: VaultStage) => ({ step: 'stage', stage });
    expect(steps).toEqual([
      { step: 'capability', supported: true, walletApi: '0.10.4' },
      seam({ stage: 'capability', supported: true }),
      seam({ stage: 'commitment', ok: true }),
      seam({ stage: 'address', resolved: true, deployed: true }),
      seam({ stage: 'position', ok: true }),
      { step: 'prepare', kind: 'supply', all: false },
      seam({ stage: 'capability', supported: true }),
      seam({ stage: 'address', resolved: true, deployed: true }),
      { step: 'confirm', kind: 'supply', stage: 'composing' },
      { step: 'confirm', kind: 'supply', stage: 'awaiting-approval' },
      seam({ stage: 'submit', ok: true }),
      { step: 'confirm', kind: 'supply', stage: 'confirming' },
      seam({ stage: 'receipt', status: 'succeeded' }),
      { step: 'confirm', kind: 'supply', stage: 'done' },
      { step: 'confirm', kind: 'supply', stage: 'submitted' },
    ]);
    const text = JSON.stringify(steps);
    expect(text).not.toMatch(/0x[0-9a-f]{6,}/i);
    expect(text).not.toMatch(/\d{6,}/);
  });

  it('offers the build’s Vault list, in its order, and nothing unpinned or undescribed', () => {
    expect(vaultTokenChoices(vaultPolicy([USDC, STRK])).map((entry) => entry.symbol)).toEqual(['USDC', 'STRK']);
    // strkBTC is in the catalog but has no pinned vault; a repeat is offered once.
    expect(vaultTokenChoices(vaultPolicy([STRKBTC, WBTC, `0x${WBTC.slice(3)}`])).map((entry) => entry.symbol)).toEqual(['WBTC']);
    expect(vaultTokenChoices({ ...vaultPolicy([]), allowedTokens: { shield: [], unshield: [], transfer: [], swap: [] } })).toEqual([]);
    expect(vaultTokenChoices(null).map((entry) => entry.symbol)).toEqual(['STRK', 'ETH', 'USDC', 'USDT', 'WBTC']);
  });

  it('locks every control when the build policy leaves the Vault off', async () => {
    const operations = fake();
    const denyAll = {
      maxIntents: 0,
      maxRelayFee: 0n,
      enabledRoutes: [] as const,
      allowedTokens: { shield: [], unshield: [], transfer: [], swap: [] },
    };
    vi.resetModules();
    vi.doMock('../../production/config.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../production/config.js')>()),
      detectRoutePolicy: () => denyAll,
    }));
    try {
      const { createVaultPanel: create } = await import('./vault-machine.js');
      const { COPY: copy } = await import('../../copy.js');
      const panel = create({ operations, receipts: createReceiptLedger(), canStartFinancialAction: () => true });
      await panel.open();
      expect(panel.store.getState().door).toMatchObject({ open: false, reason: 'not-enabled', message: copy.locked.notEnabled.vault });
      panel.setMode('redeem');
      expect(panel.store.getState().door).toMatchObject({ open: false, reason: 'not-enabled' });
      panel.setAmount('1');
      const prepare = vi.spyOn(operations, 'prepareVaultRedeem');
      await panel.prepare();
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('../../production/config.js');
      vi.resetModules();
    }
  });
});
