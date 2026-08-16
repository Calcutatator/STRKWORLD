import { describe, expect, it } from 'vitest';
import { FakePrivacyOperations } from './fake.js';
import { PrivacyError } from '../types.js';
import type { BatchWarning } from '../operations.js';

const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const ALICE = '0x0111';
const BOB = '0x0222';
const SIX_STRK = 6_000000000000000000n;
const CEILING = 10_000000000000000000n;

function has(warnings: readonly BatchWarning[], kind: BatchWarning['kind']) {
  return warnings.some((w) => w.kind === kind);
}

function fresh(balance = 100n * 10n ** 18n) {
  return new FakePrivacyOperations({
    balances: { [STRK]: balance },
    registered: [ALICE, BOB],
  });
}

describe('the fee comes out of the balance being spent', () => {
  it('rejects a spend that cannot also cover the pool fee', async () => {
    // Exactly enough for the transfer, nothing left for the 6 STRK fee.
    const ops = new FakePrivacyOperations({ balances: { [STRK]: 10n ** 18n }, registered: [BOB] });
    await expect(
      ops.prepare([{ kind: 'transfer', token: STRK, amount: 10n ** 18n, recipient: BOB }]),
    ).rejects.toThrow(PrivacyError);
  });

  it('warns when confirming would strand the player below a future fee', async () => {
    const ops = new FakePrivacyOperations({
      balances: { [STRK]: SIX_STRK + SIX_STRK + 10n ** 18n },
      registered: [BOB],
    });
    const batch = await ops.prepare([
      { kind: 'transfer', token: STRK, amount: 10n ** 18n + SIX_STRK, recipient: BOB },
    ]);
    expect(has(batch.warnings, 'leaves-below-fee')).toBe(true);
  });
});

describe('shielded funds are not immediately spendable', () => {
  it('holds a deposit as maturing until enough blocks pass', async () => {
    const ops = fresh(0n);
    const batch = await ops.prepare([{ kind: 'shield', token: STRK, amount: 50n * 10n ** 18n }]);
    await batch.confirm({ feeCeiling: CEILING });

    let [strk] = await ops.balances([STRK]);
    expect(strk!.spendable).toBe(0n);
    expect(strk!.maturing).toBe(50n * 10n ** 18n);

    ops.advanceBlocks(9);
    [strk] = await ops.balances([STRK]);
    expect(strk!.spendable).toBe(0n);

    ops.advanceBlocks(1); // 10 blocks — matured
    [strk] = await ops.balances([STRK]);
    expect(strk!.spendable).toBe(50n * 10n ** 18n);
    expect(strk!.maturing).toBe(0n);
  });

  it('warns that funds are still maturing', async () => {
    const ops = fresh();
    await (await ops.prepare([{ kind: 'shield', token: STRK, amount: 1n }])).confirm({
      feeCeiling: CEILING,
    });
    const next = await ops.prepare([
      { kind: 'transfer', token: STRK, amount: 10n ** 18n, recipient: BOB },
    ]);
    expect(has(next.warnings, 'funds-maturing')).toBe(true);
  });
});

describe('a shield is never bundled with what it funds', () => {
  it('rejects the mixed batch so the shell sequences two explicit operations', async () => {
    const ops = fresh();
    await expect(ops.prepare([
      { kind: 'shield', token: STRK, amount: 10n * 10n ** 18n },
      { kind: 'transfer', token: STRK, amount: 10n ** 18n, recipient: BOB },
    ])).rejects.toMatchObject({ kind: 'privacy-leak' });
  });

  it('matches production by rejecting mixed private route kinds', async () => {
    const ops = fresh();
    await expect(ops.prepare([
      { kind: 'transfer', token: STRK, amount: 10n ** 18n, recipient: BOB },
      { kind: 'unshield', token: STRK, amount: 10n ** 18n, recipient: ALICE },
    ])).rejects.toThrow(/one approved route/i);
  });

  it('models the shipped wallet source as one batched shield action', async () => {
    const ops = fresh();
    const batch = await ops.prepare([{ kind: 'shield', token: STRK, amount: 10n ** 18n }]);
    expect(batch.promptCount).toBe(1);
  });

  it('needs one prompt for a batch of private-side actions', async () => {
    const ops = fresh();
    const batch = await ops.prepare([
      { kind: 'transfer', token: STRK, amount: 10n ** 18n, recipient: ALICE },
      { kind: 'transfer', token: STRK, amount: 10n ** 18n, recipient: BOB },
    ]);
    expect(batch.promptCount).toBe(1);
  });
});

describe('the fee can move between prepare and confirm', () => {
  it('refuses to sign when the fee breaches the ceiling', async () => {
    const ops = fresh();
    const batch = await ops.prepare([
      { kind: 'transfer', token: STRK, amount: 10n ** 18n, recipient: BOB },
    ]);
    expect(batch.poolFee).toBe(SIX_STRK);

    ops.setPoolFee(20n * 10n ** 18n); // governance moved it

    await expect(batch.confirm({ feeCeiling: CEILING })).rejects.toThrow(/above the ceiling/);
    expect(ops.submitted).toHaveLength(0);
  });
});

describe('recipients must be registered', () => {
  it('blocks an unregistered recipient before proof generation', async () => {
    const ops = fresh();
    await expect(ops.prepare([
      { kind: 'transfer', token: STRK, amount: 10n ** 18n, recipient: '0x0999' },
    ])).rejects.toMatchObject({ kind: 'not-registered' });
  });

  it('reports unregistered addresses from the preflight', async () => {
    const ops = fresh();
    expect(await ops.recipientStatus(BOB)).toBe('registered');
    expect(await ops.recipientStatus('0x0999')).toBe('unregistered');
  });

  it('compares addresses padding-tolerantly', async () => {
    const ops = new FakePrivacyOperations({ registered: ['0x0222'] });
    expect(await ops.recipientStatus('0x222')).toBe('registered');
    expect(await ops.recipientStatus('0x0000222')).toBe('registered');
  });
});

describe('fault injection', () => {
  it('raises the requested error kind on the targeted method', async () => {
    const ops = fresh();
    ops.injectFault({ kind: 'not-registered', on: 'prepare' });
    await expect(
      ops.prepare([{ kind: 'transfer', token: STRK, amount: 1n, recipient: BOB }]),
    ).rejects.toMatchObject({ kind: 'not-registered' });
  });

  it('consumes a non-sticky fault after one use', async () => {
    const ops = fresh();
    ops.injectFault({ kind: 'unreachable', on: 'balances' });
    await expect(ops.balances()).rejects.toThrow();
    await expect(ops.balances()).resolves.toBeDefined();
  });

  it('keeps a sticky fault', async () => {
    const ops = fresh();
    ops.injectFault({ kind: 'unsupported-wallet', on: 'capability', sticky: true });
    await expect(ops.capability()).rejects.toThrow();
    await expect(ops.capability()).rejects.toThrow();
  });
});

describe('cancellation', () => {
  it('rejects an aborted call', async () => {
    const ops = fresh();
    const controller = new AbortController();
    controller.abort();
    await expect(ops.balances(undefined, controller.signal)).rejects.toMatchObject({
      kind: 'user-rejected',
    });
  });
});

describe('determinism', () => {
  it('produces identical results across runs', async () => {
    const run = async () => {
      const ops = fresh();
      const batch = await ops.prepare([
        { kind: 'transfer', token: STRK, amount: 10n ** 18n, recipient: BOB },
      ]);
      const result = await batch.confirm({ feeCeiling: CEILING });
      return { hash: result.transactionHash, balances: await ops.balances([STRK]) };
    };
    expect(await run()).toEqual(await run());
  });
});
