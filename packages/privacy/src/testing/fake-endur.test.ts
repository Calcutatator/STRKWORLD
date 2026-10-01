import { describe, expect, it } from 'vitest';
import { DEMO_ENDUR_STAND_IN, DEMO_VAULT_STAND_IN, FakePrivacyOperations } from './fake.js';
import { ENDUR_OBSERVED_CLAIM_DELAY_SECONDS, ENDUR_XSTRK, ENDUR_XSTRK_ASSET } from '../endur.js';
import type { VaultStage } from '../operations.js';

/**
 * Demo Endur unstaking (D-085). The fake unstakes at the stake fixture's DEMO
 * RATE inverted (5 STRK per 4 xSTRK) on a fixed demo clock, so the demo is
 * deterministic; neither is Endur's. The pool fee comes out of the STRK
 * balance on both legs.
 */

const STRK = ENDUR_XSTRK_ASSET;
const XSTRK = ENDUR_XSTRK;
const ONE = 10n ** 18n;
const POOL_FEE = 6n * ONE;

function fresh(config: ConstructorParameters<typeof FakePrivacyOperations>[0] = {}) {
  return new FakePrivacyOperations({
    balances: { [STRK]: 20n * ONE, [XSTRK]: 8n * ONE },
    poolConfig: { noteMaturityBlocks: 0 },
    ...config,
  });
}

async function total(fake: FakePrivacyOperations, token: string): Promise<bigint> {
  const [entry] = await fake.balances([token]);
  return entry?.total ?? 0n;
}

describe('demo Endur unstaking', () => {
  it('starts with nothing waiting, on its own stand-in, not the Vault one', async () => {
    const position = await fresh().endurUnstakePosition();
    expect(position).toMatchObject({ standIn: DEMO_ENDUR_STAND_IN, requests: [], strkHeld: 0n, xstrkHeld: 0n, unlisted: 0 });
    expect(DEMO_ENDUR_STAND_IN).not.toBe(DEMO_VAULT_STAND_IN);
  });

  it('requests, waits the queue delay, then claims the STRK back into the pool', async () => {
    const fake = fresh();
    const stages: VaultStage[] = [];
    const request = await fake.prepareEndurUnstake(4n * ONE, { onStage: (stage) => stages.push(stage) });
    expect(request.action).toEqual({ kind: 'request', shares: 4n * ONE, leftover: 0n });
    expect(stages.map(({ stage }) => stage)).toEqual(['capability', 'commitment', 'address', 'position']);
    await request.confirm({ feeCeiling: POOL_FEE });
    expect(await total(fake, XSTRK)).toBe(4n * ONE);
    expect(await total(fake, STRK)).toBe(14n * ONE);

    const waiting = await fake.endurUnstakePosition();
    expect(waiting.requests).toHaveLength(1);
    expect(waiting.requests[0]).toMatchObject({ assets: 5n * ONE, shares: 4n * ONE, status: 'waiting', secondsLeft: ENDUR_OBSERVED_CLAIM_DELAY_SECONDS });
    await expect(fake.prepareEndurClaim()).rejects.toThrow('Nothing has finished unstaking yet.');

    fake.advanceEndurClock(ENDUR_OBSERVED_CLAIM_DELAY_SECONDS);
    const ready = await fake.endurUnstakePosition();
    expect(ready.requests[0]).toMatchObject({ status: 'ready', secondsLeft: 0 });

    const claim = await fake.prepareEndurClaim();
    expect(claim.action).toEqual({ kind: 'claim', requestIds: [ready.requests[0]!.requestId], owed: 5n * ONE, held: 0n });
    await claim.confirm({ feeCeiling: POOL_FEE });
    expect(await total(fake, STRK)).toBe(13n * ONE);
    expect((await fake.endurUnstakePosition()).requests).toEqual([]);
    expect(fake.endurSubmitted.map(({ kind }) => kind)).toEqual(['request', 'claim']);
  });

  it('marks a past-due unfunded request as awaiting funds, and claims it only once funded', async () => {
    const fake = fresh({ endur: { requests: [{ assets: 3n * ONE, shares: 2n * ONE, claimableInSeconds: -60, funded: false }] } });
    expect((await fake.endurUnstakePosition()).requests[0]).toMatchObject({ status: 'awaiting-funds', secondsLeft: 0 });
    await expect(fake.prepareEndurClaim()).rejects.toThrow('Nothing has finished unstaking yet.');
    fake.fundEndurRequests();
    expect((await fake.endurUnstakePosition()).requests[0]).toMatchObject({ status: 'ready' });
    expect((await fake.prepareEndurClaim()).action).toMatchObject({ kind: 'claim', owed: 3n * ONE });
  });

  it('collects STRK demo Endur already paid to the stand-in', async () => {
    const fake = fresh({ endur: { requests: [{ assets: 3n * ONE, shares: 2n * ONE, claimableInSeconds: 0 }] } });
    fake.payReadyEndurRequests();
    const paid = await fake.endurUnstakePosition();
    expect(paid).toMatchObject({ requests: [], strkHeld: 3n * ONE });
    const claim = await fake.prepareEndurClaim();
    expect(claim.action).toEqual({ kind: 'claim', requestIds: [], owed: 0n, held: 3n * ONE });
    await claim.confirm({ feeCeiling: POOL_FEE });
    expect(await total(fake, STRK)).toBe(17n * ONE);
  });

  it('returns xSTRK left on the stand-in with the next request', async () => {
    const fake = fresh({ endur: { xstrkHeld: ONE } });
    const request = await fake.prepareEndurUnstake(2n * ONE);
    expect(request.action).toEqual({ kind: 'request', shares: 2n * ONE, leftover: ONE });
    await request.confirm({ feeCeiling: POOL_FEE });
    expect(await total(fake, XSTRK)).toBe(7n * ONE);
  });

  it('refuses more xSTRK than the pool holds, and a wallet without shadow accounts', async () => {
    await expect(fresh().prepareEndurUnstake(9n * ONE)).rejects.toMatchObject({ kind: 'insufficient-balance' });
    const unsupported = fresh({ capability: { supportsShadowAccounts: false } });
    await expect(unsupported.endurUnstakePosition()).rejects.toMatchObject({ kind: 'shadow-accounts-unsupported' });
  });
});
