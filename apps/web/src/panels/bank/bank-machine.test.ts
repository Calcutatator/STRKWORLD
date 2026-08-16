import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FakePrivacyOperations,
  PrivacyError,
  type Address,
  type PrivacyOperations,
  type PrivateBalance,
} from '@strkworld/privacy';
import { COPY } from '../../copy.js';
import { formatTokenAmountExact, parseTokenAmount } from '../../format.js';
import { createConnectFlow } from '../../connect/connect-machine.js';
import { createBankPanel, type BankPanel } from './bank-machine.js';

const STRK: Address = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const BOB: Address = '0x02b4c7d1a1f8f39e0e6e8b9a2c7d0e3f4a5b6c7d8e9f0a1b2c3d4e5f60718293';
const STRANGER: Address = '0x0111111111111111111111111111111111111111111111111111111111111111';

const POOL_FEE = 6_000000000000000000n;
const strk = (whole: string) => parseTokenAmount(whole)!;

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
  const panel = createBankPanel({ operations, ...options });
  await panel.open();
  return panel;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('bank panel — entering the room', () => {
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
    // A private transfer needs no disclosure — the register says so.
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

  it('offers a maximum that leaves the live pool fee behind', async () => {
    const panel = await openPanel(fake());
    await panel.refreshBalance();
    panel.setMode('transfer');

    expect(panel.maxSpendable()).toBe(strk('100') - POOL_FEE);
    panel.applyMax();
    expect(panel.store.getState().amountText).toBe(formatTokenAmountExact(strk('100') - POOL_FEE));
  });

  it('never derives a maximum when the wallet reports only an aggregate (D-022)', async () => {
    const panel = await openPanel(new AggregateOnlyOperations(fake()));
    await panel.refreshBalance();
    panel.setMode('transfer');

    const balance = panel.store.getState().balance;
    expect(balance.status === 'loaded' && balance.maturityKnown).toBe(false);
    expect(balance.status === 'loaded' && balance.total).toBe(strk('100'));
    expect(panel.maxSpendable()).toBeNull();

    panel.applyMax();
    expect(panel.store.getState().amountText).toBe('');
    expect(panel.store.getState().notice?.text).toBe(COPY.balance.maturityUnknown);
  });

  it('offers no maximum for a shield — the shell cannot see public funds', async () => {
    const panel = await openPanel(fake());
    await panel.refreshBalance();
    expect(panel.store.getState().mode).toBe('shield');
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

describe('bank panel — composing a visit', () => {
  it('queues several transfers and settles them as one submission', async () => {
    const operations = fake();
    const panel = await openPanel(operations);
    panel.setMode('transfer');

    panel.setRecipient(BOB);
    panel.setAmount('1');
    await panel.addToBatch();
    panel.setRecipient(BOB);
    panel.setAmount('2');
    await panel.addToBatch();

    expect(panel.store.getState().batch).toHaveLength(2);
    await panel.prepare();
    await panel.confirm();

    expect(operations.submitted).toHaveLength(1);
    expect(operations.submitted[0]).toHaveLength(2);
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

    // The shell's pre-check sees the old fee; the wallet-side guard is what
    // actually stops the signature.
    const stale = await operations.poolConfig();
    operations.setPoolFee(strk('20'));
    vi.spyOn(operations, 'poolConfig').mockResolvedValue(stale);
    await panel.confirm();

    expect(panel.store.getState().flow.name).toBe('failed');
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
    const seen: PrivacyError[] = [];
    const panel = await openPanel(operations, { onError: (error) => seen.push(error) });
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();

    const flow = panel.store.getState().flow;
    expect(flow.name === 'failed' && flow.message).toBe(COPY.errors.unknown);
    expect(flow.name === 'failed' && flow.message).not.toContain('RPC 500');
    expect(seen[0]).toBeInstanceOf(PrivacyError);
  });
});
