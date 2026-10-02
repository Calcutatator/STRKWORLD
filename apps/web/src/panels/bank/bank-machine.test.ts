import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FakePrivacyOperations,
  PrivacyError,
  type Address,
  type PrivacyOperations,
  type PrivateBalance,
} from '@strkworld/privacy';
import type { ShellFailure } from '../../privacy/errors.js';
import { PRIVACY_REGISTER } from '../../privacy/register.js';
import { COPY } from '../../copy.js';
import { formatTokenAmountExact, parseTokenAmount } from '../../format.js';
import { createConnectFlow } from '../../connect/connect-machine.js';
import { createBatchAccumulator } from '../../accumulator/batch-accumulator.js';
import { createReceiptLedger } from '../../receipts/receipt-ledger.js';
import { createSubmissionUncertainty } from '../../privacy/submission-uncertainty.js';
import { attachDebugTap } from '../../debug/debug-tap.js';
import {
  createBankPanel,
  ROUTE_BY_MODE,
  shieldFigures,
  shieldMax,
  type BankMode,
  type BankPanel,
  type BankPanelOptions,
} from './bank-machine.js';

const STRK: Address = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const BOB: Address = '0x02b4c7d1a1f8f39e0e6e8b9a2c7d0e3f4a5b6c7d8e9f0a1b2c3d4e5f60718293';
const ALICE: Address = '0x03c5d8e2b2f9a40f1f7f9c0b3d8e1f4a6b7c8d9e0f1a2b3c4d5e6f708192a3b4';
const STRANGER: Address = '0x0111111111111111111111111111111111111111111111111111111111111111';

const POOL_FEE = 6_000000000000000000n;
const SHIELD_DISCLOSURE = PRIVACY_REGISTER.find((entry) => entry.route === 'bank.shield')!.disclosure;
const strk = (whole: string) => parseTokenAmount(whole)!;
const allowFinancialActions = () => true;

describe('Bank route authority', () => {
  it('publishes an immutable panel API while retaining owned transitions', async () => {
    const panel = await openPanel(fake());
    const originalSetMode = panel.setMode;

    expect(Object.isFrozen(panel)).toBe(true);
    expect(Reflect.set(panel, 'setMode', () => undefined)).toBe(false);
    expect(Reflect.set(panel, 'confirm', async () => undefined)).toBe(false);
    expect(panel.setMode).toBe(originalSetMode);
    panel.setMode('transfer');
    expect(panel.store.getState().mode).toBe('transfer');
  });

  it('keeps the mode-to-route map immutable at the public seam', () => {
    expect(Object.isFrozen(ROUTE_BY_MODE)).toBe(true);
    expect(Reflect.set(ROUTE_BY_MODE, 'shield', 'exchange.swap')).toBe(false);
    expect(ROUTE_BY_MODE.shield).toBe('bank.shield');
  });

  it('keeps the allowed mode authority owned after construction', async () => {
    const allowedModes: BankPanelOptions['allowedModes'] = ['shield'];
    const panel = await openPanel(fake(), { allowedModes });

    (allowedModes as BankMode[]).push('transfer');
    panel.setMode('transfer');

    expect(panel.store.getState().mode).toBe('shield');
  });

  it('exposes a read-only immutable state snapshot to panel consumers', async () => {
    const panel = await openPanel(fake());
    const state = panel.store.getState();

    expect('setState' in panel.store).toBe(false);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.door)).toBe(true);
    expect(Object.isFrozen(state.pool)).toBe(true);
    expect(Object.isFrozen(state.balance)).toBe(true);
    expect(Object.isFrozen(state.batch)).toBe(true);
    expect(Reflect.set(state, 'mode', 'transfer')).toBe(false);
    expect(Reflect.set(state.door, 'open', false)).toBe(false);
    expect(Reflect.set(state.batch, '0', { kind: 'shield', token: STRK, amount: 1n })).toBe(false);
    expect(panel.store.getState().mode).toBe('shield');
  });
});

function fake(overrides: ConstructorParameters<typeof FakePrivacyOperations>[0] = {}) {
  return new FakePrivacyOperations({
    balances: { [STRK]: strk('100') },
    registered: [BOB],
    ...overrides,
  });
}

async function openPanel(
  operations: PrivacyOperations,
  options: Partial<Parameters<typeof createBankPanel>[0]> = {},
): Promise<BankPanel> {
  const panel = createBankPanel({
    operations,
    receipts: createReceiptLedger(),
    ...options,
    canStartFinancialAction: options.canStartFinancialAction ?? allowFinancialActions,
  });
  await panel.open();
  return panel;
}

/** The network cost the seam just quoted, read off the review state. */
function quotedCost(panel: BankPanel): bigint {
  const flow = panel.store.getState().flow;
  if (flow.name !== 'review') throw new Error(`expected review, got ${flow.name}`);
  return flow.summary.gasEstimate;
}

/** A promise the test settles, so async ownership is decided without timers. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((complete, fail) => {
    resolve = complete;
    reject = fail;
  });
  return { promise, resolve, reject };
}

type ConfirmationGate = {
  readonly entered: ReturnType<typeof deferred<void>>;
  readonly settled: ReturnType<typeof deferred<void>>;
};

function confirmationGate(): ConfirmationGate {
  return { entered: deferred<void>(), settled: deferred<void>() };
}

function gatePreparedConfirmations(operations: FakePrivacyOperations): {
  readonly first: ConfirmationGate;
  readonly second: ConfirmationGate;
  readonly discardCounts: number[];
} {
  const first = confirmationGate();
  const second = confirmationGate();
  const discardCounts: number[] = [];
  const gates = [first, second];
  let preparedCount = 0;
  const prepare = operations.prepare.bind(operations);
  vi.spyOn(operations, 'prepare').mockImplementation(async (intents, signal) => {
    const batch = await prepare(intents, signal);
    const index = preparedCount++;
    discardCounts.push(0);
    const gate = gates[index];
    if (!gate) return batch;
    return {
      ...batch,
      async confirm(options) {
        gate.entered.resolve(undefined);
        await gate.settled.promise;
        return batch.confirm(options);
      },
      discard() {
        discardCounts[index] = (discardCounts[index] ?? 0) + 1;
        batch.discard();
      },
    };
  });
  return { first, second, discardCounts };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('bank panel — entering the room', () => {
  it('rejects an unsupported mode from an untyped caller', () => {
    expect(() =>
      createBankPanel({
        operations: fake(),
        receipts: createReceiptLedger(),
        canStartFinancialAction: allowFinancialActions,
        allowedModes: ['transfer', 'swap'],
        initialMode: 'transfer',
      } as unknown as BankPanelOptions),
    ).toThrow('unsupported allowed mode: swap');
  });

  it('rejects duplicate allowed modes from an untyped caller', () => {
    expect(() =>
      createBankPanel({
        operations: fake(),
        receipts: createReceiptLedger(),
        canStartFinancialAction: allowFinancialActions,
        allowedModes: ['transfer', 'transfer'],
        initialMode: 'transfer',
      } as unknown as BankPanelOptions),
    ).toThrow('duplicate allowed mode: transfer');
  });

  it('rejects an empty mode list from an untyped caller', () => {
    expect(() =>
      createBankPanel({
        operations: fake(),
        receipts: createReceiptLedger(),
        canStartFinancialAction: allowFinancialActions,
        allowedModes: [],
        initialMode: 'transfer',
      } as unknown as BankPanelOptions),
    ).toThrow('requires at least one allowed mode');
  });

  it('rejects a non-array mode list from an untyped caller', () => {
    expect(() =>
      createBankPanel({
        operations: fake(),
        receipts: createReceiptLedger(),
        canStartFinancialAction: allowFinancialActions,
        allowedModes: null,
        initialMode: 'transfer',
      } as unknown as BankPanelOptions),
    ).toThrow('allowed modes must be an array');
  });

  it('rejects an initial mode outside the allowed list from an untyped caller', () => {
    expect(() =>
      createBankPanel({
        operations: fake(),
        receipts: createReceiptLedger(),
        canStartFinancialAction: allowFinancialActions,
        allowedModes: ['transfer'],
        initialMode: 'shield',
      } as unknown as BankPanelOptions),
    ).toThrow('initial mode is not allowed: shield');
  });

  it('can be configured as a transfer-only Post Office station', async () => {
    const panel = await openPanel(fake(), {
      allowedModes: ['transfer'],
      initialMode: 'transfer',
      maxIntents: 1,
    });

    expect(panel.store.getState()).toMatchObject({
      mode: 'transfer',
      routeId: 'post-office.transfer',
      door: { open: true },
    });

    panel.setMode('shield');
    expect(panel.store.getState().mode).toBe('transfer');
  });

  it('reads pool config on open and never asks the wallet for a balance', async () => {
    const operations = fake();
    const balances = vi.spyOn(operations, 'balances');
    const panel = await openPanel(operations);

    const state = panel.store.getState();
    expect(state.flow.name).toBe('composing');
    expect(state.pool?.feeAmount).toBe(POOL_FEE);
    // The token is read live from the pool rather than hardcoded in the shell.
    expect(state.token).toBe(STRK);
    expect(state.balance.status).toBe('unrequested');
    expect(balances).not.toHaveBeenCalled();
  });

  it('does not poll: time passing never triggers a balance read', async () => {
    vi.useFakeTimers();
    const operations = fake();
    const balances = vi.spyOn(operations, 'balances');
    const panel = await openPanel(operations);

    await vi.advanceTimersByTimeAsync(600_000);
    expect(balances).not.toHaveBeenCalled();

    await panel.refreshBalance();
    expect(balances).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(600_000);
    expect(balances).toHaveBeenCalledTimes(1);
  });

  it('carries the canonical disclosure for the selected route, per mode', async () => {
    const panel = await openPanel(fake());

    expect(panel.store.getState().routeId).toBe('bank.shield');
    expect(panel.store.getState().disclosure).toContain('Shielding is public.');

    panel.setMode('unshield');
    expect(panel.store.getState().disclosure).toContain('Unshielding is public.');

    panel.setMode('transfer');
    // The transfer shows no disclosure: the register records D-065's waiver.
    expect(panel.store.getState().routeId).toBe('post-office.transfer');
    expect(panel.store.getState().disclosure).toBeNull();
    expect(panel.store.getState().door.open).toBe(true);
  });

  it('refuses to compose against a route the privacy gate has locked', async () => {
    const panel = await openPanel(fake(), {
      register: [
        {
          building: 'bank',
          route: 'bank.shield',
          grade: 'public-edge',
          observable: 'test fixture',
          disclosure: null,
          approvedBy: null,
          approvedOn: null,
          rationale: null,
          returnToPool: false,
        },
      ],
    });

    expect(panel.store.getState().door.open).toBe(false);
    panel.setAmount('1');
    await panel.addToBatch();

    expect(panel.store.getState().batch).toHaveLength(0);
    expect(panel.store.getState().notice?.text).toBe(COPY.locked.unapprovedRoute);
  });
});

describe('bank panel — optional Bridge commit guard', () => {
  it('rejects a changed handoff plan before the wallet confirm and asks to prepare again', async () => {
    const guard = vi.fn(async () => false);
    const operations = fake();
    const panel = await openPanel(operations, {
      allowedModes: ['shield'],
      initialMode: 'shield',
      preConfirmGuard: guard,
    });
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();
    await panel.confirm();
    expect(guard).toHaveBeenCalledOnce();
    expect(operations.submitted).toHaveLength(0);
    expect(panel.store.getState().flow).toMatchObject({ name: 'failed', recovery: 'prepare-again' });
    const flow = panel.store.getState().flow;
    expect(flow.name === 'failed' ? flow.message : null).toBe(COPY.notices.bridgePlanMoved);
  });

  it('does not write a late Bridge guard result into a closed Bank machine', async () => {
    let release!: (value: boolean) => void;
    const guard = vi.fn(() => new Promise<boolean>((resolve) => { release = resolve; }));
    const panel = await openPanel(fake(), { allowedModes: ['shield'], initialMode: 'shield', preConfirmGuard: guard });
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();
    const confirming = panel.confirm();
    for (let i = 0; i < 5 && !release; i += 1) await Promise.resolve();
    panel.close();
    release(false);
    await confirming;
    expect(panel.store.getState().flow.name).toBe('idle');
  });
});

describe('bank panel — maturity-aware balance', () => {
  it('shows the spendable/maturing split when the source knows it', async () => {
    const operations = fake();
    const panel = await openPanel(operations);
    await panel.refreshBalance();

    const balance = panel.store.getState().balance;
    expect(balance.status).toBe('loaded');
    expect(balance.status === 'loaded' && balance.maturityKnown).toBe(true);
    expect(balance.status === 'loaded' && balance.spendable).toBe(strk('100'));
  });

  it('offers no maximum until the network cost has been quoted', async () => {
    // Both fees come out of the same shielded balance. A maximum that reserves
    // only the pool fee is a button that always fails at prepare.
    const panel = await openPanel(fake());
    await panel.refreshBalance();
    panel.setMode('transfer');

    expect(panel.store.getState().quotedGasForNextIntent).toBeNull();
    expect(panel.maxSpendable()).toBeNull();
    panel.applyMax();
    expect(panel.store.getState().amountText).toBe('');
    expect(panel.store.getState().notice?.text).toBe(COPY.balance.costUnknown);
  });

  it('offers no maximum for a visit shape it has never seen costed', async () => {
    // The relay fee is charged per action, so a figure measured on a one-intent
    // batch is not the cost of a two-intent batch. Reusing it is what made MAX
    // a button that always failed. Unshields still batch; a transfer never
    // shares a batch since D-065, so it cannot show this.
    const panel = await openPanel(fake());
    panel.setMode('unshield');
    panel.setRecipient(ALICE);
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();
    panel.cancelPrepared();
    await panel.refreshBalance();

    // One unshield has been costed; a batch of two has not, and that is the
    // shape another Add would create.
    expect(panel.store.getState().quotedGasForNextIntent).toBeNull();
    expect(panel.maxSpendable()).toBeNull();
  });

  it('reserves both fees for the empty visit, and that maximum survives review', async () => {
    const operations = fake();
    const panel = await openPanel(operations);
    panel.setMode('transfer');
    panel.setRecipient(BOB);
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();
    const gasForOne = quotedCost(panel);
    panel.cancelPrepared();
    panel.clearBatch();
    await panel.refreshBalance();

    panel.applyMax();
    const max = strk('100') - POOL_FEE - gasForOne;
    expect(panel.maxSpendable()).toBe(max);
    expect(panel.store.getState().amountText).toBe(formatTokenAmountExact(max));

    // The regression this exists for: MAX then Review used to fail every time.
    panel.setRecipient(BOB);
    await panel.addToBatch();
    await panel.prepare();
    expect(panel.store.getState().flow.name).toBe('review');
  });

  it('refuses a second unshield in one visit, because the relay admits one withdrawal', async () => {
    const operations = fake();
    const panel = await openPanel(operations);
    panel.setMode('unshield');
    for (const amount of ['1', '1']) {
      panel.setRecipient(ALICE);
      panel.setAmount(amount);
      await panel.addToBatch();
    }
    expect(panel.store.getState().batch).toHaveLength(1);
    expect(panel.store.getState().notice).toEqual({ tone: 'error', text: COPY.notices.oneUnshieldPerSend });
    // The one that was queued still reviews.
    await panel.prepare();
    expect(panel.store.getState().flow.name).toBe('review');
  });

  it('offers no maximum once the visit already spends everything', async () => {
    const operations = fake({ balances: { [STRK]: strk('10') } });
    const panel = await openPanel(operations);
    panel.setMode('unshield');
    panel.setRecipient(ALICE);
    panel.setAmount('4');
    await panel.addToBatch();
    expect(panel.store.getState().batch).toHaveLength(1);
    await panel.prepare();
    panel.cancelPrepared();
    await panel.refreshBalance();

    // 10 held, 4 queued, 6 pool fee and the relay estimate on top: the visit
    // already spends more than there is, so there is no maximum to offer.
    expect(panel.maxSpendable()).toBeNull();
  });

  it("takes the wallet's one total per token as the maximum, once the shape is costed (D-091, amending D-022)", async () => {
    const panel = await openPanel(new AggregateOnlyOperations(fake()));
    await panel.refreshBalance();
    panel.setMode('transfer');

    const balance = panel.store.getState().balance;
    expect(balance.status === 'loaded' && balance.maturityKnown).toBe(false);
    expect(balance.status === 'loaded' && balance.total).toBe(strk('100'));
    // The cost-evidence rule still stands: nothing costed, no maximum.
    expect(panel.maxSpendable()).toBeNull();
    panel.applyMax();
    expect(panel.store.getState().amountText).toBe('');
    expect(panel.store.getState().notice?.text).toBe(COPY.balance.costUnknown);

    panel.setRecipient(BOB);
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();
    const gas = quotedCost(panel);
    panel.cancelPrepared();
    panel.clearBatch();
    await panel.refreshBalance();
    expect(panel.maxSpendable()).toBe(strk('100') - POOL_FEE - gas);
  });

  it('says funds are settling when the wallet refuses a spend its reported total covers (D-091)', async () => {
    const inner = fake();
    const panel = await openPanel(new AggregateOnlyOperations(inner));
    await panel.refreshBalance();
    panel.setMode('transfer');
    panel.setRecipient(BOB);
    panel.setAmount('90');
    await panel.addToBatch();
    inner.injectFault({ kind: 'insufficient-balance', on: 'prepare' });
    await panel.prepare();
    expect(panel.store.getState().flow).toMatchObject({ name: 'failed', kind: 'insufficient-balance', message: COPY.balance.settling });
  });

  it('keeps the plain refusal when the total does not cover the spend, or was never read', async () => {
    const over = fake({ balances: { [STRK]: strk('95') } });
    const panel = await openPanel(new AggregateOnlyOperations(over));
    await panel.refreshBalance();
    panel.setMode('transfer');
    panel.setRecipient(BOB);
    panel.setAmount('90');
    await panel.addToBatch();
    over.injectFault({ kind: 'insufficient-balance', on: 'prepare' });
    await panel.prepare();
    expect(panel.store.getState().flow).toMatchObject({ name: 'failed', message: COPY.errors['insufficient-balance'] });

    const unread = fake();
    const blind = await openPanel(new AggregateOnlyOperations(unread));
    blind.setMode('transfer');
    blind.setRecipient(BOB);
    blind.setAmount('1');
    await blind.addToBatch();
    unread.injectFault({ kind: 'insufficient-balance', on: 'prepare' });
    await blind.prepare();
    expect(blind.store.getState().flow).toMatchObject({ name: 'failed', message: COPY.errors['insufficient-balance'] });
  });

  it('offers no shield maximum from the private balance: a shield spends public funds (D-094)', async () => {
    const operations = fake({ publicBalances: { [STRK]: 0n } });
    const panel = await openPanel(operations);
    await settle();
    await panel.refreshBalance();
    expect(panel.store.getState().mode).toBe('shield');
    // 100 STRK in the pool, nothing public: nothing to shield.
    expect(panel.maxSpendable()).toBeNull();
  });

  it('reports a failed balance read as a balance state, not a dead panel', async () => {
    const operations = fake();
    operations.injectFault({ kind: 'unreachable', on: 'balances' });
    const panel = await openPanel(operations);
    await panel.refreshBalance();

    const balance = panel.store.getState().balance;
    expect(balance.status).toBe('failed');
    expect(balance.status === 'failed' && balance.message).toBe(COPY.errors.unreachable);
    expect(panel.store.getState().flow.name).toBe('composing');
  });
});

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('bank panel — the Shield control spends the public wallet balance (D-094)', () => {
  it('reads the public balance of the shield token when the room opens on Shield', async () => {
    const operations = fake({ publicBalances: { [STRK]: strk('29') } });
    const read = vi.spyOn(operations, 'publicBalance');
    const privateRead = vi.spyOn(operations, 'balances');
    const panel = await openPanel(operations);
    await settle();
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]![0]).toBe(STRK);
    expect(panel.store.getState().publicBalance).toEqual({ status: 'loaded', token: STRK, amount: strk('29') });
    // The private balance still waits for the player: no wallet was asked.
    expect(privateRead).not.toHaveBeenCalled();
    expect(panel.store.getState().balance.status).toBe('unrequested');
  });

  it('re-reads on Refresh and on returning to Shield, and drops it on another tab', async () => {
    const operations = fake({ publicBalances: { [STRK]: strk('29') } });
    const read = vi.spyOn(operations, 'publicBalance');
    const panel = await openPanel(operations);
    await settle();
    await panel.refreshPublicBalance();
    expect(read).toHaveBeenCalledTimes(2);

    panel.setMode('unshield');
    expect(panel.store.getState().publicBalance.status).toBe('unrequested');
    await panel.refreshPublicBalance();
    expect(read).toHaveBeenCalledTimes(2);

    panel.setMode('shield');
    await settle();
    expect(read).toHaveBeenCalledTimes(3);
    expect(panel.store.getState().publicBalance).toMatchObject({ status: 'loaded', amount: strk('29') });
  });

  it('discards a read that lands after the player left Shield', async () => {
    const operations = fake();
    const answer = deferred<bigint>();
    vi.spyOn(operations, 'publicBalance').mockReturnValue(answer.promise);
    const panel = await openPanel(operations);
    panel.setMode('unshield');
    answer.resolve(strk('29'));
    await settle();
    expect(panel.store.getState().publicBalance.status).toBe('unrequested');
  });

  it('reads the token the pool names, and a new token after the room reopens', async () => {
    const OTHER: Address = '0x0123';
    const operations = fake({ publicBalances: { [STRK]: strk('29'), [OTHER]: strk('3') } });
    const read = vi.spyOn(operations, 'publicBalance');
    const panel = await openPanel(operations);
    await settle();
    expect(panel.store.getState().publicBalance).toMatchObject({ token: STRK, amount: strk('29') });

    panel.close();
    vi.spyOn(operations, 'poolConfig').mockResolvedValueOnce({
      feeAmount: POOL_FEE, feeToken: OTHER, proofValidityBlocks: 450, noteMaturityBlocks: 0,
    });
    await panel.open();
    await settle();
    expect(read.mock.calls.at(-1)![0]).toBe(OTHER);
    expect(panel.store.getState().publicBalance).toMatchObject({ token: OTHER, amount: strk('3') });
  });

  it('reports a failed read as a state, and asks no wallet', async () => {
    const operations = fake();
    operations.injectFault({ kind: 'unreachable', on: 'publicBalance' });
    const panel = await openPanel(operations);
    await settle();
    expect(panel.store.getState().publicBalance).toEqual({ status: 'failed', message: COPY.balance.publicFailed });
    expect(panel.maxSpendable()).toBeNull();
  });

  it('Max is the wallet balance less the pool fee on top, and less what is queued', async () => {
    const panel = await openPanel(fake({ publicBalances: { [STRK]: strk('29') } }));
    await settle();
    // 29 STRK public, 6 STRK pool fee on top: 23 STRK reaches the pool.
    expect(panel.maxSpendable()).toBe(strk('23'));
    panel.applyMax();
    expect(panel.store.getState().amountText).toBe('23');

    panel.setAmount('20');
    await panel.addToBatch();
    expect(panel.store.getState().batch).toHaveLength(1);
    // The fee is paid once per visit, so only 3 STRK more fits.
    expect(panel.maxSpendable()).toBe(strk('3'));
  });

  it('offers no Max when the wallet holds no more than the pool fee', async () => {
    const panel = await openPanel(fake({ publicBalances: { [STRK]: strk('6') } }));
    await settle();
    expect(panel.maxSpendable()).toBeNull();
  });

  it('refuses a shield whose amount plus the pool fee is more than the wallet holds', async () => {
    const panel = await openPanel(fake({ publicBalances: { [STRK]: strk('29') } }));
    await settle();
    panel.setAmount('23.000000000000000001');
    await panel.addToBatch();
    expect(panel.store.getState().batch).toHaveLength(0);
    expect(panel.store.getState().notice?.text).toBe('Insufficient STRK');

    panel.setAmount('23');
    await panel.addToBatch();
    expect(panel.store.getState().batch).toHaveLength(1);
  });

  it('shields the typed amount: the note is the amount and the wallet sends amount + fee', async () => {
    const operations = fake({ balances: {}, publicBalances: { [STRK]: strk('29') } });
    const panel = await openPanel(operations);
    await settle();
    panel.setAmount('9');
    await panel.addToBatch();
    await panel.prepare();
    await panel.confirm();
    expect(operations.submitted).toEqual([[{ kind: 'shield', token: STRK, amount: strk('9') }]]);
    // 9 STRK reached the pool; 9 + 6 left the wallet.
    const [pool] = await operations.balances([STRK]);
    expect(pool!.total).toBe(strk('9'));
    expect(await operations.publicBalance(STRK)).toBe(strk('14'));
    const state = panel.store.getState();
    expect(state.flow).toMatchObject({ name: 'submitted', shielded: true });
    // The wallet balance is re-read after the shield, without a wallet prompt.
    await settle();
    expect(panel.store.getState().publicBalance).toMatchObject({ status: 'loaded', amount: strk('14') });
  });

  it('names the public balance, not the pool, when the wallet refuses a shield as short', async () => {
    const operations = fake({ publicBalances: { [STRK]: strk('29') } });
    const panel = await openPanel(operations);
    await settle();
    panel.setAmount('9');
    await panel.addToBatch();
    await panel.prepare();
    operations.injectFault({ kind: 'insufficient-balance', on: 'confirm' });
    await panel.confirm();
    expect(panel.store.getState().flow).toMatchObject({
      name: 'failed',
      message: "There is not enough STRK in your wallet's public balance for this deposit.",
    });
  });
});

describe('shield figures (D-094)', () => {
  it('puts the pool fee on top of the amount', () => {
    expect(shieldFigures(strk('9'), POOL_FEE)).toEqual({ amount: strk('9'), fee: POOL_FEE, total: strk('15') });
  });

  it('caps Max at the balance less the fee and the queue', () => {
    expect(shieldMax(strk('29'), POOL_FEE, 0n)).toBe(strk('23'));
    expect(shieldMax(strk('29'), POOL_FEE, strk('20'))).toBe(strk('3'));
    expect(shieldMax(strk('6'), POOL_FEE, 0n)).toBeNull();
    expect(shieldMax(strk('5'), POOL_FEE, 0n)).toBeNull();
  });
});

describe('bank panel — composing a visit', () => {
  it('preserves an edited form when a transfer preflight finishes after the edit', async () => {
    const operations = fake();
    const preflight = deferred<'registered'>();
    vi.spyOn(operations, 'recipientStatus').mockReturnValue(preflight.promise);
    const panel = await openPanel(operations);
    panel.setMode('transfer');
    panel.setRecipient(BOB);
    panel.setAmount('1');

    const adding = panel.addToBatch();
    panel.setRecipient(ALICE);
    panel.setAmount('2');

    preflight.resolve('registered');
    await adding;

    expect(panel.store.getState()).toMatchObject({
      adding: false,
      amountText: '2',
      recipientText: ALICE,
      batch: [],
      flow: { name: 'composing' },
    });
  });

  it('preserves MAX when a transfer preflight finishes after the MAX edit', async () => {
    const operations = fake();
    const preflight = deferred<'registered'>();
    vi.spyOn(operations, 'recipientStatus')
      .mockResolvedValueOnce('registered')
      .mockReturnValueOnce(preflight.promise);
    const panel = await openPanel(operations);
    panel.setMode('transfer');
    panel.setRecipient(BOB);
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();
    panel.cancelPrepared();
    panel.clearBatch();
    await panel.refreshBalance();

    const max = panel.maxSpendable();
    expect(max).not.toBeNull();
    panel.setRecipient(BOB);
    panel.setAmount('1');
    const adding = panel.addToBatch();
    panel.applyMax();

    expect(panel.store.getState().amountText).toBe(formatTokenAmountExact(max!));
    preflight.resolve('registered');
    await adding;

    expect(panel.store.getState()).toMatchObject({
      adding: false,
      amountText: formatTokenAmountExact(max!),
      recipientText: BOB,
      batch: [],
      flow: { name: 'composing' },
    });
  });

  it('retires a preflight when only the recipient changes', async () => {
    const operations = fake();
    const preflight = deferred<'registered'>();
    vi.spyOn(operations, 'recipientStatus').mockReturnValue(preflight.promise);
    const panel = await openPanel(operations);
    panel.setMode('transfer');
    panel.setRecipient(BOB);
    panel.setAmount('1');

    const adding = panel.addToBatch();
    panel.setRecipient(ALICE);
    preflight.resolve('registered');
    await adding;

    expect(panel.store.getState()).toMatchObject({
      amountText: '1',
      recipientText: ALICE,
      batch: [],
    });
  });

  it('retires a preflight when only the amount changes', async () => {
    const operations = fake();
    const preflight = deferred<'registered'>();
    vi.spyOn(operations, 'recipientStatus').mockReturnValue(preflight.promise);
    const panel = await openPanel(operations);
    panel.setMode('transfer');
    panel.setRecipient(BOB);
    panel.setAmount('1');

    const adding = panel.addToBatch();
    panel.setAmount('2');
    preflight.resolve('registered');
    await adding;

    expect(panel.store.getState()).toMatchObject({
      amountText: '2',
      recipientText: BOB,
      batch: [],
    });
  });

  it('retires a preflight when the active mode is selected again', async () => {
    const operations = fake();
    const preflight = deferred<'registered'>();
    vi.spyOn(operations, 'recipientStatus').mockReturnValue(preflight.promise);
    const panel = await openPanel(operations);
    panel.setMode('transfer');
    panel.setRecipient(BOB);
    panel.setAmount('1');

    const adding = panel.addToBatch();
    panel.setMode('transfer');
    preflight.resolve('registered');
    await adding;

    expect(panel.store.getState()).toMatchObject({
      mode: 'transfer',
      amountText: '',
      recipientText: '',
      batch: [],
    });
  });

  it('keeps Clear authoritative when a transfer preflight finishes late', async () => {
    const operations = fake();
    const preflight = deferred<'registered'>();
    vi.spyOn(operations, 'recipientStatus')
      .mockResolvedValueOnce('registered')
      .mockReturnValueOnce(preflight.promise);
    const panel = await openPanel(operations);
    panel.setMode('transfer');

    panel.setRecipient(BOB);
    panel.setAmount('1');
    await panel.addToBatch();
    expect(panel.store.getState().batch).toHaveLength(1);

    panel.setRecipient(BOB);
    panel.setAmount('2');
    const adding = panel.addToBatch();
    expect(panel.store.getState().adding).toBe(true);

    panel.clearBatch();
    expect(panel.store.getState().batch).toEqual([]);
    preflight.resolve('registered');
    await adding;

    expect(panel.store.getState()).toMatchObject({
      adding: false,
      batch: [],
      flow: { name: 'composing' },
    });
  });

  it('suppresses a rejected transfer preflight after Clear owns the batch', async () => {
    const operations = fake();
    const preflight = deferred<'registered'>();
    vi.spyOn(operations, 'recipientStatus')
      .mockResolvedValueOnce('registered')
      .mockReturnValueOnce(preflight.promise);
    const onError = vi.fn();
    const panel = await openPanel(operations, { onError });
    panel.setMode('transfer');

    panel.setRecipient(BOB);
    panel.setAmount('1');
    await panel.addToBatch();
    panel.setRecipient(BOB);
    panel.setAmount('2');
    const adding = panel.addToBatch();

    panel.clearBatch();
    preflight.reject(new PrivacyError('unreachable', 'stale preflight failure'));
    await adding;

    expect(onError).not.toHaveBeenCalled();
    expect(panel.store.getState()).toMatchObject({
      adding: false,
      amountText: '2',
      recipientText: BOB,
      batch: [],
      notice: null,
      flow: { name: 'composing' },
    });
  });

  it('keeps Remove authoritative when a transfer preflight succeeds late', async () => {
    const operations = fake();
    const preflight = deferred<'registered'>();
    vi.spyOn(operations, 'recipientStatus')
      .mockResolvedValueOnce('registered')
      .mockReturnValueOnce(preflight.promise);
    const panel = await openPanel(operations);
    panel.setMode('transfer');

    panel.setRecipient(BOB);
    panel.setAmount('1');
    await panel.addToBatch();
    panel.setRecipient(BOB);
    panel.setAmount('2');
    const adding = panel.addToBatch();

    panel.removeFromBatch(0);
    preflight.resolve('registered');
    await adding;

    expect(panel.store.getState()).toMatchObject({
      adding: false,
      amountText: '2',
      recipientText: BOB,
      batch: [],
      notice: null,
      flow: { name: 'composing' },
    });
  });

  it('suppresses a rejected transfer preflight after Remove owns the batch', async () => {
    const operations = fake();
    const preflight = deferred<'registered'>();
    vi.spyOn(operations, 'recipientStatus')
      .mockResolvedValueOnce('registered')
      .mockReturnValueOnce(preflight.promise);
    const onError = vi.fn();
    const panel = await openPanel(operations, { onError });
    panel.setMode('transfer');

    panel.setRecipient(BOB);
    panel.setAmount('1');
    await panel.addToBatch();
    panel.setRecipient(BOB);
    panel.setAmount('2');
    const adding = panel.addToBatch();

    panel.removeFromBatch(0);
    preflight.reject(new PrivacyError('unreachable', 'stale preflight failure'));
    await adding;

    expect(onError).not.toHaveBeenCalled();
    expect(panel.store.getState()).toMatchObject({
      adding: false,
      amountText: '2',
      recipientText: BOB,
      batch: [],
      notice: null,
      flow: { name: 'composing' },
    });
  });

  it('refuses a second transfer with the one-recipient notice, then sends the next after confirm (D-065)', async () => {
    const operations = fake({ registered: [BOB, ALICE] });
    const panel = await openPanel(operations);
    panel.setMode('transfer');

    panel.setRecipient(BOB);
    panel.setAmount('1');
    await panel.addToBatch();
    panel.setRecipient(ALICE);
    panel.setAmount('2');
    await panel.addToBatch();

    expect(panel.store.getState()).toMatchObject({
      batch: [{ kind: 'transfer', token: STRK, amount: strk('1'), recipient: BOB }],
      // The refused entry stays in the form, so the player can send it next.
      amountText: '2',
      recipientText: ALICE,
      notice: { tone: 'error', text: COPY.notices.oneRecipientPerSend },
    });
    await panel.prepare();
    await panel.confirm();
    expect(operations.submitted).toEqual([
      [{ kind: 'transfer', token: STRK, amount: strk('1'), recipient: BOB }],
    ]);

    // Confirming empties the visit, so the next send is its own submission.
    panel.acknowledge();
    panel.setRecipient(ALICE);
    panel.setAmount('2');
    await panel.addToBatch();
    await panel.prepare();
    await panel.confirm();
    expect(operations.submitted).toEqual([
      [{ kind: 'transfer', token: STRK, amount: strk('1'), recipient: BOB }],
      [{ kind: 'transfer', token: STRK, amount: strk('2'), recipient: ALICE }],
    ]);
  });

  it('holds one transfer at a time in the exact Post Office Menu configuration (D-065)', async () => {
    const operations = fake();
    const panel = await openPanel(operations, {
      allowedModes: ['transfer'],
      initialMode: 'transfer',
    });

    for (const amount of ['1', '2']) {
      panel.setRecipient(BOB);
      panel.setAmount(amount);
      await panel.addToBatch();
    }

    // Even to the same recipient: a batch holds at most one transfer.
    expect(panel.store.getState()).toMatchObject({
      mode: 'transfer',
      routeId: 'post-office.transfer',
      batch: [{ kind: 'transfer', token: STRK, amount: strk('1'), recipient: BOB }],
      notice: { tone: 'error', text: COPY.notices.oneRecipientPerSend },
    });

    await panel.prepare();
    await panel.confirm();

    expect(operations.submitted).toEqual([
      [{ kind: 'transfer', token: STRK, amount: strk('1'), recipient: BOB }],
    ]);
    expect(panel.store.getState().flow.name).toBe('submitted');
  });

  it('still lets a shield or an unshield share a visit with the one transfer, as separate sends', async () => {
    for (const other of ['shield', 'unshield'] as const) {
      const operations = fake();
      const panel = await openPanel(operations);

      panel.setMode(other);
      if (other === 'unshield') panel.setRecipient(ALICE);
      panel.setAmount('1');
      await panel.addToBatch();
      await panel.prepare();
      await panel.confirm();
      panel.acknowledge();

      panel.setMode('transfer');
      panel.setRecipient(BOB);
      panel.setAmount('2');
      await panel.addToBatch();
      expect(panel.store.getState().notice, other).toBeNull();
      await panel.prepare();
      await panel.confirm();

      expect(operations.submitted.map((batch) => batch.map((intent) => intent.kind)), other).toEqual([
        [other],
        ['transfer'],
      ]);
      expect(panel.store.getState().flow.name, other).toBe('submitted');
    }
  });

  it('executes a transfer-only station as one typed private transfer', async () => {
    const operations = fake();
    const panel = await openPanel(operations, {
      allowedModes: ['transfer'],
      initialMode: 'transfer',
      maxIntents: 1,
    });

    panel.setRecipient(BOB);
    panel.setAmount('1');
    await panel.addToBatch();
    expect(panel.store.getState().batch).toHaveLength(1);

    await panel.prepare();
    await panel.confirm();

    expect(operations.submitted).toEqual([
      [{ kind: 'transfer', token: STRK, amount: strk('1'), recipient: BOB }],
    ]);
    expect(panel.store.getState().flow.name).toBe('submitted');
  });

  it('rejects a shield queued alongside a spend, with the reason (D-022)', async () => {
    const panel = await openPanel(fake());
    panel.setAmount('1');
    await panel.addToBatch();

    panel.setMode('transfer');
    panel.setRecipient(BOB);
    panel.setAmount('1');
    await panel.addToBatch();

    expect(panel.store.getState().batch).toHaveLength(1);
    expect(panel.store.getState().notice?.text).toBe(COPY.notices.mixedShieldAndSpend);
  });

  it('preflights a transfer recipient and blocks an unregistered one', async () => {
    const operations = fake();
    const panel = await openPanel(operations);
    panel.setMode('transfer');
    panel.setRecipient(STRANGER);
    panel.setAmount('1');
    await panel.addToBatch();

    expect(panel.store.getState().batch).toHaveLength(0);
    expect(panel.store.getState().notice?.text).toBe(COPY.notices.recipientUnregistered);
  });

  it('rejects an unparseable amount before spending a round trip', async () => {
    const operations = fake();
    const recipientStatus = vi.spyOn(operations, 'recipientStatus');
    const panel = await openPanel(operations);
    panel.setMode('transfer');
    panel.setRecipient(BOB);
    panel.setAmount('one');
    await panel.addToBatch();

    expect(panel.store.getState().notice?.text).toBe(COPY.notices.badAmount);
    expect(recipientStatus).not.toHaveBeenCalled();
  });

  it('rejects a recipient that is not an address', async () => {
    const panel = await openPanel(fake());
    panel.setMode('unshield');
    panel.setRecipient('bob@example.com');
    panel.setAmount('1');
    await panel.addToBatch();

    expect(panel.store.getState().notice?.text).toBe(COPY.notices.badRecipient);
  });
});

describe('bank panel — prepare and confirm', () => {
  it('keeps Clear authoritative when preparation finishes late', async () => {
    const operations = fake();
    const preparation = deferred<void>();
    const prepare = operations.prepare.bind(operations);
    let staleBatch!: Awaited<ReturnType<PrivacyOperations['prepare']>>;
    vi.spyOn(operations, 'prepare').mockImplementation(async (intents, signal) => {
      await preparation.promise;
      staleBatch = await prepare(intents, signal);
      return staleBatch;
    });
    const panel = await openPanel(operations);
    panel.setAmount('1');
    await panel.addToBatch();

    const preparing = panel.prepare();
    expect(panel.store.getState().flow.name).toBe('preparing');
    panel.clearBatch();
    expect(panel.store.getState()).toMatchObject({ batch: [], flow: { name: 'composing' } });

    preparation.resolve(undefined);
    await preparing;
    expect(panel.store.getState()).toMatchObject({ batch: [], flow: { name: 'composing' } });
    await expect(staleBatch.confirm({ feeCeiling: staleBatch.totalCost })).rejects.toThrow(/discarded/);
  });

  it('keeps Remove authoritative when preparation finishes late', async () => {
    const operations = fake();
    const preparation = deferred<void>();
    const prepare = operations.prepare.bind(operations);
    let staleBatch!: Awaited<ReturnType<PrivacyOperations['prepare']>>;
    vi.spyOn(operations, 'prepare').mockImplementation(async (intents, signal) => {
      await preparation.promise;
      staleBatch = await prepare(intents, signal);
      return staleBatch;
    });
    const panel = await openPanel(operations);
    panel.setMode('transfer');
    for (const amount of ['1', '2']) {
      panel.setRecipient(BOB);
      panel.setAmount(amount);
      await panel.addToBatch();
    }

    const preparing = panel.prepare();
    panel.removeFromBatch(1);
    expect(panel.store.getState()).toMatchObject({
      batch: [{ amount: strk('1') }],
      flow: { name: 'composing' },
    });

    preparation.resolve(undefined);
    await preparing;
    expect(panel.store.getState()).toMatchObject({
      batch: [{ amount: strk('1') }],
      flow: { name: 'composing' },
    });
    await expect(staleBatch.confirm({ feeCeiling: staleBatch.totalCost })).rejects.toThrow(/discarded/);
  });

  it('shows a visible preparing state while the wallet is involved', async () => {
    const operations = fake({ latencyMs: 5 });
    const panel = await openPanel(operations);
    panel.setAmount('1');
    await panel.addToBatch();

    const pending = panel.prepare();
    expect(panel.store.getState().flow.name).toBe('preparing');
    await pending;
    expect(panel.store.getState().flow.name).toBe('review');
  });

  it('quotes the live pool fee and a ceiling, and no prompt count', async () => {
    const panel = await openPanel(fake());
    panel.setMode('transfer');
    panel.setRecipient(BOB);
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();

    const flow = panel.store.getState().flow;
    expect(flow.name).toBe('review');
    if (flow.name !== 'review') return;
    expect(flow.summary.poolFee).toBe(POOL_FEE);
    expect(flow.summary.feeCeiling).toBe(flow.summary.totalCost);
    // Prompt counts are provisional under D-028 and must never reach the UI.
    expect(Object.keys(flow.summary)).not.toContain('promptCount');
  });

  it('drives the submitting UI from the operation stages it is given', async () => {
    const panel = await openPanel(fake());
    panel.setMode('transfer');
    panel.setRecipient(BOB);
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();

    const stages: string[] = [];
    const stop = panel.store.subscribe((state) => {
      if (state.flow.name === 'submitting') stages.push(state.flow.stage);
    });
    await panel.confirm();
    stop();

    expect(stages).toContain('awaiting-approval');
    expect(stages).toContain('proving');
    expect(stages).toContain('submitting');
  });

  it('surfaces the seam warnings for a public leg', async () => {
    const panel = await openPanel(fake());
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();

    const flow = panel.store.getState().flow;
    expect(flow.name === 'review' && flow.summary.warnings.some((w) => w.kind === 'public-leg')).toBe(true);
  });

  it('leaves the balance unrequested after a submission rather than re-reading it', async () => {
    const operations = fake();
    const panel = await openPanel(operations);
    panel.setMode('transfer');
    panel.setRecipient(BOB);
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.refreshBalance();
    const balances = vi.spyOn(operations, 'balances');

    await panel.prepare();
    await panel.confirm();

    const state = panel.store.getState();
    expect(state.flow.name).toBe('submitted');
    expect(state.balance.status).toBe('unrequested');
    expect(state.notice?.text).toBe(COPY.balance.changed);
    expect(balances).not.toHaveBeenCalled();
    expect(state.batch).toHaveLength(0);
    // Confirmed this session, not found on reopen — must not read as a
    // restored receipt (fix for the dead `receiptWaiting` copy).
    expect(state.flow.name === 'submitted' && state.flow.restored).toBeFalsy();
  });

  it('cancelling a prepared batch returns to composing without submitting', async () => {
    const operations = fake();
    const panel = await openPanel(operations);
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();

    panel.cancelPrepared();
    expect(panel.store.getState().flow.name).toBe('composing');
    await panel.confirm();
    expect(operations.submitted).toHaveLength(0);
  });
});

describe('bank panel — fault injection', () => {
  it('escalates a not-registered failure to the connect room instead of a toast', async () => {
    const operations = fake();
    const connect = createConnectFlow(operations);
    await connect.connect();

    const panel = await openPanel(operations, { onError: (error) => connect.noteOperationError(error) });
    operations.injectFault({ kind: 'not-registered', on: 'prepare' });
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();

    expect(connect.store.getState().name).toBe('not-registered');
    const flow = panel.store.getState().flow;
    expect(flow.name === 'failed' && flow.kind).toBe('not-registered');
    expect(flow.name === 'failed' && flow.message).toBe(COPY.errors['not-registered']);
  });

  it.each(['prepare', 'confirm'] as const)('names the failing route to onError when the %s fails, for the debug log', async (on) => {
    const operations = fake();
    const failures: ShellFailure[] = [];
    const panel = await openPanel(operations, { onError: (failure) => failures.push(failure) });
    operations.injectFault({ kind: 'unknown', on });
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();
    if (on === 'confirm') await panel.confirm();

    const kind = panel.store.getState().batch[0]?.kind;
    expect(kind).toBeDefined();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ kind: 'unknown', operation: kind });
  });

  describe('a Post Office send whose recipient the pool has never seen (D-074)', () => {
    async function postOffice(operations: FakePrivacyOperations) {
      const connect = createConnectFlow(operations);
      await connect.connect();
      const failures: ShellFailure[] = [];
      const panel = await openPanel(operations, {
        allowedModes: ['transfer'],
        initialMode: 'transfer',
        building: 'post-office',
        onError: (failure) => {
          failures.push(failure);
          connect.noteOperationError(failure);
        },
      });
      return { connect, failures, panel };
    }

    const recipientFailure = {
      name: 'failed',
      kind: 'recipient-not-registered',
      message: COPY.errors['recipient-not-registered'],
      recovery: 'prepare-again',
    } as const;

    it('keeps the prepare-time refusal in the Post Office and the player connected', async () => {
      const operations = fake();
      const { connect, failures, panel } = await postOffice(operations);
      // The Add's preflight could not tell; the prepare's own pool read says no.
      vi.spyOn(operations, 'recipientStatus').mockResolvedValueOnce('unknown');
      panel.setRecipient(STRANGER);
      panel.setAmount('1');
      await panel.addToBatch();
      expect(panel.store.getState().batch).toHaveLength(1);
      await panel.prepare();

      expect(panel.store.getState().flow).toEqual(recipientFailure);
      expect(connect.store.getState().name).toBe('connected');
      expect(failures.map((failure) => failure.kind)).toEqual(['recipient-not-registered']);
      // Back keeps the send queued, as any failed prepare does.
      panel.cancelPrepared();
      expect(panel.store.getState().batch.map((intent) => intent.kind)).toEqual(['transfer']);
      expect(operations.submitted).toHaveLength(0);
    });

    it('keeps the wallet\'s 118 while proving in the Post Office and the player connected', async () => {
      const operations = fake();
      const { connect, failures, panel } = await postOffice(operations);
      panel.setRecipient(BOB);
      panel.setAmount('1');
      await panel.addToBatch();
      await panel.prepare();
      expect(panel.store.getState().flow.name).toBe('review');
      operations.injectFault({ kind: 'recipient-not-registered', on: 'confirm' });
      await panel.confirm();

      expect(panel.store.getState().flow).toEqual(recipientFailure);
      expect(connect.store.getState().name).toBe('connected');
      expect(failures.map((failure) => failure.kind)).toEqual(['recipient-not-registered']);
      expect(operations.submitted).toHaveLength(0);
    });
  });

  it('reports insufficient balance in the player’s terms and offers another go', async () => {
    const operations = fake({ balances: { [STRK]: strk('1') } });
    const panel = await openPanel(operations);
    panel.setMode('transfer');
    panel.setRecipient(BOB);
    panel.setAmount('50');
    await panel.addToBatch();
    await panel.prepare();

    const flow = panel.store.getState().flow;
    expect(flow.name === 'failed' && flow.kind).toBe('insufficient-balance');
    expect(flow.name === 'failed' && flow.message).toBe(COPY.errors['insufficient-balance']);
    expect(flow.name === 'failed' && flow.recovery).toBe('prepare-again');
    expect(operations.submitted).toHaveLength(0);
  });

  it('refuses to sign when the pool fee moves past the quoted ceiling', async () => {
    const operations = fake();
    const panel = await openPanel(operations);
    panel.setMode('transfer');
    panel.setRecipient(BOB);
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();

    // Governance moves the fee between prepare and confirm. It has moved once.
    operations.setPoolFee(strk('20'));
    await panel.confirm();

    const flow = panel.store.getState().flow;
    expect(flow.name === 'failed' && flow.message).toBe(COPY.notices.feeMoved);
    expect(flow.name === 'failed' && flow.recovery).toBe('prepare-again');
    expect(operations.submitted).toHaveLength(0);
  });

  it('still passes the ceiling to the seam when its own fee read is stale', async () => {
    const operations = fake();
    const panel = await openPanel(operations);
    panel.setMode('transfer');
    panel.setRecipient(BOB);
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();

    // The shell's pre-check sees the old fee, so the wallet-side guard is what
    // stops the signature. The seam can only report that as a generic failure,
    // so the panel asks the pool what happened rather than matching a string.
    const stale = await operations.poolConfig();
    operations.setPoolFee(strk('20'));
    vi.spyOn(operations, 'poolConfig').mockResolvedValueOnce(stale);
    await panel.confirm();

    const flow = panel.store.getState().flow;
    expect(flow.name === 'failed' && flow.message).toBe(COPY.notices.feeMoved);
    expect(flow.name === 'failed' && flow.recovery).toBe('prepare-again');
    expect(operations.submitted).toHaveLength(0);
  });

  it('treats a declined wallet prompt as a state, not an error message about us', async () => {
    const operations = fake();
    const panel = await openPanel(operations);
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();
    operations.injectFault({ kind: 'user-rejected', on: 'confirm' });
    await panel.confirm();

    const flow = panel.store.getState().flow;
    expect(flow.name === 'failed' && flow.kind).toBe('user-rejected');
    expect(flow.name === 'failed' && flow.message).toBe(COPY.errors['user-rejected']);
    expect(operations.submitted).toHaveLength(0);
  });

  it('makes submission uncertainty non-retryable and retains it above the panel', async () => {
    const operations = fake();
    const receipts = createReceiptLedger();
    const uncertainty = createSubmissionUncertainty();
    const panel = await openPanel(operations, {
      receipts,
      onError: (failure) => {
        if (failure.kind === 'submission-uncertain') uncertainty.retain();
      },
    });
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();
    operations.injectFault({ kind: 'submission-uncertain', on: 'confirm' });

    await panel.confirm();

    const flow = panel.store.getState().flow;
    expect(flow.name === 'failed' && flow.kind).toBe('submission-uncertain');
    expect(flow.name === 'failed' && flow.message).toBe(COPY.errors['submission-uncertain']);
    expect(flow.name === 'failed' && flow.recovery).toBe('close');
    expect(uncertainty.store.getState()).toEqual({ active: true, acknowledged: false });
    expect(receipts.pending('bank')).toHaveLength(0);

    await panel.confirm();
    expect(operations.submitted).toHaveLength(0);
  });

  it('retains late submission uncertainty after the station window closes', async () => {
    const operations = fake();
    const uncertainty = createSubmissionUncertainty();
    let entered!: () => void;
    let release!: () => void;
    const insideConfirm = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realPrepare = operations.prepare.bind(operations);
    vi.spyOn(operations, 'prepare').mockImplementation(async (intents, signal) => {
      const batch = await realPrepare(intents, signal);
      return {
        ...batch,
        async confirm() {
          entered();
          await held;
          throw { kind: 'submission-uncertain' };
        },
      };
    });
    const panel = await openPanel(operations, {
      onError: (failure) => {
        if (failure.kind === 'submission-uncertain') uncertainty.retain();
      },
    });
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();

    const inFlight = panel.confirm();
    await insideConfirm;
    panel.close();
    release();
    await inFlight;

    expect(panel.store.getState().flow.name).toBe('idle');
    expect(uncertainty.store.getState()).toEqual({ active: true, acknowledged: false });
  });

  it('closes cleanly, discarding the prepared batch and the visit', async () => {
    const operations = fake();
    const panel = await openPanel(operations);
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();

    panel.close();
    const state = panel.store.getState();
    expect(state.flow.name).toBe('idle');
    expect(state.batch).toHaveLength(0);
    await panel.confirm();
    expect(operations.submitted).toHaveLength(0);
  });
});

/**
 * The shipped Wallet API returns one aggregate per token, so the production
 * adapter reports `maturityKnown: false` with conservative zeroes. The
 * deterministic fake knows its own note ages and reports the split, so this
 * wrapper is how the shell gets tested against the shape a real wallet gives.
 */
class AggregateOnlyOperations implements PrivacyOperations {
  constructor(private readonly inner: FakePrivacyOperations) {}

  capability: PrivacyOperations['capability'] = (signal) => this.inner.capability(signal);
  poolConfig: PrivacyOperations['poolConfig'] = (signal) => this.inner.poolConfig(signal);
  recipientStatus: PrivacyOperations['recipientStatus'] = (address, signal) =>
    this.inner.recipientStatus(address, signal);
  prepare: PrivacyOperations['prepare'] = (intents, signal) => this.inner.prepare(intents, signal);
  hasPrivateFunds: PrivacyOperations['hasPrivateFunds'] = (signal) => this.inner.hasPrivateFunds(signal);
  depositStatus: PrivacyOperations['depositStatus'] = (hash, signal) => this.inner.depositStatus(hash, signal);
  // D-077, D-079: the Vault, passed through untouched.
  vaultPositions: PrivacyOperations['vaultPositions'] = (options) => this.inner.vaultPositions(options);
  prepareVaultSupply: PrivacyOperations['prepareVaultSupply'] = (token, amount, options) =>
    this.inner.prepareVaultSupply(token, amount, options);
  prepareVaultRedeem: PrivacyOperations['prepareVaultRedeem'] = (token, amount, options) =>
    this.inner.prepareVaultRedeem(token, amount, options);
  vaultRates: PrivacyOperations['vaultRates'] = (signal) => this.inner.vaultRates(signal);
  // D-083: the Borrow counter, passed through untouched.
  borrowMarket: PrivacyOperations['borrowMarket'] = (signal) => this.inner.borrowMarket(signal);
  borrowPositions: PrivacyOperations['borrowPositions'] = (options) => this.inner.borrowPositions(options);
  prepareBorrow: PrivacyOperations['prepareBorrow'] = (request, options) => this.inner.prepareBorrow(request, options);
  // D-085: Endur unstaking, passed through untouched.
  endurUnstakePosition: PrivacyOperations['endurUnstakePosition'] = (options) => this.inner.endurUnstakePosition(options);
  prepareEndurUnstake: PrivacyOperations['prepareEndurUnstake'] = (shares, options) =>
    this.inner.prepareEndurUnstake(shares, options);
  prepareEndurClaim: PrivacyOperations['prepareEndurClaim'] = (options) => this.inner.prepareEndurClaim(options);
  endurRate: PrivacyOperations['endurRate'] = (signal) => this.inner.endurRate(signal);
  // D-094: the public balance, passed through untouched.
  publicBalance: PrivacyOperations['publicBalance'] = (token, signal) => this.inner.publicBalance(token, signal);

  async balances(tokens?: Address[], signal?: AbortSignal): Promise<PrivateBalance[]> {
    const balances = await this.inner.balances(tokens, signal);
    return balances.map((balance) => ({
      token: balance.token,
      total: balance.total,
      spendable: 0n,
      maturing: 0n,
      maturityKnown: false,
    }));
  }
}

describe('bank panel — error mapping', () => {
  it('maps an unmapped throw to the generic failure rather than leaking it', async () => {
    const operations = fake();
    vi.spyOn(operations, 'prepare').mockRejectedValue(new Error('RPC 500: upstream exploded'));
    const seen: ShellFailure[] = [];
    const panel = await openPanel(operations, { onError: (error) => seen.push(error) });
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();

    const flow = panel.store.getState().flow;
    expect(flow.name === 'failed' && flow.message).toBe(COPY.errors.unknown);
    expect(flow.name === 'failed' && flow.message).not.toContain('RPC 500');
    expect(seen[0]?.kind).toBe('unknown');
  });
});

describe('bank panel — disclosure follows the batch, not the controls', () => {
  it('keeps the shield disclosure on the commit surface after a tab switch', async () => {
    const panel = await openPanel(fake());
    panel.setAmount('1');
    await panel.addToBatch();

    // The player queues a shield, then wanders to another tab. What is queued
    // has not changed, so what must be disclosed has not changed either.
    panel.setMode('transfer');
    expect(panel.store.getState().disclosure).toBeNull();
    expect(panel.store.getState().batchDisclosures).toEqual([SHIELD_DISCLOSURE]);

    await panel.prepare();
    const flow = panel.store.getState().flow;
    expect(flow.name).toBe('review');
    expect(flow.name === 'review' && flow.summary.disclosures).toEqual([SHIELD_DISCLOSURE]);
  });

  it('carries the register string verbatim, not a copy of it', async () => {
    const panel = await openPanel(fake());
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();

    const flow = panel.store.getState().flow;
    const registerEntry = PRIVACY_REGISTER.find((entry) => entry.route === 'bank.shield');
    expect(flow.name === 'review' && flow.summary.disclosures[0]).toBe(registerEntry?.disclosure);
  });

  it('discloses nothing for a batch of private transfers', async () => {
    const panel = await openPanel(fake());
    panel.setMode('transfer');
    panel.setRecipient(BOB);
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();

    const flow = panel.store.getState().flow;
    expect(flow.name === 'review' && flow.summary.disclosures).toEqual([]);
  });

  it('keeps the disclosures on screen while the wallet works', async () => {
    const operations = fake({ latencyMs: 2 });
    const panel = await openPanel(operations);
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();

    const submitting = panel.confirm();
    const flow = panel.store.getState().flow;
    expect(flow.name).toBe('submitting');
    expect(flow.name === 'submitting' && flow.summary.disclosures).toEqual([SHIELD_DISCLOSURE]);
    await submitting;
  });
});

describe('bank panel — one attempt at a time', () => {
  it('ignores a second confirm rather than submitting twice', async () => {
    const operations = fake({ latencyMs: 2 });
    const panel = await openPanel(operations);
    panel.setMode('transfer');
    panel.setRecipient(BOB);
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();

    // Both clicks land in the same tick, before any re-render could disable
    // the button. The synchronous move out of `review` is the actual guard.
    await Promise.all([panel.confirm(), panel.confirm()]);

    expect(operations.submitted).toHaveLength(1);
    expect(panel.store.getState().flow.name).toBe('submitted');
  });

  it('never overwrites a settled submission with a late failure', async () => {
    const operations = fake({ latencyMs: 2 });
    operations.injectFault({ kind: 'unreachable', on: 'confirm' });
    const panel = await openPanel(operations);
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();

    const abandoned = panel.confirm();
    // The player gives up and goes back to the counter while it is in flight.
    panel.cancelPrepared();
    await abandoned;

    // Telling someone "nothing was signed" about a state they have left is the
    // failure this guard exists for.
    expect(panel.store.getState().flow.name).toBe('composing');
  });

  it('a panel closed mid-submission does not reopen into a stale result', async () => {
    const operations = fake({ latencyMs: 2 });
    const panel = await openPanel(operations);
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();

    const inFlight = panel.confirm();
    panel.close();
    await inFlight;

    expect(panel.store.getState().flow.name).toBe('idle');
  });

  it('does not start a fee-classification read after the panel closes', async () => {
    let entered!: () => void;
    let reject!: (error: unknown) => void;
    const insideConfirm = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const result = new Promise<never>((_resolve, fail) => {
      reject = fail;
    });
    const operations = fake();
    const poolConfig = vi.spyOn(operations, 'poolConfig');
    const realPrepare = operations.prepare.bind(operations);
    vi.spyOn(operations, 'prepare').mockImplementation(async (intents, signal) => {
      const batch = await realPrepare(intents, signal);
      return {
        ...batch,
        async confirm() {
          entered();
          return result;
        },
      };
    });
    const panel = await openPanel(operations);
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();

    const confirming = panel.confirm();
    await insideConfirm;
    const readsBeforeClose = poolConfig.mock.calls.length;
    panel.close();
    reject(new PrivacyError('unknown', 'ceiling'));
    await confirming;

    expect(panel.store.getState().flow.name).toBe('idle');
    expect(poolConfig).toHaveBeenCalledTimes(readsBeforeClose);
  });

  it('queues one intent when Add is double-clicked', async () => {
    const panel = await openPanel(fake());
    panel.setMode('transfer');
    panel.setRecipient(BOB);
    panel.setAmount('1');

    await Promise.all([panel.addToBatch(), panel.addToBatch()]);

    expect(panel.store.getState().batch).toHaveLength(1);
    expect(panel.store.getState().adding).toBe(false);
  });
});

describe('bank panel — confirmation ownership', () => {
  async function startTwoConfirmations() {
    const receipts = createReceiptLedger();
    const operations = fake();
    const gates = gatePreparedConfirmations(operations);
    const panel = await openPanel(operations, { receipts });
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();
    const first = panel.confirm();
    await gates.first.entered.promise;
    panel.cancelPrepared();
    await panel.prepare();
    const second = panel.confirm();
    await gates.second.entered.promise;
    return { first, second, gates, operations, panel, receipts };
  }

  it('keeps a newer batch owned when an older confirmation resolves', async () => {
    const { first, second, gates, operations, panel, receipts } = await startTwoConfirmations();

    gates.first.settled.resolve(undefined);
    await first;
    gates.second.settled.reject(new PrivacyError('unknown', 'new confirmation failed'));
    await second;

    expect(gates.discardCounts[1]).toBe(1);
    expect(operations.submitted).toHaveLength(1);
    expect(receipts.pending('bank')).toHaveLength(1);
  });

  it('keeps a newer signing batch alive when an older confirmation rejects', async () => {
    const { first, second, gates, operations, panel, receipts } = await startTwoConfirmations();

    gates.first.settled.reject(new PrivacyError('unreachable', 'stale confirmation failed'));
    await first;
    panel.close();
    gates.second.settled.resolve(undefined);
    await second;

    expect(operations.submitted).toHaveLength(1);
    expect(receipts.pending('bank')).toHaveLength(1);
  });

  it('disposes a newer prepared batch that never enters wallet handoff', async () => {
    const receipts = createReceiptLedger();
    const operations = fake();
    const gates = gatePreparedConfirmations(operations);
    const panel = await openPanel(operations, { receipts });
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();
    const first = panel.confirm();
    await gates.first.entered.promise;

    panel.cancelPrepared();
    await panel.prepare();
    panel.close();
    gates.first.settled.resolve(undefined);
    await first;

    expect(gates.discardCounts[1]).toBe(1);
    expect(operations.submitted).toHaveLength(1);
    expect(receipts.pending('bank')).toHaveLength(1);
  });
});

describe('bank panel — after a submission', () => {
  it('offers the way back to the counter', async () => {
    const panel = await openPanel(fake());
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();
    await panel.confirm();
    expect(panel.store.getState().flow.name).toBe('submitted');

    panel.acknowledge();
    expect(panel.store.getState().flow.name).toBe('composing');
    expect(panel.store.getState().batch).toHaveLength(0);
  });

  it('acknowledge does nothing from any other state', async () => {
    const panel = await openPanel(fake());
    panel.acknowledge();
    expect(panel.store.getState().flow.name).toBe('composing');
  });
});

describe('bank panel — D-035 balance-check gate', () => {
  it('fails closed when an untyped caller omits the gate policy', async () => {
    const operations = fake();
    const prepare = vi.spyOn(operations, 'prepare');
    const panel = createBankPanel({
      operations,
      receipts: createReceiptLedger(),
    } as unknown as BankPanelOptions);
    await panel.open();
    panel.setAmount('1');

    await panel.addToBatch();
    await panel.prepare();

    expect(panel.store.getState().batch).toHaveLength(0);
    expect(prepare).not.toHaveBeenCalled();
    expect(operations.submitted).toHaveLength(0);
  });

  it('blocks add, prepare and confirm after the session gate closes, then re-enables after acknowledgement', async () => {
    const operations = fake();
    let allowed = true;
    const panel = await openPanel(operations, { canStartFinancialAction: () => allowed });
    panel.setAmount('1');

    allowed = false;
    const prepare = vi.spyOn(operations, 'prepare');
    await panel.addToBatch();
    expect(panel.store.getState().batch).toHaveLength(0);
    expect(prepare).not.toHaveBeenCalled();

    allowed = true;
    await panel.addToBatch();
    expect(panel.store.getState().batch).toHaveLength(1);
    await panel.prepare();
    expect(prepare).toHaveBeenCalledOnce();
    expect(panel.store.getState().flow.name).toBe('review');

    allowed = false;
    prepare.mockClear();
    const poolConfig = vi.spyOn(operations, 'poolConfig');
    await panel.prepare();
    expect(prepare).not.toHaveBeenCalled();
    expect(panel.store.getState().flow.name).toBe('review');

    await panel.confirm();
    expect(poolConfig).not.toHaveBeenCalled();
    expect(operations.submitted).toHaveLength(0);

    allowed = true;
    await panel.confirm();
    expect(operations.submitted).toHaveLength(1);
  });
});

describe('bank panel — a receipt outlives the room', () => {
  /**
   * The panel's lifecycle is not the player's decision: the world emits
   * `building:exited` and `VisitLayer` unmounts the window. If the hash lived in
   * panel state, a transaction that settled during that would leave the player
   * with nothing at all.
   *
   * These tests target the window **after** the wallet has been handed the
   * batch, which is the one that loses money-shaped information. The
   * pre-signing window is covered above and is safe by construction: nothing
   * was signed, so there is nothing to lose.
   */

  /**
   * Hold the seam inside `PreparedBatch.confirm()` so the close lands mid-sign.
   * `entered` resolves when the wallet has been handed the batch; `release`
   * lets it settle. No timers, so no ordering left to chance.
   */
  function gateSigning(operations: FakePrivacyOperations): {
    entered: Promise<void>;
    release: () => void;
  } {
    let onEntered!: () => void;
    let onRelease!: () => void;
    const entered = new Promise<void>((resolve) => {
      onEntered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      onRelease = resolve;
    });

    const realPrepare = operations.prepare.bind(operations);
    vi.spyOn(operations, 'prepare').mockImplementation(async (intents, signal) => {
      const batch = await realPrepare(intents, signal);
      return {
        ...batch,
        async confirm(options) {
          onEntered();
          await held;
          return batch.confirm(options);
        },
      };
    });

    return { entered, release: onRelease };
  }

  it('records the hash even when the room closes while the wallet is signing', async () => {
    const receipts = createReceiptLedger();
    const operations = fake();
    const gate = gateSigning(operations);
    const panel = createBankPanel({
      operations,
      receipts,
      canStartFinancialAction: allowFinancialActions,
    });
    await panel.open();
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();

    const inFlight = panel.confirm();
    await gate.entered;
    // The world pulls the player out of the building mid-signature.
    panel.close();
    gate.release();
    await inFlight;

    // The transaction settled. Losing the receipt is not an option.
    expect(operations.submitted).toHaveLength(1);
    expect(receipts.pending('bank')).toHaveLength(1);
    expect(receipts.pending('bank')[0]?.transactionHash).toMatch(/^0xfake/);
    expect(receipts.pending('bank')[0]?.intents).toHaveLength(1);
    // And the closed panel was not written into.
    expect(panel.store.getState().flow.name).toBe('idle');
  });

  it('keeps a remounted newer composition authoritative after a stale success', async () => {
    const receipts = createReceiptLedger();
    const operations = fake();
    const accumulator = createBatchAccumulator();
    const gate = gateSigning(operations);
    const panel = createBankPanel({
      operations,
      receipts,
      accumulator,
      canStartFinancialAction: allowFinancialActions,
    });
    await panel.open();
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();

    const stale = panel.confirm();
    await gate.entered;
    panel.close();

    await panel.open();
    panel.setAmount('2');
    await panel.addToBatch();
    await panel.prepare();
    expect(accumulator.intents).toHaveLength(1);
    expect(accumulator.intents[0]).toMatchObject({ kind: 'shield', amount: strk('2') });

    gate.release();
    await stale;

    expect(receipts.pending('bank')).toHaveLength(1);
    expect(panel.store.getState().flow.name).toBe('review');
    expect(accumulator.intents).toHaveLength(1);
    expect(accumulator.intents[0]).toMatchObject({ kind: 'shield', amount: strk('2') });

    panel.cancelPrepared();
    await panel.prepare();
    const flow = panel.store.getState().flow;
    expect(flow.name).toBe('review');
    expect(flow.name === 'review' && flow.summary.intents[0]).toMatchObject({
      kind: 'shield',
      amount: strk('2'),
    });
  });

  it('owns Post Office pending and submitted receipts by building, while Bank stays Bank', async () => {
    const receipts = createReceiptLedger();
    const operations = fake();
    receipts.record({ building: 'post-office', transactionHash: '0xpending-post-office', intents: [] });

    const postOffice = await openPanel(operations, {
      receipts,
      allowedModes: ['transfer'],
      initialMode: 'transfer',
      building: 'post-office',
    });
    expect(postOffice.store.getState()).toMatchObject({
      flow: { name: 'submitted', transactionHash: '0xpending-post-office', restored: true },
      mode: 'transfer',
      routeId: 'post-office.transfer',
    });
    postOffice.acknowledge();

    postOffice.setRecipient(BOB);
    postOffice.setAmount('1');
    await postOffice.addToBatch();
    await postOffice.prepare();
    await postOffice.confirm();
    expect(receipts.pending('post-office')).toHaveLength(1);
    expect(receipts.pending('post-office')[0]?.transactionHash).toMatch(/^0xfake/);
    expect(receipts.pending('bank')).toHaveLength(0);

    const bank = await openPanel(operations, { receipts });
    bank.setAmount('1');
    await bank.addToBatch();
    await bank.prepare();
    await bank.confirm();
    expect(receipts.pending('bank')).toHaveLength(1);
    expect(receipts.pending('post-office')).toHaveLength(1);
  });

  it('shows an outstanding receipt when the room reopens', async () => {
    const receipts = createReceiptLedger();
    const operations = fake();
    const gate = gateSigning(operations);
    const first = createBankPanel({
      operations,
      receipts,
      canStartFinancialAction: allowFinancialActions,
    });
    await first.open();
    first.setAmount('1');
    await first.addToBatch();
    await first.prepare();
    const inFlight = first.confirm();
    await gate.entered;
    first.close();
    gate.release();
    await inFlight;

    // VisitLayer builds a new machine on remount, so the receipt has to be
    // found rather than remembered.
    vi.restoreAllMocks();
    const reopened = createBankPanel({
      operations,
      receipts,
      canStartFinancialAction: allowFinancialActions,
    });
    await reopened.open();

    const flow = reopened.store.getState().flow;
    expect(flow.name).toBe('submitted');
    expect(flow.name === 'submitted' && flow.transactionHash).toBe(
      receipts.pending('bank')[0]?.transactionHash,
    );
    // Restored, not just confirmed this session — the room was shut when it settled.
    expect(flow.name === 'submitted' && flow.restored).toBe(true);

    reopened.acknowledge();
    expect(receipts.pending('bank')).toHaveLength(0);
    expect(reopened.store.getState().flow.name).toBe('composing');
  });

  it('opens straight into composing when nothing is outstanding', async () => {
    const receipts = createReceiptLedger();
    const panel = createBankPanel({
      operations: fake(),
      receipts,
      canStartFinancialAction: allowFinancialActions,
    });
    await panel.open();
    expect(panel.store.getState().flow.name).toBe('composing');
  });

  it('does not re-show a receipt the player has already seen', async () => {
    const receipts = createReceiptLedger();
    const operations = fake();
    const panel = createBankPanel({
      operations,
      receipts,
      canStartFinancialAction: allowFinancialActions,
    });
    await panel.open();
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();
    await panel.confirm();
    panel.acknowledge();
    panel.close();

    const reopened = createBankPanel({
      operations,
      receipts,
      canStartFinancialAction: allowFinancialActions,
    });
    await reopened.open();
    expect(reopened.store.getState().flow.name).toBe('composing');
  });
});

describe('bank panel — a finished read cannot write the wrong figure', () => {
  /** A promise the test releases, so ordering is decided here and not by a timer. */
  function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  const loaded = (amount: bigint): PrivateBalance[] => [
    { token: STRK, total: amount, spendable: amount, maturing: 0n, maturityKnown: true },
  ];

  it('a balance read in flight when a submission lands does not restore the old figure', async () => {
    const operations = fake();
    const gate = deferred<PrivateBalance[]>();
    vi.spyOn(operations, 'balances').mockReturnValue(gate.promise);

    const panel = await openPanel(operations);
    const read = panel.refreshBalance();

    await panel.prepare.call(panel); // no batch yet: harmless, keeps ordering explicit
    panel.setMode('transfer');
    panel.setRecipient(BOB);
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();
    await panel.confirm();
    expect(panel.store.getState().flow.name).toBe('submitted');

    // The read now finishes, carrying the pre-submission figure.
    gate.resolve(loaded(strk('100')));
    await read;

    // Showing it would contradict the notice sitting next to it.
    expect(panel.store.getState().balance.status).toBe('unrequested');
    expect(panel.store.getState().notice?.text).toBe(COPY.balance.changed);
  });

  it('a balance read that finishes after close does not write into a shut room', async () => {
    const operations = fake();
    const gate = deferred<PrivateBalance[]>();
    vi.spyOn(operations, 'balances').mockReturnValue(gate.promise);

    const panel = await openPanel(operations);
    const read = panel.refreshBalance();
    panel.close();
    gate.resolve(loaded(strk('100')));
    await read;

    expect(panel.store.getState().balance.status).toBe('unrequested');
    expect(panel.store.getState().flow.name).toBe('idle');
  });

  it('a preflight that finishes after close does not queue an intent', async () => {
    const operations = fake();
    const gate = deferred<'registered'>();
    vi.spyOn(operations, 'recipientStatus').mockReturnValue(gate.promise);

    const panel = await openPanel(operations);
    panel.setMode('transfer');
    panel.setRecipient(BOB);
    panel.setAmount('1');
    const adding = panel.addToBatch();
    panel.close();
    gate.resolve('registered');
    await adding;

    expect(panel.store.getState().batch).toHaveLength(0);
    expect(panel.store.getState().adding).toBe(false);
  });

  it('only the newest balance read is allowed to land', async () => {
    const operations = fake();
    const first = deferred<PrivateBalance[]>();
    const second = deferred<PrivateBalance[]>();
    vi.spyOn(operations, 'balances')
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const panel = await openPanel(operations);
    const a = panel.refreshBalance();
    const b = panel.refreshBalance();

    second.resolve(loaded(strk('50')));
    await b;
    first.resolve(loaded(strk('100')));
    await a;

    const balance = panel.store.getState().balance;
    expect(balance.status === 'loaded' && balance.total).toBe(strk('50'));
  });
});

describe('bank panel — a quote is evidence about one batch shape', () => {
  /**
   * The relay fee is charged per action, so the cost of a batch depends on its
   * shape. A quote is therefore evidence about the shape it was taken on and
   * nothing else — there is no interpolation between two observations here,
   * because a fitted curve is still a guess about somebody's money. Unshields
   * show it: they still batch, where a transfer never shares a batch (D-065).
   */

  it('offers a maximum only once the one-spend shape has actually been costed', async () => {
    const operations = fake();
    const panel = await openPanel(operations);
    panel.setMode('unshield');
    await panel.refreshBalance();

    // Nothing costed yet: a MAX would make a one-unshield visit nobody priced.
    expect(panel.maxSpendable()).toBeNull();

    panel.setRecipient(ALICE);
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();
    panel.cancelPrepared();
    panel.removeFromBatch(0);
    await panel.refreshBalance();

    // That shape has now been costed, and the visit is empty again.
    expect(panel.maxSpendable()).not.toBeNull();
  });

  it('forgets the estimate when the mode changes the shape', async () => {
    const operations = fake();
    const panel = await openPanel(operations);
    panel.setMode('transfer');
    panel.setRecipient(BOB);
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();
    panel.cancelPrepared();
    panel.clearBatch();
    await panel.refreshBalance();
    expect(panel.maxSpendable()).not.toBeNull();

    // An unshield is a differently shaped batch, and no unshield has been costed.
    panel.setMode('unshield');
    expect(panel.store.getState().quotedGasForNextIntent).toBeNull();
    expect(panel.maxSpendable()).toBeNull();
  });
});

describe('bank panel — a relay with no avnu key (D-070)', () => {
  it.each([
    ['an unshield', 'unshield', ALICE],
    ['a Post Office send', 'transfer', BOB],
    ['a stake', 'stake', null],
  ] as const)('says plainly that %s needs the relay, and keeps the queued item for Back', async (_label, mode, recipient) => {
    const operations = fake();
    const failures: ShellFailure[] = [];
    const panel = await openPanel(operations, { onError: (failure) => failures.push(failure) });
    operations.injectFault({ kind: 'relay-not-configured', on: 'prepare' });
    panel.setMode(mode);
    if (recipient) panel.setRecipient(recipient);
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();

    expect(panel.store.getState().flow).toEqual({
      name: 'failed',
      kind: 'relay-not-configured',
      message: COPY.errors['relay-not-configured'],
      recovery: 'prepare-again',
    });
    expect(failures.map((failure) => failure.kind)).toEqual(['relay-not-configured']);
    expect(panel.store.getState().batch.map((intent) => intent.kind)).toEqual([mode]);
    expect(operations.submitted).toHaveLength(0);
  });

  it('tells a player adding a shield behind the failed spend to remove it first', async () => {
    const operations = fake();
    const panel = await openPanel(operations);
    panel.setMode('unshield');
    panel.setRecipient(ALICE);
    panel.setAmount('1');
    await panel.addToBatch();
    operations.injectFault({ kind: 'relay-not-configured', on: 'prepare' });
    await panel.prepare();
    panel.cancelPrepared();

    panel.setMode('shield');
    panel.setAmount('1');
    await panel.addToBatch();
    expect(panel.store.getState().notice).toEqual({ tone: 'error', text: COPY.notices.shieldAfterSpend });
    expect(panel.store.getState().batch.map((intent) => intent.kind)).toEqual(['unshield']);

    // Doing what it says works: the shield queues once the spend is gone.
    panel.removeFromBatch(0);
    await panel.addToBatch();
    expect(panel.store.getState().batch.map((intent) => intent.kind)).toEqual(['shield']);
    expect(panel.store.getState().notice).toBeNull();
  });
});

describe('bank panel — debug steps (D-070)', () => {
  function captureBankSteps(): { steps: unknown[]; detach: () => void } {
    const steps: unknown[] = [];
    attachDebugTap({
      failure: () => undefined,
      connectState: () => undefined,
      walletSession: () => undefined,
      visit: () => undefined,
      bank: (step) => steps.push(step),
      sandboxBurst: () => undefined,
      gate: () => undefined,
    });
    return { steps, detach: () => attachDebugTap(null) };
  }

  it('reports mode switches, refused adds, the prepare and each confirm stage, by code alone', async () => {
    const { steps, detach } = captureBankSteps();
    try {
      const operations = fake();
      const panel = await openPanel(operations);
      panel.setMode('unshield');
      panel.setMode('unshield');
      panel.setRecipient(ALICE);
      panel.setAmount('lots');
      await panel.addToBatch();
      panel.setAmount('1.5');
      await panel.addToBatch();
      panel.setMode('shield');
      panel.setAmount('2');
      await panel.addToBatch();
      panel.setMode('unshield');
      await panel.prepare();
      await panel.confirm();
      expect(panel.store.getState().flow.name).toBe('submitted');
    } finally {
      detach();
    }

    expect(steps).toEqual([
      // Re-selecting the same tab is not a switch.
      { step: 'mode', mode: 'unshield', from: 'shield' },
      { step: 'add-refused', reason: 'bad-amount' },
      { step: 'mode', mode: 'shield', from: 'unshield' },
      { step: 'add-refused', reason: 'mixed-shield-and-spend' },
      { step: 'mode', mode: 'unshield', from: 'shield' },
      { step: 'prepare', kinds: ['unshield'] },
      { step: 'confirm', stage: 'composing' },
      { step: 'confirm', stage: 'awaiting-approval' },
      { step: 'confirm', stage: 'proving' },
      { step: 'confirm', stage: 'submitting' },
      { step: 'confirm', stage: 'done' },
      { step: 'confirm', stage: 'submitted' },
    ]);
    // Never the money: no amount, balance, recipient or token address.
    const sent = JSON.stringify(steps);
    expect(sent).not.toMatch(/0x|1\.5|lots|\d/);
  });

  it('names how a confirm ended when it ended here, and each refusal before the accumulator', async () => {
    const { steps, detach } = captureBankSteps();
    try {
      const operations = fake();
      const panel = await openPanel(operations);
      panel.setMode('transfer');
      panel.setRecipient('not an address');
      panel.setAmount('1');
      await panel.addToBatch();
      panel.setRecipient(STRANGER);
      await panel.addToBatch();
      panel.setRecipient(BOB);
      await panel.addToBatch();
      await panel.prepare();
      operations.setPoolFee(strk('20'));
      await panel.confirm();
      expect(panel.store.getState().flow).toMatchObject({ name: 'failed', message: COPY.notices.feeMoved });
    } finally {
      detach();
    }
    expect(steps).toEqual([
      { step: 'mode', mode: 'transfer', from: 'shield' },
      { step: 'add-refused', reason: 'bad-recipient' },
      { step: 'add-refused', reason: 'recipient-unregistered' },
      { step: 'prepare', kinds: ['transfer'] },
      { step: 'confirm', stage: 'composing' },
      { step: 'confirm', stage: 'fee-moved' },
    ]);
  });

  it('sends nothing, and changes nothing, with no logger attached', async () => {
    attachDebugTap(null);
    const operations = fake();
    const panel = await openPanel(operations);
    panel.setMode('unshield');
    panel.setRecipient(ALICE);
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();
    await panel.confirm();
    expect(panel.store.getState().flow.name).toBe('submitted');
  });
});
