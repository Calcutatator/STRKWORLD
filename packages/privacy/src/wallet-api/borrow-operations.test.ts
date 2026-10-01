import { describe, expect, it } from 'vitest';
import type { STRK20_ACTION } from 'starknet';
import {
  BORROW_PAIRS,
  BORROW_REVIEW_TTL_MS,
  BORROW_TOKENS,
  BorrowRefusedError,
  PrivacyError,
  VAULT_MARKETS,
  WalletApiPrivacyOperations,
  type BorrowAssetRow,
  type BorrowPairRow,
  type BorrowPositionRow,
  type BorrowReadClient,
  type PoolReadClient,
  type VaultReadClient,
  type VaultStage,
  type WalletRoutePolicy,
  type WalletStrk20Account,
} from '../index.js';
import {
  borrowAddCollateralActions,
  borrowOpenActions,
  borrowRepayActions,
  borrowShadowAccountAddress,
  borrowWithdrawCollateralActions,
  repayAllBuffer,
} from '../borrow.js';
import { shadowAccountAddress } from '../vault.js';

/**
 * The Borrow counter on the Wallet API adapter (D-083): its own commitment
 * and cross-checked stand-in, the market and loans reads through the
 * backend, the refusals before any prompt, and the four wallet-submitted
 * flows, each handed to the wallet exactly as `borrow.ts` builds it.
 */

const [STRK, ETH, USDC, USDT, WBTC] = BORROW_TOKENS as [string, string, string, string, string];
const PLAYER = '0xabc';
const BORROW_PARTIAL = '0x7a11b0';
const VAULT_PARTIAL = '0x5f2e1d';
const SHADOW = borrowShadowAccountAddress(BORROW_PARTIAL);
const POOL_FEE = 6n * 10n ** 18n;
const TX = '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const E18 = 10n ** 18n;
const USDC_ONE = 10n ** 6n;
const RATE = E18; // a rate accumulator of 1: nominal debt equals debt
const DECIMALS: Record<string, number> = { [STRK]: 18, [ETH]: 18, [USDC]: 6, [USDT]: 6, [WBTC]: 8 };
const PRICES: Record<string, bigint> = {
  [STRK]: 43_278_720_000_000_000n,
  [ETH]: 2_686_650n * 10n ** 15n,
  [USDC]: 999_939_000_000_000_000n,
  [USDT]: 999_480_000_000_000_000n,
  [WBTC]: 83_579_759_432_340_000_000_000n,
};

function assetRows(overrides: Record<string, Partial<Extract<BorrowAssetRow, { ok: true }>> | { ok: false }> = {}): BorrowAssetRow[] {
  return BORROW_TOKENS.map((token) => {
    const override = overrides[token];
    if (override && 'ok' in override && override.ok === false) return { token, ok: false };
    const scale = 10n ** BigInt(DECIMALS[token]!);
    return {
      token,
      ok: true,
      price: PRICES[token]!,
      priceValid: true,
      scale,
      floor: 10n * E18,
      reserve: 1_000_000n * scale,
      totalNominalDebt: 1_000_000n * E18,
      rateAccumulator: RATE,
      maxUtilization: 950_000_000_000_000_000n,
      ...(override as object),
    } as BorrowAssetRow;
  });
}

function pairRows(overrides: Record<string, Partial<Extract<BorrowPairRow, { ok: true }>> | { ok: false }> = {}): BorrowPairRow[] {
  return BORROW_PAIRS.map(({ collateral, debt }) => {
    const override = overrides[`${collateral}:${debt}`];
    if (override && 'ok' in override && override.ok === false) return { collateral, debt, ok: false };
    return {
      collateral,
      debt,
      ok: true,
      maxLtv: collateral === STRK ? 680_000_000_000_000_000n : 780_000_000_000_000_000n,
      liquidationFactor: 900_000_000_000_000_000n,
      debtCap: 200_000n * 10n ** BigInt(DECIMALS[debt]!),
      totalNominalDebt: 0n,
      ...(override as object),
    } as BorrowPairRow;
  });
}

function positionRows(held: Record<string, { collateral: bigint; debt: bigint }> = {}): BorrowPositionRow[] {
  return BORROW_PAIRS.map(({ collateral, debt }) => {
    const entry = held[`${collateral}:${debt}`] ?? { collateral: 0n, debt: 0n };
    // One collateral share per base unit, in Vesu's SCALE; nominal debt at a rate of 1.
    return {
      collateral,
      debt,
      ok: true,
      collateralShares: entry.collateral * 3n,
      nominalDebt: entry.debt * (E18 / 10n ** BigInt(DECIMALS[debt]!)),
      collateralAmount: entry.collateral,
      debtAmount: entry.debt,
    };
  });
}

function borrowPolicy(tokens: string[] = [...BORROW_TOKENS], routes: WalletRoutePolicy['enabledRoutes'] = ['borrow', 'vault']): WalletRoutePolicy {
  return {
    maxIntents: 1,
    maxRelayFee: 0n,
    enabledRoutes: routes,
    allowedTokens: { shield: [], unshield: [], transfer: [], swap: [], borrow: tokens, vault: [STRK] },
  };
}

function fixture(options: { policy?: WalletRoutePolicy; withReads?: boolean } = {}) {
  const invoked: STRK20_ACTION[][] = [];
  const commitments: string[] = [];
  const shadowReads: string[] = [];
  const positionReads: string[] = [];
  let marketReads = 0;
  const stages: VaultStage[] = [];
  const state = {
    clock: 0,
    fee: POOL_FEE,
    assets: assetRows() as unknown,
    pairs: pairRows() as unknown,
    positions: positionRows() as unknown,
    shadowAddress: SHADOW,
  };
  const wallet: WalletStrk20Account = {
    address: PLAYER,
    async strk20Balances() { throw new Error('the borrow counter never reads a private balance'); },
    async strk20PrepareInvoke() { throw new Error('the borrow counter never asks for a relayed proof'); },
    async strk20InvokeTransaction(actions) {
      invoked.push(actions);
      return { transaction_hash: TX };
    },
    async strk20ShadowAccountCommitment(dappName: string) {
      commitments.push(dappName);
      return dappName === 'strkworld-borrow' ? BORROW_PARTIAL : VAULT_PARTIAL;
    },
  };
  const pool: PoolReadClient = {
    async config() { return { feeAmount: state.fee, feeToken: STRK, proofValidityBlocks: 450, noteMaturityBlocks: 10 }; },
    async publicKey() { return '0x1'; },
    async receipt() { return { transaction_hash: TX, finality_status: 'ACCEPTED_ON_L2', execution_status: 'SUCCEEDED' }; },
  };
  const shadowAccount: VaultReadClient['shadowAccount'] = async (partial) => {
    shadowReads.push(partial);
    return { address: partial === BORROW_PARTIAL ? state.shadowAddress : shadowAccountAddress(VAULT_PARTIAL), deployed: true };
  };
  const borrow: BorrowReadClient = {
    shadowAccount,
    async borrowMarket() {
      marketReads += 1;
      return { assets: state.assets, pairs: state.pairs } as never;
    },
    async borrowPositions(account) {
      positionReads.push(account);
      return state.positions as never;
    },
  };
  const vault: VaultReadClient = {
    shadowAccount,
    async vaultPositions() {
      return [{ vault: VAULT_MARKETS[0]!.vault, ok: true, shares: 0n, assets: 0n, maxWithdraw: 0n, maxRedeem: 0n }];
    },
    async vaultRates() { return []; },
  };
  const operations = new WalletApiPrivacyOperations({
    wallet,
    pool,
    supportedVersions: async () => ['0.10.4'],
    policy: options.policy ?? borrowPolicy(),
    vault,
    ...(options.withReads === false ? {} : { borrow }),
    sleep: async () => {},
    now: () => state.clock,
  });
  return {
    operations,
    invoked,
    commitments,
    shadowReads,
    positionReads,
    get marketReads() { return marketReads; },
    stages,
    onStage: (stage: VaultStage) => stages.push(stage),
    state,
  };
}

describe('the borrow market read (D-083)', () => {
  it('answers every admitted token and offered pair without asking the wallet anything', async () => {
    const f = fixture();
    const market = await f.operations.borrowMarket();
    expect(market.assets.map((asset) => asset.token)).toEqual(BORROW_TOKENS);
    expect(market.assets[2]).toEqual({
      token: USDC,
      price: PRICES[USDC],
      priceValid: true,
      scale: USDC_ONE,
      floor: 10n * E18,
      reserve: 1_000_000n * USDC_ONE,
      totalDebt: 1_000_000n * USDC_ONE,
      maxUtilization: 950_000_000_000_000_000n,
    });
    expect(market.pairs).toHaveLength(20);
    expect(f.commitments).toEqual([]);
    expect(f.invoked).toEqual([]);
  });

  it('leaves out a pair whose max LTV or debt cap reads zero', async () => {
    const f = fixture();
    f.state.pairs = pairRows({ [`${STRK}:${USDC}`]: { maxLtv: 0n }, [`${ETH}:${USDT}`]: { debtCap: 0n } });
    const market = await f.operations.borrowMarket();
    expect(market.pairs).toHaveLength(18);
    expect(market.pairs.some((pair) => pair.collateral === STRK && pair.debt === USDC)).toBe(false);
    expect(market.pairs.some((pair) => pair.collateral === ETH && pair.debt === USDT)).toBe(false);
  });

  it('counts a pair\'s whole debt at the debt token\'s rate accumulator, rounding up', async () => {
    const f = fixture();
    f.state.assets = assetRows({ [USDC]: { rateAccumulator: 1_500_000_000_000_000_000n } });
    f.state.pairs = pairRows({ [`${ETH}:${USDC}`]: { totalNominalDebt: 10n * E18 + 1n } });
    const market = await f.operations.borrowMarket();
    expect(market.pairs.find((pair) => pair.collateral === ETH && pair.debt === USDC)!.totalDebt).toBe(15n * USDC_ONE + 1n);
  });

  it('admits only the pairs of tokens the policy lists, in the policy\'s token order', async () => {
    const f = fixture({ policy: borrowPolicy([USDC, ETH]) });
    const market = await f.operations.borrowMarket();
    expect(market.assets.map((asset) => asset.token)).toEqual([USDC, ETH]);
    expect(market.pairs.map((pair) => [pair.collateral, pair.debt])).toEqual([[ETH, USDC], [USDC, ETH]]);
  });

  it('fails a failed row as unreachable and a malformed one as invalid', async () => {
    const f = fixture();
    f.state.assets = assetRows({ [WBTC]: { ok: false } });
    await expect(f.operations.borrowMarket()).rejects.toMatchObject({ kind: 'unreachable' });
    f.state.assets = assetRows({ [USDC]: { scale: 10n ** 18n } });
    await expect(f.operations.borrowMarket()).rejects.toThrow('The borrow read is invalid.');
    f.state.assets = assetRows();
    f.state.pairs = pairRows({ [`${STRK}:${ETH}`]: { maxLtv: E18 + 1n } });
    await expect(f.operations.borrowMarket()).rejects.toThrow('The borrow read is invalid.');
  });

  it('stays shut when the route is off, its list empty or a token unpinned', async () => {
    for (const policy of [
      borrowPolicy([...BORROW_TOKENS], ['vault']),
      borrowPolicy([]),
      borrowPolicy([STRK, '0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8']),
    ]) {
      await expect(fixture({ policy }).operations.borrowMarket()).rejects.toThrow('The borrow route is disabled.');
    }
    await expect(fixture({ withReads: false }).operations.borrowMarket()).rejects.toThrow('The borrow reads are not configured.');
  });
});

describe('the borrow stand-in and loans (D-083)', () => {
  it('asks the wallet for the strkworld-borrow commitment, cross-checks the address, and returns only held loans with their health', async () => {
    const f = fixture();
    f.state.positions = positionRows({ [`${STRK}:${USDC}`]: { collateral: 10_000n * E18, debt: 100n * USDC_ONE } });
    const loans = await f.operations.borrowPositions({ onStage: f.onStage });
    expect(f.commitments).toEqual(['strkworld-borrow']);
    expect(f.shadowReads).toEqual([BORROW_PARTIAL]);
    expect(f.positionReads).toEqual([`0x${BigInt(SHADOW).toString(16)}`]);
    expect(loans.standIn).toBe(`0x${BigInt(SHADOW).toString(16)}`);
    expect(loans.positions).toHaveLength(1);
    expect(loans.positions[0]).toMatchObject({ collateral: STRK, debt: USDC, collateralAmount: 10_000n * E18, debtAmount: 100n * USDC_ONE });
    expect(loans.positions[0]!.health).toMatchObject({ status: 'priced', band: 'safe', maxLtv: 680_000_000_000_000_000n });
    expect(f.stages.map((stage) => stage.stage)).toEqual(['capability', 'commitment', 'address', 'position']);
  });

  it('never shares an address with the Vault: two commitments, two dapp names', async () => {
    const f = fixture();
    const vault = await f.operations.vaultPositions();
    const borrow = await f.operations.borrowPositions();
    expect(f.commitments).toEqual(['strkworld-vault', 'strkworld-borrow']);
    expect(BigInt(vault.standIn)).not.toBe(BigInt(borrow.standIn));
  });

  it('fails closed when the anonymizer answers another address', async () => {
    const f = fixture();
    f.state.shadowAddress = shadowAccountAddress(VAULT_PARTIAL);
    await expect(f.operations.borrowPositions()).rejects.toThrow('The borrow counter could not verify its stand-in address, so nothing was sent.');
  });

  it('measures a loan in a pair no longer offered by that pair\'s own max LTV', async () => {
    const f = fixture();
    f.state.pairs = pairRows({ [`${STRK}:${USDC}`]: { debtCap: 0n } });
    f.state.positions = positionRows({ [`${STRK}:${USDC}`]: { collateral: 10_000n * E18, debt: 100n * USDC_ONE } });
    const loans = await f.operations.borrowPositions();
    expect(loans.positions[0]!.health.maxLtv).toBe(680_000_000_000_000_000n);
  });
});

describe('the four flows through the wallet (D-083)', () => {
  const pairKey = { collateral: STRK, debt: USDC };
  const shadowFelt = () => `0x${BigInt(SHADOW).toString(16)}`;

  it('opens a loan: the wallet gets exactly the built actions, and the review states the health after', async () => {
    const f = fixture();
    const batch = await f.operations.prepareBorrow({ kind: 'borrow', ...pairKey, collateralAmount: 10_000n * E18, borrowAmount: 100n * USDC_ONE });
    expect(batch.action).toEqual({ kind: 'borrow', collateral: STRK, debt: USDC, collateralAmount: 10_000n * E18, borrowAmount: 100n * USDC_ONE });
    expect(batch.after).toMatchObject({ status: 'priced', band: 'safe' });
    expect(batch.poolFee).toBe(POOL_FEE);
    expect(batch.gasEstimate).toBe(0n);
    expect(batch.totalCost).toBe(POOL_FEE);
    expect(f.invoked).toEqual([]);
    const result = await batch.confirm({ feeCeiling: POOL_FEE });
    expect(result).toEqual({ transactionHash: TX, outcome: 'succeeded' });
    expect(f.invoked).toEqual([borrowOpenActions({ pair: pairKey, shadowAccount: shadowFelt(), player: PLAYER, collateralAmount: 10_000n * E18, borrowAmount: 100n * USDC_ONE })]);
  });

  it('adds collateral', async () => {
    const f = fixture();
    f.state.positions = positionRows({ [`${STRK}:${USDC}`]: { collateral: 10_000n * E18, debt: 100n * USDC_ONE } });
    const batch = await f.operations.prepareBorrow({ kind: 'add-collateral', ...pairKey, amount: 500n * E18 });
    await batch.confirm({ feeCeiling: POOL_FEE });
    expect(f.invoked).toEqual([borrowAddCollateralActions({ pair: pairKey, shadowAccount: shadowFelt(), amount: 500n * E18 })]);
  });

  it('repays part, exactly', async () => {
    const f = fixture();
    f.state.positions = positionRows({ [`${STRK}:${USDC}`]: { collateral: 10_000n * E18, debt: 100n * USDC_ONE } });
    const batch = await f.operations.prepareBorrow({ kind: 'repay', ...pairKey, amount: 40n * USDC_ONE });
    expect(batch.action).toEqual({ kind: 'repay', collateral: STRK, debt: USDC, amount: 40n * USDC_ONE, all: false, buffer: 0n });
    await batch.confirm({ feeCeiling: POOL_FEE });
    expect(f.invoked).toEqual([borrowRepayActions({ pair: pairKey, shadowAccount: shadowFelt(), player: PLAYER, repay: { amount: 40n * USDC_ONE } })]);
  });

  it('repays all: the read nominal debt in native, the debt plus its buffer out of the pool', async () => {
    const f = fixture();
    f.state.positions = positionRows({ [`${STRK}:${USDC}`]: { collateral: 10_000n * E18, debt: 100n * USDC_ONE } });
    const batch = await f.operations.prepareBorrow({ kind: 'repay', ...pairKey, amount: 'all' });
    const buffer = repayAllBuffer(100n * USDC_ONE);
    expect(batch.action).toEqual({ kind: 'repay', collateral: STRK, debt: USDC, amount: 100n * USDC_ONE + buffer, all: true, buffer });
    expect(batch.after.status).toBe('no-debt');
    await batch.confirm({ feeCeiling: POOL_FEE });
    expect(f.invoked).toEqual([borrowRepayActions({
      pair: pairKey,
      shadowAccount: shadowFelt(),
      player: PLAYER,
      repay: { nominalDebt: 100n * E18, withdraw: 100n * USDC_ONE + buffer },
    })]);
  });

  it('withdraws collateral, and all of it by every share once no debt is left', async () => {
    const f = fixture();
    f.state.positions = positionRows({ [`${STRK}:${USDC}`]: { collateral: 10_000n * E18, debt: 100n * USDC_ONE } });
    const part = await f.operations.prepareBorrow({ kind: 'withdraw-collateral', ...pairKey, amount: 1_000n * E18 });
    await part.confirm({ feeCeiling: POOL_FEE });
    expect(f.invoked[0]).toEqual(borrowWithdrawCollateralActions({ pair: pairKey, shadowAccount: shadowFelt(), player: PLAYER, withdraw: { amount: 1_000n * E18 } }));
    f.state.positions = positionRows({ [`${STRK}:${USDC}`]: { collateral: 10_000n * E18, debt: 0n } });
    const all = await f.operations.prepareBorrow({ kind: 'withdraw-collateral', ...pairKey, amount: 'all' });
    expect(all.action).toEqual({ kind: 'withdraw-collateral', collateral: STRK, debt: USDC, amount: 10_000n * E18, all: true });
    await all.confirm({ feeCeiling: POOL_FEE });
    expect(f.invoked[1]).toEqual(borrowWithdrawCollateralActions({ pair: pairKey, shadowAccount: shadowFelt(), player: PLAYER, withdraw: { collateralShares: 30_000n * E18 } }));
  });

  it('refuses a withdrawal past the max LTV before the wallet is asked to sign anything', async () => {
    const f = fixture();
    f.state.positions = positionRows({ [`${STRK}:${USDC}`]: { collateral: 10_000n * E18, debt: 100n * USDC_ONE } });
    const refused = f.operations.prepareBorrow({ kind: 'withdraw-collateral', ...pairKey, amount: 9_000n * E18 });
    await expect(refused).rejects.toBeInstanceOf(BorrowRefusedError);
    await expect(refused).rejects.toMatchObject({ kind: 'unknown', refusal: 'above-max-ltv' });
    expect(f.invoked).toEqual([]);
  });

  it('refuses every action on a pair whose price Vesu calls stale', async () => {
    const f = fixture();
    f.state.assets = assetRows({ [USDC]: { priceValid: false } });
    f.state.positions = positionRows({ [`${STRK}:${USDC}`]: { collateral: 10_000n * E18, debt: 100n * USDC_ONE } });
    await expect(f.operations.prepareBorrow({ kind: 'repay', ...pairKey, amount: 'all' })).rejects.toMatchObject({ refusal: 'stale-price' });
    expect(f.invoked).toEqual([]);
  });

  it('refuses a pair the build does not admit, and a malformed request, before any prompt', async () => {
    const f = fixture({ policy: borrowPolicy([ETH, USDC]) });
    await expect(f.operations.prepareBorrow({ kind: 'borrow', ...pairKey, collateralAmount: 1n, borrowAmount: 1n }))
      .rejects.toThrow('The borrow counter does not offer that pair in this build.');
    await expect(f.operations.prepareBorrow({ kind: 'lend', collateral: ETH, debt: USDC } as never)).rejects.toThrow('The borrow request is invalid.');
    expect(f.commitments).toEqual([]);
  });

  it('refuses a review older than two minutes at confirm, before the wallet is asked (review fix)', async () => {
    const f = fixture();
    f.state.positions = positionRows({ [`${STRK}:${USDC}`]: { collateral: 10_000n * E18, debt: 100n * USDC_ONE } });
    f.state.clock = 1_000;
    const stale = await f.operations.prepareBorrow({ kind: 'repay', ...pairKey, amount: 'all' });
    f.state.clock = 1_000 + BORROW_REVIEW_TTL_MS + 1;
    await expect(stale.confirm({ feeCeiling: POOL_FEE })).rejects.toMatchObject({ kind: 'unknown', refusal: 'review-expired' });
    expect(f.invoked).toEqual([]);
    // Prepared again, it confirms; so does one confirmed just inside the two minutes.
    const fresh = await f.operations.prepareBorrow({ kind: 'repay', ...pairKey, amount: 'all' });
    f.state.clock += BORROW_REVIEW_TTL_MS;
    await expect(fresh.confirm({ feeCeiling: POOL_FEE })).resolves.toMatchObject({ outcome: 'succeeded' });
    expect(f.invoked).toHaveLength(1);
  });

  it('withdraws part of the collateral of a loan in a pair Vesu no longer offers, by that pair\'s own max LTV (review fix)', async () => {
    const f = fixture();
    f.state.pairs = pairRows({ [`${STRK}:${USDC}`]: { debtCap: 0n } });
    f.state.positions = positionRows({ [`${STRK}:${USDC}`]: { collateral: 10_000n * E18, debt: 100n * USDC_ONE } });
    const batch = await f.operations.prepareBorrow({ kind: 'withdraw-collateral', ...pairKey, amount: 1_000n * E18 });
    expect(batch.after).toMatchObject({ band: 'safe', maxLtv: 680_000_000_000_000_000n });
    const repaid = await f.operations.prepareBorrow({ kind: 'repay', ...pairKey, amount: 50n * USDC_ONE });
    expect(repaid.after.band).toBe('safe');
  });

  it('refuses to sign above the fee ceiling', async () => {
    const f = fixture();
    const batch = await f.operations.prepareBorrow({ kind: 'borrow', ...pairKey, collateralAmount: 10_000n * E18, borrowAmount: 100n * USDC_ONE });
    f.state.fee = POOL_FEE + 1n;
    await expect(batch.confirm({ feeCeiling: POOL_FEE })).rejects.toBeInstanceOf(PrivacyError);
    expect(f.invoked).toEqual([]);
  });
});
