import { describe, expect, it } from 'vitest';
import { DEMO_VAULT_STAND_IN, FakePrivacyOperations, type FakeConfig } from './fake.js';
import { VAULT_MARKETS, VESU_VSTRK_ASSET } from '../vault.js';
import type { VaultPosition, VaultStage } from '../operations.js';

/**
 * The demo Vault (D-077, D-079). The fake prices a share of every vault at a
 * fixed DEMO rate of 51 of its token per 50 shares. The rate is a fixture: it
 * is asserted so demo mode stays deterministic, never because it resembles
 * Vesu's live rate. The pool fee comes out of the shielded balance on both
 * legs, in STRK, the pool's fee token, whatever the Vault moves: the case
 * that needs STRK in the pool, which a real wallet may not.
 */

const STRK = VESU_VSTRK_ASSET;
const USDC = VAULT_MARKETS.find((market) => market.symbol === 'USDC')!.token;
const WBTC = VAULT_MARKETS.find((market) => market.symbol === 'WBTC')!.token;
const ONE = 10n ** 18n;
const USDC_ONE = 10n ** 6n;
const POOL_FEE = 6n * ONE;

function fresh(balance = 100n * ONE, vault?: FakeConfig['vault'], extra: Record<string, bigint> = {}) {
  return new FakePrivacyOperations({
    balances: { [STRK]: balance, ...extra },
    poolConfig: { noteMaturityBlocks: 0 },
    ...(vault ? { vault } : {}),
  });
}

async function total(fake: FakePrivacyOperations, token: string): Promise<bigint> {
  const [entry] = await fake.balances([token]);
  return entry?.total ?? 0n;
}

async function position(fake: FakePrivacyOperations, token: string): Promise<VaultPosition> {
  const { positions } = await fake.vaultPositions();
  const found = positions.find((entry) => BigInt(entry.token) === BigInt(token));
  if (!found) throw new Error(`no ${token} position`);
  return found;
}

describe('the demo Vault', () => {
  it('reads every pinned token’s position, in the map’s order, on one demo stand-in address', async () => {
    const fake = fresh();
    const read = await fake.vaultPositions();
    expect(read.standIn).toBe(DEMO_VAULT_STAND_IN);
    expect(read.positions).toEqual(VAULT_MARKETS.map((market) => ({ token: market.token, shares: 0n, assets: 0n, redeemable: 0n })));
    expect(Object.isFrozen(read)).toBe(true);
    expect(Object.isFrozen(read.positions)).toBe(true);
  });

  it('supplies from the shielded balance and holds the shares on the demo stand-in address', async () => {
    const fake = fresh();
    const batch = await fake.prepareVaultSupply(STRK, 51n * ONE);
    expect(batch).toMatchObject({
      action: { kind: 'supply', token: STRK, amount: 51n * ONE },
      poolFee: POOL_FEE,
      gasEstimate: 0n,
      totalCost: POOL_FEE,
    });
    const submitted: string[] = [];
    const receipt = await batch.confirm({ feeCeiling: POOL_FEE, onSubmitted: ({ transactionHash }) => submitted.push(transactionHash) });
    expect(receipt).toEqual({ transactionHash: submitted[0], outcome: 'succeeded' });

    expect(await total(fake, STRK)).toBe(100n * ONE - 51n * ONE - POOL_FEE);
    await expect(position(fake, STRK)).resolves.toEqual({ token: STRK, shares: 50n * ONE, assets: 51n * ONE, redeemable: 51n * ONE });
    expect(fake.vaultSubmitted).toEqual([{ kind: 'supply', token: STRK, amount: 51n * ONE }]);
  });

  it('supplies another token in its own units, and takes the pool fee in STRK', async () => {
    const fake = fresh(10n * ONE, undefined, { [USDC]: 100n * USDC_ONE });
    await (await fake.prepareVaultSupply(USDC, 51n * USDC_ONE)).confirm({ feeCeiling: POOL_FEE });
    expect(await total(fake, USDC)).toBe(49n * USDC_ONE);
    expect(await total(fake, STRK)).toBe(4n * ONE);
    await expect(position(fake, USDC)).resolves.toEqual({ token: USDC, shares: 50n * USDC_ONE, assets: 51n * USDC_ONE, redeemable: 51n * USDC_ONE });
    // The other vaults are untouched.
    await expect(position(fake, STRK)).resolves.toMatchObject({ shares: 0n });
    expect(fake.vaultSubmitted).toEqual([{ kind: 'supply', token: USDC, amount: 51n * USDC_ONE }]);
  });

  it('needs STRK for the fee even when the token supplied is plentiful', async () => {
    const fake = fresh(ONE, undefined, { [USDC]: 100n * USDC_ONE });
    await expect(fake.prepareVaultSupply(USDC, USDC_ONE)).rejects.toMatchObject({ kind: 'insufficient-balance' });
    await expect(fresh(100n * ONE, undefined, { [USDC]: USDC_ONE }).prepareVaultSupply(USDC, 2n * USDC_ONE))
      .rejects.toMatchObject({ kind: 'insufficient-balance' });
  });

  it('redeems part of a position back into the pool, burning shares rounded up', async () => {
    const fake = fresh(20n * ONE, { shares: 50n * ONE });
    await (await fake.prepareVaultRedeem(STRK, 10n * ONE)).confirm({ feeCeiling: POOL_FEE });
    expect(await total(fake, STRK)).toBe(20n * ONE - POOL_FEE + 10n * ONE);
    // 10 STRK at 51 per 50 burns ceil(10 * 50 / 51) shares.
    expect((await position(fake, STRK)).shares).toBe(50n * ONE - (10n * ONE * 50n + 50n) / 51n);
  });

  it('redeems everything for “all”, and then holds nothing', async () => {
    const fake = fresh(20n * ONE, { shares: 50n * ONE });
    const batch = await fake.prepareVaultRedeem(STRK, 'all');
    expect(batch.action).toEqual({ kind: 'redeem', token: STRK, amount: 51n * ONE, all: true });
    await batch.confirm({ feeCeiling: POOL_FEE });
    expect(await total(fake, STRK)).toBe(20n * ONE - POOL_FEE + 51n * ONE);
    await expect(position(fake, STRK)).resolves.toMatchObject({ shares: 0n, assets: 0n });
    await expect(fake.prepareVaultRedeem(STRK, 'all')).rejects.toMatchObject({ kind: 'unknown' });
  });

  it('redeems another token into a note of that token, the fee still in STRK', async () => {
    const fake = fresh(20n * ONE, { markets: { [WBTC]: { shares: 50n * 10n ** 8n } } });
    await expect(position(fake, WBTC)).resolves.toMatchObject({ assets: 51n * 10n ** 8n });
    await (await fake.prepareVaultRedeem(WBTC, 'all')).confirm({ feeCeiling: POOL_FEE });
    expect(await total(fake, WBTC)).toBe(51n * 10n ** 8n);
    expect(await total(fake, STRK)).toBe(14n * ONE);
    expect(fake.vaultSubmitted).toEqual([{ kind: 'redeem', token: WBTC, amount: 51n * 10n ** 8n, all: true }]);
  });

  it('keeps what the demo vault can pay out now as the redeemable limit', async () => {
    const fake = fresh(20n * ONE, { shares: 50n * ONE, liquidity: 5n * ONE });
    await expect(position(fake, STRK)).resolves.toMatchObject({ redeemable: 5n * ONE });
    await expect(fake.prepareVaultRedeem(STRK, 6n * ONE)).rejects.toMatchObject({ kind: 'unknown' });
    await expect(fake.prepareVaultRedeem(STRK, 'all')).rejects.toMatchObject({ kind: 'unknown' });
    await expect(fake.prepareVaultRedeem(STRK, 5n * ONE)).resolves.toMatchObject({ action: { amount: 5n * ONE } });
  });

  it('needs the pool fee in the shielded balance on either leg, as the wallet does', async () => {
    await expect(fresh(50n * ONE).prepareVaultSupply(STRK, 45n * ONE)).rejects.toMatchObject({ kind: 'insufficient-balance' });
    await expect(fresh(ONE, { shares: 50n * ONE }).prepareVaultRedeem(STRK, 'all')).rejects.toMatchObject({ kind: 'insufficient-balance' });
  });

  it('reports the adapter’s stages, in its order, with no amount in any of them', async () => {
    const fake = fresh();
    const stages: VaultStage[] = [];
    const onStage = (stage: VaultStage) => stages.push(stage);
    await fake.vaultPositions({ onStage });
    await (await fake.prepareVaultSupply(STRK, ONE, { onStage })).confirm({ feeCeiling: POOL_FEE, onStage });
    expect(stages).toEqual([
      { stage: 'capability', supported: true },
      { stage: 'commitment', ok: true },
      { stage: 'address', resolved: true, deployed: false },
      { stage: 'position', ok: true },
      // Asked once per connection, like the wallet's commitment.
      { stage: 'capability', supported: true },
      { stage: 'address', resolved: true, deployed: false },
      { stage: 'submit', ok: true },
      { stage: 'receipt', status: 'succeeded' },
    ]);
  });

  it('says the wallet cannot run a shadow account when the capability says so', async () => {
    const fake = new FakePrivacyOperations({ capability: { supportsShadowAccounts: false } });
    const stages: VaultStage[] = [];
    await expect(fake.vaultPositions({ onStage: (stage) => stages.push(stage) })).rejects.toMatchObject({
      kind: 'shadow-accounts-unsupported',
    });
    expect(stages).toEqual([{ stage: 'capability', supported: false }]);
    await expect(fake.prepareVaultSupply(STRK, ONE)).rejects.toMatchObject({ kind: 'shadow-accounts-unsupported' });
  });

  it('answers an unregistered account as not registered, with the wallet’s 118', async () => {
    const fake = new FakePrivacyOperations({ capability: { registration: 'unregistered' } });
    const stages: VaultStage[] = [];
    await expect(fake.vaultPositions({ onStage: (stage) => stages.push(stage) })).rejects.toMatchObject({ kind: 'not-registered' });
    expect(stages.at(-1)).toEqual({ stage: 'commitment', ok: false, code: 118 });
  });

  it('lends only the pinned tokens, and refuses a spent or discarded batch', async () => {
    const fake = fresh();
    await expect(fake.prepareVaultSupply('0x123', ONE)).rejects.toMatchObject({ kind: 'unknown' });
    // sUSN has no pinned vault: the pool has never held it (D-081).
    await expect(fake.prepareVaultRedeem('0x02411565ef1a14decfbe83d2e987cced918cd752508a3d9c55deb67148d14d17', 'all'))
      .rejects.toMatchObject({ kind: 'unknown' });
    const batch = await fake.prepareVaultSupply(STRK, ONE);
    await batch.confirm({ feeCeiling: POOL_FEE });
    await expect(batch.confirm({ feeCeiling: POOL_FEE })).rejects.toMatchObject({ kind: 'unknown' });
    const discarded = await fake.prepareVaultSupply(STRK, ONE);
    discarded.discard();
    await expect(discarded.confirm({ feeCeiling: POOL_FEE })).rejects.toMatchObject({ kind: 'unknown' });
    await expect((await fake.prepareVaultSupply(STRK, ONE)).confirm({ feeCeiling: POOL_FEE - 1n })).rejects.toMatchObject({ kind: 'unknown' });
  });

  it('states no rate unless configured, and then only DEMO rates, in the map’s order', async () => {
    await expect(fresh().vaultRates()).resolves.toEqual([]);
    const fake = fresh(ONE, { rates: { [USDC]: { value: 31n, decimals: 3 }, [STRK]: { value: 27n, decimals: 3 } } });
    await expect(fake.vaultRates()).resolves.toEqual([
      { token: STRK, supplyApy: { value: 27n, decimals: 3 } },
      { token: USDC, supplyApy: { value: 31n, decimals: 3 } },
    ]);
    fake.injectFault({ kind: 'unreachable', on: 'vaultRates' });
    await expect(fake.vaultRates()).rejects.toMatchObject({ kind: 'unreachable' });
  });

  it.each([
    ['an unpinned market', { markets: { '0x123': { shares: 1n } } }],
    ['negative shares', { markets: { [USDC]: { shares: -1n } } }],
    ['a rate for an unpinned token', { rates: { '0x123': { value: 1n, decimals: 2 } } }],
    ['a negative rate', { rates: { [USDC]: { value: -1n, decimals: 2 } } }],
    ['a rate with fractional decimals', { rates: { [USDC]: { value: 1n, decimals: 1.5 } } }],
  ])('refuses a Vault configuration with %s', (_label, vault) => {
    expect(() => new FakePrivacyOperations({ vault: vault as never })).toThrow('The fake Vault configuration is invalid.');
  });

  it('injects faults on the Vault calls alone', async () => {
    const fake = fresh();
    fake.injectFault({ kind: 'user-rejected', on: 'vaultConfirm' });
    const batch = await fake.prepareVaultSupply(STRK, ONE);
    const stages: VaultStage[] = [];
    await expect(batch.confirm({ feeCeiling: POOL_FEE, onStage: (stage) => stages.push(stage) })).rejects.toMatchObject({ kind: 'user-rejected' });
    expect(stages).toEqual([{ stage: 'submit', ok: false, code: 113 }]);
    expect(await total(fake, STRK)).toBe(100n * ONE);
  });

  it('is deterministic: two runs of the same script are identical', async () => {
    const run = async () => {
      const fake = fresh();
      const receipt = await (await fake.prepareVaultSupply(STRK, 3n * ONE)).confirm({ feeCeiling: POOL_FEE });
      return { receipt, positions: await fake.vaultPositions(), balance: await total(fake, STRK) };
    };
    expect(await run()).toEqual(await run());
  });
});
