import { describe, expect, it } from 'vitest';
import * as privacy from '../index.js';
import { FakePublicShieldPlanner } from './public-shield.js';

const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';

function input(available: bigint) {
  return { token: STRK, available, expectedRecipient: '0xabc' };
}

describe('FakePublicShieldPlanner', () => {
  it('uses explicit deterministic estimates and returns the exact reserve arithmetic', async () => {
    const planner = new FakePublicShieldPlanner({
      token: STRK,
      recipient: '0x0abc',
      poolFee: 3n,
      gasEstimate: [1n, 2n],
    });

    await expect(planner.planMax(input(100n))).resolves.toMatchObject({
      token: '0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
      recipient: '0xabc',
      available: 100n,
      amountToShield: 96n,
      poolFee: 3n,
      gasEstimate: 1n,
      plannedReserve: 4n,
    });
    await expect(planner.planMax(input(100n))).resolves.toMatchObject({
      amountToShield: 95n,
      plannedReserve: 5n,
    });
  });

  it('publishes an immutable public shield plan', async () => {
    const planner = new FakePublicShieldPlanner({
      token: STRK,
      recipient: '0xabc',
      poolFee: 3n,
      gasEstimate: 1n,
    });

    const plan = await planner.planMax(input(100n));

    expect(Object.isFrozen(plan)).toBe(true);
    expect(Reflect.set(plan, 'amountToShield', 100n)).toBe(false);
    expect(plan.amountToShield).toBe(96n);
    expect(plan.plannedReserve).toBe(4n);
  });

  it('fails closed for abort, account mismatch, non-positive remainder and invalid token', async () => {
    const planner = new FakePublicShieldPlanner({ token: STRK, recipient: '0xabc', poolFee: 3n, gasEstimate: 1n });
    const controller = new AbortController();
    controller.abort();
    await expect(planner.planMax(input(100n), controller.signal)).rejects.toMatchObject({ kind: 'user-rejected' });
    await expect(planner.planMax({ ...input(100n), expectedRecipient: '0xdef' })).rejects.toMatchObject({ kind: 'unknown' });
    await expect(planner.planMax({ ...input(100n), token: '0x123' })).rejects.toMatchObject({ kind: 'unknown' });
    await expect(planner.planMax(input(4n))).rejects.toMatchObject({ kind: 'unknown' });
    await expect(planner.planMax({ ...input(100n), token: '0x' + 'f'.repeat(64) })).rejects.toMatchObject({ kind: 'unknown' });
  });

  it('rejects malformed and overflowing fake configuration', () => {
    expect(() => new FakePublicShieldPlanner({ token: '0x' + 'f'.repeat(64), recipient: '0xabc', poolFee: 1n, gasEstimate: 1n })).toThrow();
    expect(() => new FakePublicShieldPlanner({ token: STRK, recipient: '0x' + 'f'.repeat(64), poolFee: 1n, gasEstimate: 1n })).toThrow();
    expect(() => new FakePublicShieldPlanner({ token: STRK, recipient: '0xabc', poolFee: -1n, gasEstimate: 1n })).toThrow();
    expect(() => new FakePublicShieldPlanner({ token: STRK, recipient: '0xabc', poolFee: 1n, gasEstimate: 1n << 256n })).toThrow();
    expect(() => new FakePublicShieldPlanner({ token: STRK, recipient: '0xabc', poolFee: 1n, gasEstimate: 0n })).toThrow();
    expect(() => new FakePublicShieldPlanner({ token: STRK, recipient: '0xabc', poolFee: 0n, gasEstimate: 1n })).not.toThrow();
  });

  it('rejects uint256 overflow in reserve arithmetic', async () => {
    const planner = new FakePublicShieldPlanner({
      token: STRK,
      recipient: '0xabc',
      poolFee: (1n << 256n) - 1n,
      gasEstimate: 1n,
    });
    await expect(planner.planMax(input((1n << 256n) - 1n))).rejects.toMatchObject({ kind: 'unknown' });
  });

  it('does not consume the next estimate when a plan is rejected', async () => {
    const planner = new FakePublicShieldPlanner({
      token: STRK,
      recipient: '0xabc',
      poolFee: 3n,
      gasEstimate: [1n, 2n],
    });

    await expect(planner.planMax(input(4n))).rejects.toMatchObject({ kind: 'unknown' });
    await expect(planner.planMax(input(100n))).resolves.toMatchObject({
      gasEstimate: 1n,
      plannedReserve: 4n,
      amountToShield: 96n,
    });
  });

  it('accepts a zero pool fee while requiring a positive gas reserve', async () => {
    const planner = new FakePublicShieldPlanner({ token: STRK, recipient: '0xabc', poolFee: 0n, gasEstimate: 1n });
    await expect(planner.planMax(input(100n))).resolves.toMatchObject({
      poolFee: 0n,
      gasEstimate: 1n,
      plannedReserve: 1n,
      amountToShield: 99n,
    });
  });
});

describe('current production composition', () => {
  it('does not claim a Ready public-shield planner while the fee path is unproven', () => {
    const runtime = privacy as unknown as Record<string, unknown>;
    expect(runtime.createReadyPublicShieldPlanner).toBeUndefined();
    expect(runtime.WalletPublicShieldAccount).toBeUndefined();
  });
});
