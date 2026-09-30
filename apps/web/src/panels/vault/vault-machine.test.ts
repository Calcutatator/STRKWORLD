import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEMO_VAULT_STAND_IN, FakePrivacyOperations, type FakeConfig, type PrivacyOperations, type VaultStage, type WalletRoutePolicy } from '@strkworld/privacy';
import { COPY } from '../../copy.js';
import { attachDebugTap, type DebugTap, type VaultDebugStep } from '../../debug/debug-tap.js';
import { PRIVACY_REGISTER } from '../../privacy/register.js';
import type { ShellFailure } from '../../privacy/errors.js';
import { createReceiptLedger } from '../../receipts/receipt-ledger.js';
import { VAULT_MARKET_METADATA } from '../../production/vesu-markets.js';
import {
  createVaultPanel,
  noneInPoolLine,
  vaultChoices,
  vaultListedMarkets,
  vaultTokenChoices,
  voyagerContractUrl,
  type VaultTokenView,
} from './vault-machine.js';

/**
 * The Vault's counter machine (D-077, D-079, D-081), against the
 * deterministic fake: what the player reads, what reaches the seam, and what
 * the probe log is told.
 */

const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const ETH = '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7';
const USDC = '0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb';
const USDT = '0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8';
const WBTC = '0x03fe2b97c1fd336e750087d68b9b867997fd64a2661ff3ca5a7c771641e8e7ac';
const STRKBTC = '0x0787150e306e6eae6e3f79dea881770e8bbff2c1b8eb490f969669ee945b3135';
/** LORDS: a real Starknet token Vesu lists in no pool, so no vault is pinned. */
const LORDS = '0x0124aeb495b947201f5fac96fd1138e326ad86195b98df6dec9009158a533b49';
/** xSTRK: pinned in Prime, and collateral only there: Vesu lends none of it out (D-081). */
const XSTRK = '0x028d709c875c0ceac3dce7065bec5328186dc89fe254527084d1689910954b0a';
/** Every pinned market's symbol, in pinned order (D-081). */
const PINNED_SYMBOLS = [
  'STRK', 'ETH', 'USDC', 'USDT', 'USDC.e', 'sUSN', 'mRe7YIELD', 'WBTC', 'strkBTC', 'tBTC', 'SolvBTC', 'uniBTC', 'YBTC.B',
  'mRe7BTC', 'xSTRK', 'wstETH', 'xWBTC', 'xstrkBTC', 'xtBTC', 'LBTC', 'xLBTC', 'xsBTC', 'EKUBO',
];
/** The markets Vesu lends out, and so the only ones a supply offers (D-081). */
const LENDABLE_SYMBOLS = ['STRK', 'ETH', 'USDC', 'USDT', 'USDC.e', 'WBTC', 'strkBTC', 'tBTC', 'SolvBTC', 'wstETH', 'LBTC'];
const ONE = 10n ** 18n;
const USDC_ONE = 10n ** 6n;
const POOL_FEE = 6n * ONE;

afterEach(() => {
  attachDebugTap(null);
});

/** The counter's view of a pinned token, from the generated market metadata. */
function view(token: string): VaultTokenView {
  const market = VAULT_MARKET_METADATA.find((entry) => BigInt(entry.token) === BigInt(token))!;
  return {
    token: market.token,
    symbol: market.symbol,
    decimals: market.decimals,
    group: market.group,
    poolName: market.poolName,
    curation: market.curation,
    lendable: market.lendable,
  };
}

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

  it('offers every pinned token in demo, STRK first, with the chain’s symbols and decimals and its pool (D-079, D-081)', async () => {
    const { panel } = machine(fake());
    await panel.open();
    const { tokens, token } = panel.store.getState();
    expect(tokens.map((entry) => entry.symbol)).toEqual(PINNED_SYMBOLS);
    expect(tokens.slice(0, 4)).toEqual([
      { token: STRK, symbol: 'STRK', decimals: 18, group: 'majors', poolName: 'Prime', curation: 'prime', lendable: true },
      { token: ETH, symbol: 'ETH', decimals: 18, group: 'majors', poolName: 'Prime', curation: 'prime', lendable: true },
      { token: USDC, symbol: 'USDC', decimals: 6, group: 'stables', poolName: 'Prime', curation: 'prime', lendable: true },
      { token: USDT, symbol: 'USDT', decimals: 6, group: 'stables', poolName: 'Prime', curation: 'prime', lendable: true },
    ]);
    expect(token).toBe(STRK);
  });

  it('offers strkBTC through the curated Re7 xBTC pool, and places every token in a picker group (D-081)', async () => {
    const { panel } = machine(fake());
    await panel.open();
    const { tokens } = panel.store.getState();
    expect(tokens.find((entry) => entry.symbol === 'strkBTC')).toEqual({
      token: STRKBTC,
      symbol: 'strkBTC',
      decimals: 8,
      group: 'btc',
      poolName: 'Re7 xBTC',
      curation: 'curated',
      lendable: true,
    });
    const groups = new Map<string, string[]>();
    for (const entry of tokens) groups.set(entry.group, [...(groups.get(entry.group) ?? []), entry.symbol]);
    expect(Object.fromEntries(groups)).toEqual({
      majors: ['STRK', 'ETH'],
      stables: ['USDC', 'USDT', 'USDC.e', 'sUSN', 'mRe7YIELD'],
      btc: ['WBTC', 'strkBTC', 'tBTC', 'SolvBTC', 'uniBTC', 'YBTC.B', 'mRe7BTC'],
      staking: ['xSTRK', 'wstETH', 'xWBTC', 'xstrkBTC', 'xtBTC', 'LBTC', 'xLBTC', 'xsBTC'],
      ecosystem: ['EKUBO'],
    });
    expect(tokens.filter((entry) => entry.curation === 'curated').map((entry) => entry.poolName)).toEqual([
      'Re7 USDC Stable Core', 'Re7 USDC Stable Core', 'Re7 xBTC', 'Re7 xBTC', 'Re7 xBTC', 'Re7 USDC Core', 'Re7 USDC Frontier',
      'Re7 xBTC', 'Re7 xBTC', 'Re7 xBTC', 'Re7 xBTC', 'Re7 xBTC', 'Re7 xBTC', 'Re7 Labs Starknet Ecosystem',
    ]);
  });

  it('offers only the markets Vesu lends out for supply, and lists only them until a read finds a collateral-only position (D-081)', async () => {
    const { panel } = machine(fake());
    await panel.open();
    const state = panel.store.getState();
    expect(vaultChoices(state, 'supply').map((entry) => entry.symbol)).toEqual(LENDABLE_SYMBOLS);
    expect(vaultChoices(state, 'redeem').map((entry) => entry.symbol)).toEqual(LENDABLE_SYMBOLS);
    expect(vaultListedMarkets(state).map((entry) => entry.symbol)).toEqual(LENDABLE_SYMBOLS);
    // A collateral-only market cannot be chosen for a supply.
    panel.setToken(XSTRK);
    expect(panel.store.getState().token).toBe(STRK);
  });

  it('keeps a collateral-only position listed and redeemable, never suppliable (D-081)', async () => {
    const operations = fake({ vault: { markets: { [XSTRK]: { shares: 20n * ONE } } } });
    const supply = vi.spyOn(operations, 'prepareVaultSupply');
    const { panel } = machine(operations);
    await panel.open();
    await panel.refreshPosition();
    let state = panel.store.getState();
    expect(state.heldTokens).toEqual([XSTRK]);
    expect(vaultListedMarkets(state).map((entry) => entry.symbol)).toEqual([...LENDABLE_SYMBOLS.slice(0, 9), 'xSTRK', ...LENDABLE_SYMBOLS.slice(9)]);
    expect(vaultChoices(state, 'supply').map((entry) => entry.symbol)).toEqual(LENDABLE_SYMBOLS);

    // Redeem offers it; supply never does.
    panel.setToken(XSTRK);
    expect(panel.store.getState().token).toBe(STRK);
    panel.setMode('redeem');
    panel.setToken(XSTRK);
    expect(panel.store.getState().token).toBe(XSTRK);
    panel.setRedeemAll(true);
    await panel.prepare();
    state = panel.store.getState();
    expect(state.flow.name === 'review' && state.flow.summary.action).toEqual({ kind: 'redeem', token: XSTRK, amount: 20_400_000_000_000_000_000n, all: true });
    await panel.confirm();
    expect(operations.vaultSubmitted).toEqual([{ kind: 'redeem', token: XSTRK, amount: 20_400_000_000_000_000_000n, all: true }]);
    // The figures changed; the market stays redeemable until a read says otherwise.
    panel.acknowledge();
    expect(panel.store.getState()).toMatchObject({ heldTokens: [XSTRK], token: XSTRK, position: { status: 'unrequested' } });

    // A new read finds it empty: the choice moves to the first market, and it is no longer listed.
    await panel.refreshPosition();
    state = panel.store.getState();
    expect(state.heldTokens).toEqual([]);
    expect(state.token).toBe(STRK);
    expect(vaultListedMarkets(state).map((entry) => entry.symbol)).toEqual(LENDABLE_SYMBOLS);

    // Back in supply, a collateral-only token is never the choice.
    panel.setMode('supply');
    expect(panel.store.getState().token).toBe(STRK);
    expect(supply).not.toHaveBeenCalled();
  });

  it('moves a redeem’s collateral-only choice to the first supply choice when the mode turns to supply (D-081)', async () => {
    const { panel } = machine(fake({ vault: { markets: { [XSTRK]: { shares: ONE } } } }));
    await panel.open();
    await panel.refreshPosition();
    panel.setMode('redeem');
    panel.setToken(XSTRK);
    panel.setAmount('0.5');
    panel.setMode('supply');
    expect(panel.store.getState()).toMatchObject({ mode: 'supply', token: STRK, amountText: '' });
  });

  it('offers nothing for supply in a build that admits only collateral-only markets, and still reads them', async () => {
    const operations = fake({ vault: { markets: { [XSTRK]: { shares: ONE } } } });
    const { panel } = machine(operations, { tokens: [view(XSTRK)] });
    await panel.open();
    expect(panel.store.getState()).toMatchObject({ token: null, tokens: [view(XSTRK)] });
    await panel.refreshPosition();
    expect(panel.store.getState().position).toMatchObject({ status: 'loaded' });
    panel.setMode('redeem');
    expect(panel.store.getState().token).toBe(XSTRK);
  });

  it('reads every offered token’s position and the stand-in address only when asked', async () => {
    const { panel } = machine(fake({ shares: 50n * ONE, vault: { markets: { [USDC]: { shares: 50n * USDC_ONE } } } }));
    await panel.open();
    await panel.refreshPosition();
    const { position } = panel.store.getState();
    expect(position).toMatchObject({ status: 'loaded', standIn: DEMO_VAULT_STAND_IN });
    if (position.status !== 'loaded') return;
    expect(position.positions).toHaveLength(PINNED_SYMBOLS.length);
    expect(position.positions.slice(0, 4)).toEqual([
      { token: STRK, shares: 50n * ONE, assets: 51n * ONE, redeemable: 51n * ONE },
      { token: ETH, shares: 0n, assets: 0n, redeemable: 0n },
      // In USDC's own base units.
      { token: USDC, shares: 50n * USDC_ONE, assets: 51n * USDC_ONE, redeemable: 51n * USDC_ONE },
      { token: USDT, shares: 0n, assets: 0n, redeemable: 0n },
    ]);
    // Every other pinned market, curated ones included, reads as empty.
    expect(position.positions.slice(4).every((entry) => entry.shares === 0n && entry.assets === 0n)).toBe(true);
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
    expect(review.summary.token).toEqual(view(USDC));
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
    const { panel } = machine(fake(), { tokens: [view(STRK), view(USDC)] });
    await panel.open();
    panel.setToken(STRKBTC);
    panel.setToken(WBTC);
    expect(panel.store.getState().token).toBe(STRK);
    panel.setToken(`0x${USDC.slice(3).toUpperCase()}`);
    expect(panel.store.getState().token).toBe(USDC);
  });

  it('shows Vesu’s rates for the offered tokens it has, and a failed read as unavailable, reporting nothing', async () => {
    const rated = fake({ vault: { rates: { [USDC]: { value: 30925508207480051n, decimals: 18 }, [WBTC]: { value: 3n, decimals: 3 } } } });
    const { panel } = machine(rated, { tokens: [view(STRK), view(USDC)] });
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
    // LORDS is a token with no pinned vault; a repeat is offered once.
    expect(vaultTokenChoices(vaultPolicy([LORDS, WBTC, `0x${WBTC.slice(3)}`])).map((entry) => entry.symbol)).toEqual(['WBTC']);
    // A collateral-only market is offered to the counter, which keeps it out of Supply (D-081).
    expect(vaultTokenChoices(vaultPolicy([XSTRK])).map((entry) => [entry.symbol, entry.lendable])).toEqual([['xSTRK', false]]);
    expect(vaultTokenChoices(vaultPolicy([STRKBTC, USDC])).map((entry) => entry.symbol)).toEqual(['strkBTC', 'USDC']);
    expect(vaultTokenChoices({ ...vaultPolicy([]), allowedTokens: { shield: [], unshield: [], transfer: [], swap: [] } })).toEqual([]);
    expect(vaultTokenChoices(null).map((entry) => entry.symbol)).toEqual(PINNED_SYMBOLS);
  });

  it('says plainly when the pool balance holds none of the token, asks the wallet nothing more, and never blocks reading (D-081)', async () => {
    // STRK in the pool balance, no USDC.
    const operations = fake();
    const balances = vi.spyOn(operations, 'balances');
    const supply = vi.spyOn(operations, 'prepareVaultSupply');
    const { panel, failures } = machine(operations);
    await panel.open();
    expect(balances).not.toHaveBeenCalled();
    panel.setToken(USDC);
    panel.setAmount('5');
    await panel.prepare();
    expect(balances).toHaveBeenCalledWith([USDC], undefined);
    expect(supply).not.toHaveBeenCalled();
    expect(panel.store.getState()).toMatchObject({ flow: { name: 'composing' }, holding: { status: 'none', token: USDC }, amountText: '5' });
    expect(noneInPoolLine(view(USDC))).toBe(
      'You have no USDC in your pool balance, so there is nothing to supply. Shield some first, or choose another token.',
    );
    expect(failures).toEqual([]);
    expect(operations.vaultSubmitted).toEqual([]);

    // Reading never depends on it.
    await panel.refreshPosition();
    expect(panel.store.getState().position).toMatchObject({ status: 'loaded' });
    expect(panel.store.getState().rates).toMatchObject({ status: 'loaded' });

    // Another token forgets it, and a token that is there goes ahead to the review.
    panel.setToken(STRK);
    expect(panel.store.getState().holding).toEqual({ status: 'unknown' });
    panel.setAmount('5');
    await panel.prepare();
    expect(panel.store.getState().flow).toMatchObject({ name: 'review', summary: { action: { kind: 'supply', token: STRK } } });
  });

  it('goes ahead when the balance read cannot be made, and stops quietly when the player declines it (D-081)', async () => {
    const operations = fake({ balances: { [USDC]: 100n * USDC_ONE } });
    const supply = vi.spyOn(operations, 'prepareVaultSupply');
    const { panel, failures } = machine(operations);
    await panel.open();
    panel.setToken(USDC);
    panel.setAmount('5');

    vi.spyOn(operations, 'balances').mockRejectedValueOnce(Object.assign(new Error('no'), { kind: 'user-rejected' }));
    await panel.prepare();
    expect(panel.store.getState()).toMatchObject({ flow: { name: 'composing' }, holding: { status: 'unknown' }, notice: null });
    expect(supply).not.toHaveBeenCalled();

    vi.spyOn(operations, 'balances').mockRejectedValueOnce(Object.assign(new Error('socket'), { kind: 'unreachable' }));
    await panel.prepare();
    // The read decided nothing; the wallet still checks the funds.
    expect(supply).toHaveBeenCalledWith(USDC, 5_000_000n, expect.anything());
    expect(panel.store.getState().flow.name).toBe('review');
    expect(failures).toEqual([]);
  });

  it('never reads the pool balance for a redeem', async () => {
    const operations = fake({ balance: 20n * ONE, vault: { markets: { [USDC]: { shares: 50n * USDC_ONE } } } });
    const balances = vi.spyOn(operations, 'balances');
    const { panel } = machine(operations);
    await panel.open();
    panel.setMode('redeem');
    panel.setToken(USDC);
    panel.setRedeemAll(true);
    await panel.prepare();
    expect(panel.store.getState().flow.name).toBe('review');
    expect(balances).not.toHaveBeenCalled();
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
