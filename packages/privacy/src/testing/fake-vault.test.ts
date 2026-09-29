import { describe, expect, it } from 'vitest';
import { FakePrivacyOperations } from './fake.js';
import { VESU_VSTRK_ASSET } from '../vault.js';
import type { VaultStage } from '../operations.js';

/**
 * The demo Vault (D-077). The fake prices a vSTRK share at a fixed DEMO rate
 * of 51 STRK per 50 shares. The rate is a fixture: it is asserted so demo
 * mode stays deterministic, never because it resembles Vesu's live rate. The
 * pool fee comes out of the shielded balance on both legs, as the wallet takes
 * it when it submits.
 */

const STRK = VESU_VSTRK_ASSET;
const ONE = 10n ** 18n;
const POOL_FEE = 6n * ONE;

function fresh(balance = 100n * ONE, vault?: { shares?: bigint; liquidity?: bigint }) {
  return new FakePrivacyOperations({
    balances: { [STRK]: balance },
    poolConfig: { noteMaturityBlocks: 0 },
    ...(vault ? { vault } : {}),
  });
}

async function strkTotal(fake: FakePrivacyOperations): Promise<bigint> {
  const [entry] = await fake.balances([STRK]);
  return entry?.total ?? 0n;
}

describe('the demo Vault', () => {
  it('supplies from the shielded balance and holds the shares on the demo stand-in address', async () => {
    const fake = fresh();
    await expect(fake.vaultPosition()).resolves.toEqual({ token: STRK, shares: 0n, assets: 0n, redeemable: 0n });

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

    expect(await strkTotal(fake)).toBe(100n * ONE - 51n * ONE - POOL_FEE);
    await expect(fake.vaultPosition()).resolves.toEqual({ token: STRK, shares: 50n * ONE, assets: 51n * ONE, redeemable: 51n * ONE });
    expect(fake.vaultSubmitted).toEqual([{ kind: 'supply', token: STRK, amount: 51n * ONE }]);
  });

  it('redeems part of a position back into the pool, burning shares rounded up', async () => {
    const fake = fresh(20n * ONE, { shares: 50n * ONE });
    await (await fake.prepareVaultRedeem(10n * ONE)).confirm({ feeCeiling: POOL_FEE });
    expect(await strkTotal(fake)).toBe(20n * ONE - POOL_FEE + 10n * ONE);
    const position = await fake.vaultPosition();
    // 10 STRK at 51 per 50 burns ceil(10 * 50 / 51) shares.
    expect(position.shares).toBe(50n * ONE - (10n * ONE * 50n + 50n) / 51n);
  });

  it('redeems everything for “all”, and then holds nothing', async () => {
    const fake = fresh(20n * ONE, { shares: 50n * ONE });
    const batch = await fake.prepareVaultRedeem('all');
    expect(batch.action).toEqual({ kind: 'redeem', token: STRK, amount: 51n * ONE, all: true });
    await batch.confirm({ feeCeiling: POOL_FEE });
    expect(await strkTotal(fake)).toBe(20n * ONE - POOL_FEE + 51n * ONE);
    await expect(fake.vaultPosition()).resolves.toMatchObject({ shares: 0n, assets: 0n });
    await expect(fake.prepareVaultRedeem('all')).rejects.toMatchObject({ kind: 'unknown' });
  });

  it('keeps what the demo vault can pay out now as the redeemable limit', async () => {
    const fake = fresh(20n * ONE, { shares: 50n * ONE, liquidity: 5n * ONE });
    await expect(fake.vaultPosition()).resolves.toMatchObject({ redeemable: 5n * ONE });
    await expect(fake.prepareVaultRedeem(6n * ONE)).rejects.toMatchObject({ kind: 'unknown' });
    await expect(fake.prepareVaultRedeem('all')).rejects.toMatchObject({ kind: 'unknown' });
    await expect(fake.prepareVaultRedeem(5n * ONE)).resolves.toMatchObject({ action: { amount: 5n * ONE } });
  });

  it('needs the pool fee in the shielded balance on either leg, as the wallet does', async () => {
    await expect(fresh(50n * ONE).prepareVaultSupply(STRK, 45n * ONE)).rejects.toMatchObject({ kind: 'insufficient-balance' });
    await expect(fresh(ONE, { shares: 50n * ONE }).prepareVaultRedeem('all')).rejects.toMatchObject({ kind: 'insufficient-balance' });
  });

  it('reports the adapter’s stages, in its order, with no amount in any of them', async () => {
    const fake = fresh();
    const stages: VaultStage[] = [];
    const onStage = (stage: VaultStage) => stages.push(stage);
    await fake.vaultPosition({ onStage });
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
    await expect(fake.vaultPosition({ onStage: (stage) => stages.push(stage) })).rejects.toMatchObject({
      kind: 'shadow-accounts-unsupported',
    });
    expect(stages).toEqual([{ stage: 'capability', supported: false }]);
    await expect(fake.prepareVaultSupply(STRK, ONE)).rejects.toMatchObject({ kind: 'shadow-accounts-unsupported' });
  });

  it('answers an unregistered account as not registered, with the wallet’s 118', async () => {
    const fake = new FakePrivacyOperations({ capability: { registration: 'unregistered' } });
    const stages: VaultStage[] = [];
    await expect(fake.vaultPosition({ onStage: (stage) => stages.push(stage) })).rejects.toMatchObject({ kind: 'not-registered' });
    expect(stages.at(-1)).toEqual({ stage: 'commitment', ok: false, code: 118 });
  });

  it('lends STRK only, and refuses a spent or discarded batch', async () => {
    const fake = fresh();
    await expect(fake.prepareVaultSupply('0x123', ONE)).rejects.toMatchObject({ kind: 'unknown' });
    const batch = await fake.prepareVaultSupply(STRK, ONE);
    await batch.confirm({ feeCeiling: POOL_FEE });
    await expect(batch.confirm({ feeCeiling: POOL_FEE })).rejects.toMatchObject({ kind: 'unknown' });
    const discarded = await fake.prepareVaultSupply(STRK, ONE);
    discarded.discard();
    await expect(discarded.confirm({ feeCeiling: POOL_FEE })).rejects.toMatchObject({ kind: 'unknown' });
    await expect((await fake.prepareVaultSupply(STRK, ONE)).confirm({ feeCeiling: POOL_FEE - 1n })).rejects.toMatchObject({ kind: 'unknown' });
  });

  it('injects faults on the Vault calls alone', async () => {
    const fake = fresh();
    fake.injectFault({ kind: 'user-rejected', on: 'vaultConfirm' });
    const batch = await fake.prepareVaultSupply(STRK, ONE);
    const stages: VaultStage[] = [];
    await expect(batch.confirm({ feeCeiling: POOL_FEE, onStage: (stage) => stages.push(stage) })).rejects.toMatchObject({ kind: 'user-rejected' });
    expect(stages).toEqual([{ stage: 'submit', ok: false, code: 113 }]);
    expect(await strkTotal(fake)).toBe(100n * ONE);
  });

  it('is deterministic: two runs of the same script are identical', async () => {
    const run = async () => {
      const fake = fresh();
      const receipt = await (await fake.prepareVaultSupply(STRK, 3n * ONE)).confirm({ feeCeiling: POOL_FEE });
      return { receipt, position: await fake.vaultPosition(), balance: await strkTotal(fake) };
    };
    expect(await run()).toEqual(await run());
  });
});
