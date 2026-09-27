import { describe, expect, it, vi } from 'vitest';
import * as privacy from '../index.js';
import type { PoolConfig } from '../operations.js';
import { PrivacyError, type Address } from '../types.js';
import { BackendPrivacyClient } from './backend-client.js';
import {
  RESERVE_SHIELD_FLOOR,
  RESERVE_SHIELD_GAS_ALLOWANCE,
  ReservePublicShieldPlanner,
  type ReservePublicShieldPlannerOptions,
} from './reserve-shield-planner.js';

const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const ETH = '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7';
const ACCOUNT = '0x0abc';
const ONE_STRK = 10n ** 18n;
const STARK_FIELD_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;
const MAX_U256 = (1n << 256n) - 1n;

function config(overrides: Partial<Record<keyof PoolConfig, unknown>> = {}): PoolConfig {
  return {
    feeAmount: 6n * ONE_STRK,
    feeToken: STRK,
    proofValidityBlocks: 450,
    noteMaturityBlocks: 10,
    ...overrides,
  } as PoolConfig;
}

function build({
  read = async () => config(),
  account = () => ACCOUNT,
}: {
  read?: (signal?: AbortSignal) => Promise<PoolConfig>;
  account?: ReservePublicShieldPlannerOptions['readAccount'];
} = {}) {
  const pool = { config: vi.fn(read) };
  const readAccount = vi.fn(account);
  return { planner: new ReservePublicShieldPlanner({ pool, readAccount }), pool, readAccount };
}

function input(available: bigint, extra: Record<string, unknown> = {}) {
  return { token: STRK, available, expectedRecipient: ACCOUNT, ...extra };
}

describe('ReservePublicShieldPlanner (D-061)', () => {
  it('reserves 10 STRK at the live 6 STRK fee and shields the rest', async () => {
    const { planner } = build();

    await expect(planner.planMax(input(100n * ONE_STRK))).resolves.toEqual({
      token: '0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
      recipient: '0xabc',
      available: 100n * ONE_STRK,
      amountToShield: 90n * ONE_STRK,
      poolFee: 6n * ONE_STRK,
      gasEstimate: 4n * ONE_STRK,
      plannedReserve: 10n * ONE_STRK,
    });
  });

  it.each([
    ['a zero governance fee', 0n],
    ['a small fee', ONE_STRK],
    ['the crossover fee', RESERVE_SHIELD_FLOOR - RESERVE_SHIELD_GAS_ALLOWANCE],
  ])('keeps the 10 STRK floor for %s, leaving the rest of the floor for gas', async (_name, fee) => {
    const { planner } = build({ read: async () => config({ feeAmount: fee }) });

    const plan = await planner.planMax(input(50n * ONE_STRK));

    expect(plan.plannedReserve).toBe(RESERVE_SHIELD_FLOOR);
    expect(plan.poolFee).toBe(fee);
    expect(plan.gasEstimate).toBe(RESERVE_SHIELD_FLOOR - fee);
    expect(plan.gasEstimate >= RESERVE_SHIELD_GAS_ALLOWANCE).toBe(true);
    expect(plan.amountToShield).toBe(50n * ONE_STRK - RESERVE_SHIELD_FLOOR);
  });

  it.each([
    ['one wei past the crossover', RESERVE_SHIELD_FLOOR - RESERVE_SHIELD_GAS_ALLOWANCE + 1n],
    ['a 9 STRK fee', 9n * ONE_STRK],
    ['a 25 STRK fee', 25n * ONE_STRK],
  ])('reserves the live fee plus the gas allowance once that exceeds 10 STRK: %s', async (_name, fee) => {
    const { planner } = build({ read: async () => config({ feeAmount: fee }) });

    const plan = await planner.planMax(input(100n * ONE_STRK));

    expect(plan.plannedReserve).toBe(fee + RESERVE_SHIELD_GAS_ALLOWANCE);
    expect(plan.plannedReserve > RESERVE_SHIELD_FLOOR).toBe(true);
    expect(plan.gasEstimate).toBe(RESERVE_SHIELD_GAS_ALLOWANCE);
    expect(plan.amountToShield).toBe(100n * ONE_STRK - fee - RESERVE_SHIELD_GAS_ALLOWANCE);
  });

  it('uses a fixed, positive gas allowance no larger than the floor', () => {
    expect(RESERVE_SHIELD_FLOOR).toBe(10n * ONE_STRK);
    expect(RESERVE_SHIELD_GAS_ALLOWANCE > 0n).toBe(true);
    expect(RESERVE_SHIELD_GAS_ALLOWANCE <= RESERVE_SHIELD_FLOOR).toBe(true);
  });

  it.each([
    10n * ONE_STRK + 1n,
    12n * ONE_STRK,
    1_000n * ONE_STRK + 7n,
    STARK_FIELD_PRIME - 1n + 10n * ONE_STRK,
  ])('shields exactly available minus the reserve and keeps the D-043 arithmetic (%s)', async (available) => {
    const { planner } = build();

    const plan = await planner.planMax(input(available));

    expect(plan.amountToShield).toBe(available - plan.plannedReserve);
    expect(plan.amountToShield + plan.plannedReserve).toBe(plan.available);
    expect(plan.plannedReserve).toBe(plan.poolFee + plan.gasEstimate);
    expect(plan.amountToShield > 0n).toBe(true);
    expect(plan.gasEstimate > 0n).toBe(true);
  });

  it('reads the fee live on every plan with the caller signal, so a fee rise reaches the next plan', async () => {
    let fee = 6n * ONE_STRK;
    const { planner, pool } = build({ read: async () => config({ feeAmount: fee }) });
    const controller = new AbortController();

    const before = await planner.planMax(input(100n * ONE_STRK), controller.signal);
    fee = 8n * ONE_STRK;
    const after = await planner.planMax(input(100n * ONE_STRK), controller.signal);

    expect(pool.config).toHaveBeenCalledTimes(2);
    expect(pool.config).toHaveBeenNthCalledWith(1, controller.signal);
    expect(before.plannedReserve).toBe(10n * ONE_STRK);
    expect(after.plannedReserve).toBe(8n * ONE_STRK + RESERVE_SHIELD_GAS_ALLOWANCE);
    expect(after.amountToShield < before.amountToShield).toBe(true);
  });

  it('publishes a frozen plan with exactly the sanitized fields', async () => {
    const { planner } = build();

    const plan = await planner.planMax(input(100n * ONE_STRK));

    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.keys(plan).sort()).toEqual(
      ['amountToShield', 'available', 'gasEstimate', 'plannedReserve', 'poolFee', 'recipient', 'token'],
    );
    expect(Reflect.set(plan, 'amountToShield', plan.available)).toBe(false);
    expect(plan.amountToShield).toBe(90n * ONE_STRK);
  });

  it('reads the fee through the backend-proxied pool-config route', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      feeAmount: '6000000000000000000',
      feeToken: STRK,
      proofValidityBlocks: 450,
      noteMaturityBlocks: 10,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const planner = new ReservePublicShieldPlanner({
      pool: new BackendPrivacyClient('/api', fetcher),
      readAccount: () => ACCOUNT,
    });

    const plan = await planner.planMax(input(30n * ONE_STRK));

    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledWith('/api/v1/rpc/pool-config', expect.objectContaining({ method: 'POST' }));
    expect(plan).toMatchObject({ poolFee: 6n * ONE_STRK, plannedReserve: 10n * ONE_STRK, amountToShield: 20n * ONE_STRK });
  });

  it('accepts a recipient spelled differently and falls back to the live account without one', async () => {
    const { planner } = build({ account: async () => '0x0000abc' });

    await expect(planner.planMax(input(20n * ONE_STRK, { expectedRecipient: '0xABC' })))
      .resolves.toMatchObject({ recipient: '0xabc' });
    await expect(planner.planMax({ token: STRK, available: 20n * ONE_STRK }))
      .resolves.toMatchObject({ recipient: '0xabc' });
  });
});

describe('ReservePublicShieldPlanner fails closed', () => {
  it('on a failed fee read, keeping the read failure retryable', async () => {
    const offline = build({ read: async () => { throw new TypeError('fetch failed'); } });
    await expect(offline.planner.planMax(input(100n * ONE_STRK))).rejects.toMatchObject({ kind: 'unreachable' });

    const typed = new PrivacyError('unreachable', 'The private service could not be reached.');
    const backend = build({ read: async () => { throw typed; } });
    await expect(backend.planner.planMax(input(100n * ONE_STRK))).rejects.toBe(typed);

    const unavailable = new ReservePublicShieldPlanner({
      pool: new BackendPrivacyClient('/api', async () => new Response(JSON.stringify({ message: 'down' }), { status: 503 })),
      readAccount: () => ACCOUNT,
    });
    await expect(unavailable.planMax(input(100n * ONE_STRK))).rejects.toMatchObject({ kind: 'unreachable' });
  });

  it.each([
    ['ETH', ETH],
    ['a malformed felt', '0x'],
    ['the field prime', `0x${STARK_FIELD_PRIME.toString(16)}`],
    ['a decimal spelling of STRK', BigInt(STRK).toString()],
    ['a non-string', 42],
  ])('when the pool fee token is %s', async (_name, feeToken) => {
    const { planner } = build({ read: async () => config({ feeToken }) });
    await expect(planner.planMax(input(100n * ONE_STRK))).rejects.toMatchObject({ kind: 'unknown' });
  });

  it.each([
    ['negative', -1n],
    ['above uint256', MAX_U256 + 1n],
    ['a number', 6e18],
    ['a decimal string', '6000000000000000000'],
    ['missing', undefined],
  ])('when the pool fee is %s', async (_name, feeAmount) => {
    const read = feeAmount === undefined
      ? async () => ({ feeToken: STRK, proofValidityBlocks: 450, noteMaturityBlocks: 10 }) as unknown as PoolConfig
      : async () => config({ feeAmount });
    const { planner } = build({ read });
    await expect(planner.planMax(input(100n * ONE_STRK))).rejects.toMatchObject({ kind: 'unknown' });
  });

  it.each([
    ['null', null],
    ['an array', []],
    ['a string', 'config'],
  ])('when the pool configuration is %s', async (_name, value) => {
    const { planner } = build({ read: async () => value as unknown as PoolConfig });
    await expect(planner.planMax(input(100n * ONE_STRK))).rejects.toMatchObject({ kind: 'unknown' });
  });

  it('without invoking an accessor-backed fee', async () => {
    const getter = vi.fn(() => 0n);
    const hostile = { feeToken: STRK, proofValidityBlocks: 450, noteMaturityBlocks: 10 };
    Object.defineProperty(hostile, 'feeAmount', { enumerable: true, get: getter });
    const { planner } = build({ read: async () => hostile as unknown as PoolConfig });

    await expect(planner.planMax(input(100n * ONE_STRK))).rejects.toMatchObject({ kind: 'unknown' });
    expect(getter).not.toHaveBeenCalled();
  });

  it.each([
    ['ETH', ETH],
    ['a malformed felt', '0xnot-hex'],
    ['a value over 64 hex digits', `0x${'1'.repeat(65)}`],
    ['the field prime', `0x${STARK_FIELD_PRIME.toString(16)}`],
    ['missing', undefined],
  ])('when the requested denomination is %s, before any read', async (_name, token) => {
    const { planner, pool, readAccount } = build();
    await expect(planner.planMax(input(100n * ONE_STRK, { token }))).rejects.toMatchObject({ kind: 'unknown' });
    expect(pool.config).not.toHaveBeenCalled();
    expect(readAccount).not.toHaveBeenCalled();
  });

  it.each([
    ['zero', 0n],
    ['negative', -1n],
    ['above uint256', MAX_U256 + 1n],
    ['a number', 100],
  ])('when the available amount is %s', async (_name, available) => {
    const { planner, pool } = build();
    await expect(planner.planMax(input(available as bigint))).rejects.toMatchObject({ kind: 'unknown' });
    expect(pool.config).not.toHaveBeenCalled();
  });

  it('when the remainder after the reserve is not positive', async () => {
    const { planner } = build();
    await expect(planner.planMax(input(RESERVE_SHIELD_FLOOR))).rejects.toMatchObject({ kind: 'unknown' });
    await expect(planner.planMax(input(RESERVE_SHIELD_FLOOR - 1n))).rejects.toMatchObject({ kind: 'unknown' });
    await expect(planner.planMax(input(1n))).rejects.toMatchObject({ kind: 'unknown' });
    await expect(planner.planMax(input(RESERVE_SHIELD_FLOOR + 1n))).resolves.toMatchObject({ amountToShield: 1n });
  });

  it('when a fee rise swallows what the floor would have left to shield', async () => {
    const available = 12n * ONE_STRK;
    let fee = 6n * ONE_STRK;
    const { planner } = build({ read: async () => config({ feeAmount: fee }) });

    await expect(planner.planMax(input(available))).resolves.toMatchObject({ amountToShield: 2n * ONE_STRK });
    fee = available - RESERVE_SHIELD_GAS_ALLOWANCE;
    await expect(planner.planMax(input(available))).rejects.toMatchObject({ kind: 'unknown' });
  });

  it('when the shield would not fit a Stark field element', async () => {
    const { planner } = build();
    await expect(planner.planMax(input(MAX_U256))).rejects.toMatchObject({ kind: 'unknown' });
    await expect(planner.planMax(input(STARK_FIELD_PRIME + RESERVE_SHIELD_FLOOR))).rejects.toMatchObject({ kind: 'unknown' });
  });

  it('when the reserve arithmetic would overflow uint256', async () => {
    for (const feeAmount of [MAX_U256, MAX_U256 - RESERVE_SHIELD_GAS_ALLOWANCE + 1n]) {
      const { planner } = build({ read: async () => config({ feeAmount }) });
      await expect(planner.planMax(input(MAX_U256))).rejects.toMatchObject({ kind: 'unknown' });
    }
  });

  it('on abort before, during and after the fee read', async () => {
    const early = new AbortController();
    early.abort();
    const before = build();
    await expect(before.planner.planMax(input(100n * ONE_STRK), early.signal)).rejects.toMatchObject({ kind: 'user-rejected' });
    expect(before.pool.config).not.toHaveBeenCalled();
    expect(before.readAccount).not.toHaveBeenCalled();

    const during = new AbortController();
    const ignoring = build({ read: async () => { during.abort(); return config(); } });
    await expect(ignoring.planner.planMax(input(100n * ONE_STRK), during.signal)).rejects.toMatchObject({ kind: 'user-rejected' });

    const rejecting = new AbortController();
    const honouring = build({
      read: async () => {
        rejecting.abort();
        throw new DOMException('The operation was aborted.', 'AbortError');
      },
    });
    await expect(honouring.planner.planMax(input(100n * ONE_STRK), rejecting.signal)).rejects.toMatchObject({ kind: 'user-rejected' });

    const late = new AbortController();
    let reads = 0;
    const afterRead = build({
      account: () => {
        reads += 1;
        if (reads === 2) late.abort();
        return ACCOUNT;
      },
    });
    await expect(afterRead.planner.planMax(input(100n * ONE_STRK), late.signal)).rejects.toMatchObject({ kind: 'user-rejected' });
  });

  it.each([
    ['no account', null],
    ['a malformed account', 'abc'],
    ['a zero account', '0x0'],
    ['the field prime', `0x${STARK_FIELD_PRIME.toString(16)}`],
  ])('with %s connected', async (_name, account) => {
    const { planner } = build({ account: () => account as Address | null });
    await expect(planner.planMax(input(100n * ONE_STRK))).rejects.toMatchObject({ kind: 'unknown' });
  });

  it('when the connected account is not the expected recipient', async () => {
    const { planner, pool } = build({ account: () => '0xdef' });
    await expect(planner.planMax(input(100n * ONE_STRK))).rejects.toMatchObject({ kind: 'unknown' });
    expect(pool.config).not.toHaveBeenCalled();
    await expect(planner.planMax(input(100n * ONE_STRK, { expectedRecipient: 'not-an-address' })))
      .rejects.toMatchObject({ kind: 'unknown' });
  });

  it('when the account cannot be read', async () => {
    const { planner } = build({ account: () => { throw new Error('wallet gone'); } });
    await expect(planner.planMax(input(100n * ONE_STRK))).rejects.toMatchObject({ kind: 'unknown' });
  });

  it('when the account changes while the fee is read', async () => {
    let account = ACCOUNT;
    const { planner } = build({
      read: async () => {
        account = '0xdef';
        return config();
      },
      account: () => account,
    });
    await expect(planner.planMax({ token: STRK, available: 100n * ONE_STRK })).rejects.toMatchObject({ kind: 'unknown' });
  });

  it('on an invalid composition', () => {
    const readAccount = () => ACCOUNT;
    for (const options of [
      null,
      {},
      { readAccount },
      { pool: null, readAccount },
      { pool: {}, readAccount },
      { pool: { config: 'not a function' }, readAccount },
      { pool: { config: async () => config() } },
      { pool: { config: async () => config() }, readAccount: ACCOUNT },
    ]) {
      expect(() => new ReservePublicShieldPlanner(options as unknown as ReservePublicShieldPlannerOptions)).toThrow(PrivacyError);
    }
  });
});

describe('package export', () => {
  it('exports the production reserve planner the way the fake is exported, and still no Ready fee claim', () => {
    const runtime = privacy as unknown as Record<string, unknown>;
    expect(privacy.ReservePublicShieldPlanner).toBe(ReservePublicShieldPlanner);
    expect(privacy.RESERVE_SHIELD_FLOOR).toBe(RESERVE_SHIELD_FLOOR);
    expect(privacy.RESERVE_SHIELD_GAS_ALLOWANCE).toBe(RESERVE_SHIELD_GAS_ALLOWANCE);
    expect(runtime.createReadyPublicShieldPlanner).toBeUndefined();
    expect(runtime.WalletPublicShieldAccount).toBeUndefined();
  });
});
