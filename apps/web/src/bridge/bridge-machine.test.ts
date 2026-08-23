import { describe, expect, it, vi } from 'vitest';
import type { QuoteResponse } from '@defuse-protocol/one-click-sdk-typescript';
import type { BridgeRecord, BridgeStatus, SourceAsset } from '@strkworld/bridge';
import { createBridgePanel, STRK_TOKEN } from './bridge-machine.js';
import type { PublicShieldPlan, PublicShieldPlanner, PublicShieldPlanInput } from '@strkworld/privacy';
import { COPY } from '../copy.js';

const SOURCE: SourceAsset = {
  assetId: 'nep141:arb-usdc.omft.near', symbol: 'USDC', chainName: 'arbitrum', decimals: 6, depositMode: 'manual',
};
const ACCOUNT = '0x0123';
const signedQuote = {
  correlationId: 'corr', timestamp: '2026-08-18T00:00:00.000Z', signature: 'sig',
  quoteRequest: { dry: false, swapType: 'EXACT_INPUT', slippageTolerance: 100, originAsset: SOURCE.assetId, depositType: 'ORIGIN_CHAIN', destinationAsset: 'nep141:starknet.omft.near', amount: '1000000', refundTo: '0x1111111111111111111111111111111111111111', refundType: 'ORIGIN_CHAIN', recipient: ACCOUNT, recipientType: 'DESTINATION_CHAIN', deadline: '2030-08-18T00:30:00.000Z' },
  quote: { depositAddress: '0xdeposit', amountIn: '1000000', amountInFormatted: '1', amountInUsd: '1', amountOutUsd: '1', minAmountIn: '1000000', amountOut: '2000000000000000000', amountOutFormatted: '2', minAmountOut: '1900000000000000000', deadline: '2030-08-18T00:30:00.000Z', timeEstimate: 60 },
} as unknown as QuoteResponse;

function record(status: BridgeStatus = { leg: 'awaiting-deposit', message: 'waiting', pollingStopped: false }): BridgeRecord {
  return { v: 1, createdAt: 1, updatedAt: 1, source: SOURCE, amountIn: 1_000_000n, starknetRecipient: ACCOUNT, refundAddress: '0x1111111111111111111111111111111111111111', signedQuote, status };
}

function plan(available: bigint, amountToShield = available - 7n): PublicShieldPlan {
  return { token: STRK_TOKEN, recipient: '0x123', available, amountToShield, poolFee: 6n, gasEstimate: 1n, plannedReserve: 7n };
}

function harness(initial: BridgeRecord | null = null, planner: PublicShieldPlanner | null = { planMax: vi.fn(async ({ available }: PublicShieldPlanInput) => plan(available)) }, options: { now?: () => number; readAccount?: () => string | null | Promise<string | null> } = {}) {
  let saved = initial;
  const calls = { quote: 0, refresh: 0, watch: 0, sources: 0 };
  const service = {
    resume: () => saved,
    createManualDeposit: vi.fn(async () => { calls.quote += 1; saved = record(); return saved; }),
    refresh: vi.fn(async (): Promise<BridgeStatus> => { calls.refresh += 1; return saved?.status ?? { leg: 'awaiting-deposit', message: 'waiting', pollingStopped: false }; }),
    watch: vi.fn(async ({ onUpdate }: { onUpdate?: (status: BridgeStatus) => void }): Promise<BridgeStatus> => { calls.watch += 1; const status = saved?.status ?? { leg: 'awaiting-deposit', message: 'waiting', pollingStopped: false } as BridgeStatus; onUpdate?.(status); return status; }),
    exportResumeRecord: vi.fn(() => 'sensitive-record'),
    importResumeRecord: vi.fn(() => { saved = record(); return saved; }),
    discard: vi.fn(() => { saved = null; }),
  };
  const machine = createBridgePanel({ service, loadSources: async () => { calls.sources += 1; return [SOURCE]; }, readAccount: options.readAccount ?? (() => ACCOUNT), planner, now: options.now });
  return { machine, calls, service, planner, setSaved: (next: BridgeRecord | null) => { saved = next; }, get saved() { return saved; } };
}

describe('Bridge shell machine', () => {
  it('opens local evidence and sources without quoting, polling or wallet work', async () => {
    const h = harness();
    await h.machine.open();
    expect(h.calls.sources).toBe(1);
    expect(h.calls.quote).toBe(0);
    expect(h.calls.refresh).toBe(0);
    expect(h.calls.watch).toBe(0);
    expect(h.machine.store.getState().record).toBeNull();
  });

  it('binds a quote to the normalized active account and preflights signed minimum before instructions', async () => {
    const h = harness();
    await h.machine.createQuote({ source: SOURCE, amountIn: 1_000_000n, refundAddress: '0x1111111111111111111111111111111111111111' });
    expect(h.service.createManualDeposit).toHaveBeenCalledWith(expect.objectContaining({ starknetRecipient: '0x123' }));
    expect(h.planner?.planMax).toHaveBeenCalledWith(expect.objectContaining({ available: 1_900_000_000_000_000_000n, expectedRecipient: '0x123' }));
    expect(h.machine.store.getState().instructionsVisible).toBe(true);
  });

  it('retains signed evidence but hides executable instructions when preflight fails', async () => {
    const h = harness(null, { planMax: async () => { throw new Error('planner unavailable'); } });
    await h.machine.createQuote({ source: SOURCE, amountIn: 1_000_000n, refundAddress: '0x1111111111111111111111111111111111111111' });
    expect(h.machine.store.getState().record).not.toBeNull();
    expect(h.machine.store.getState().instructionsVisible).toBe(false);
    expect(h.machine.store.getState().flow).toMatchObject({ name: 'failed' });
  });

  it('requires an explicit fresh preflight before exposing a resumed quote', async () => {
    const h = harness(record());
    await h.machine.open();
    expect(h.machine.store.getState().record).not.toBeNull();
    expect(h.machine.store.getState().instructionsVisible).toBe(false);
    await h.machine.preflightSavedQuote();
    expect(h.machine.store.getState().instructionsVisible).toBe(true);
  });

  it('does not continue saved preflight after close while reading the account', async () => {
    let releaseAccount!: (value: string | null) => void;
    let accountRead = false;
    let accountDeferred = true;
    const planner: PublicShieldPlanner = { planMax: vi.fn(async ({ available }: PublicShieldPlanInput) => plan(available)) };
    const h = harness(record(), planner, {
      now: () => Date.parse('2030-01-01T00:00:00.000Z'),
      readAccount: () => {
        accountRead = true;
        if (!accountDeferred) return ACCOUNT;
        return new Promise<string | null>((resolve) => { releaseAccount = (value) => { accountDeferred = false; resolve(value); }; });
      },
    });
    const preflight = h.machine.preflightSavedQuote();
    await Promise.resolve();
    expect(accountRead).toBe(true);
    h.machine.close();
    const closedState = h.machine.store.getState();
    releaseAccount(ACCOUNT);
    await preflight;
    expect(planner.planMax).not.toHaveBeenCalled();
    expect(h.machine.store.getState()).toEqual(closedState);
  });

  it('resumes a saved quote by refreshing status before exposing the next safe action', async () => {
    const h = harness(record());
    await h.machine.open();
    await h.machine.resumeSavedQuote();
    expect(h.calls.refresh).toBe(1);
    expect(h.planner?.planMax).toHaveBeenCalledWith(expect.objectContaining({
      available: 1_900_000_000_000_000_000n,
      expectedRecipient: '0x123',
    }));
    expect(h.machine.store.getState().instructionsVisible).toBe(true);
  });

  it('does not run deposit preflight after resume has reached a settled leg', async () => {
    const h = harness(record({ leg: 'settled', message: 'settled', pollingStopped: true, strkReceived: 1_234n }));
    await h.machine.resumeSavedQuote();
    expect(h.calls.refresh).toBe(1);
    expect(h.planner?.planMax).not.toHaveBeenCalled();
    expect(h.machine.store.getState().instructionsVisible).toBe(false);
    expect(h.machine.store.getState().record?.status.leg).toBe('settled');
  });

  it('uses actual settled STRK, never quote output, for a shield plan', async () => {
    const planner: PublicShieldPlanner = { planMax: vi.fn(async ({ available }: PublicShieldPlanInput) => plan(available)) };
    const h = harness(record({ leg: 'settled', message: 'settled', pollingStopped: true, strkReceived: 1_234n }), planner);
    await h.machine.planShield();
    expect(h.planner?.planMax).toHaveBeenCalledWith(expect.objectContaining({ available: 1_234n }));
    expect(h.machine.store.getState().plan?.available).toBe(1_234n);
  });

  it('rejects a changed fresh plan at the commit guard', async () => {
    const planner: PublicShieldPlanner = { planMax: vi.fn(async ({ available }: PublicShieldPlanInput) => plan(available)) };
    const h = harness(record({ leg: 'settled', message: 'settled', pollingStopped: true, strkReceived: 1_234n }), planner);
    await h.machine.planShield();
    planner.planMax = vi.fn(async ({ available }: PublicShieldPlanInput) => plan(available, available - 8n));
    expect(await h.machine.revalidateShieldPlan()).toBeNull();
    const flow = h.machine.store.getState().flow;
    expect(flow.name === 'failed' ? flow.message : null).toContain('fresh shield plan changed');
  });

  it('does not retarget a saved record after an account switch', async () => {
    const h = harness(record({ leg: 'settled', message: 'settled', pollingStopped: true, strkReceived: 1_234n }));
    const switched = createBridgePanel({ service: h.service, loadSources: async () => [], readAccount: () => '0x456', planner: h.planner });
    await switched.planShield();
    expect(switched.store.getState().accountMatchesRecord).toBe(false);
    expect(switched.store.getState().record?.starknetRecipient).toBe(ACCOUNT);
    expect(h.service.discard).not.toHaveBeenCalled();
  });

  it('supports explicit refresh/watch and aborts watch on close', async () => {
    const h = harness(record());
    await h.machine.open();
    await h.machine.refresh();
    expect(h.calls.refresh).toBe(1);
    await h.machine.watch();
    expect(h.calls.watch).toBe(1);
    h.machine.close();
    expect(h.machine.store.getState().flow.name).toBe('idle');
  });

  it('aborts an in-flight watch when the panel closes', async () => {
    let signal: AbortSignal | undefined;
    let release!: () => void;
    const h = harness(record());
    h.service.watch.mockImplementation(async (options: { signal?: AbortSignal; onUpdate?: (status: BridgeStatus) => void }) => {
      signal = options.signal;
      await new Promise<void>((resolve) => { release = resolve; });
      return h.saved?.status ?? { leg: 'awaiting-deposit', message: 'waiting', pollingStopped: false };
    });
    const watching = h.machine.watch();
    await Promise.resolve();
    h.machine.close();
    expect(signal?.aborted).toBe(true);
    release();
    await watching;
    expect(h.machine.store.getState().flow.name).toBe('idle');
  });

  it('keeps recovery explicit through import/export/discard', () => {
    const h = harness(record());
    expect(h.machine.exportRecord()).toBe('sensitive-record');
    h.machine.importRecord('sensitive-record');
    expect(h.machine.store.getState().record).not.toBeNull();
    h.machine.discardRecord();
    expect(h.machine.store.getState().record).toBeNull();
    expect(h.service.discard).toHaveBeenCalledTimes(1);
  });

  it('rejects expired saved evidence without exposing instructions', async () => {
    const planner = { planMax: vi.fn(async ({ available }: PublicShieldPlanInput) => plan(available)) };
    const h = harness(record(), planner, { now: () => Date.parse('2030-08-18T00:31:00.000Z') });
    await h.machine.open();
    await h.machine.preflightSavedQuote();
    expect(planner.planMax).not.toHaveBeenCalled();
    expect(h.machine.store.getState().record).not.toBeNull();
    expect(h.machine.store.getState().instructionsVisible).toBe(false);
  });

  it.each([
    { leg: 'deposit-detected' as const, strkReceived: undefined },
    { leg: 'solver-settling' as const, strkReceived: undefined },
    { leg: 'settled' as const, strkReceived: 2n },
  ])('keeps $leg evidence inspectable but refuses a new deposit preflight', async (status) => {
    const planner = { planMax: vi.fn(async ({ available }: PublicShieldPlanInput) => plan(available)) };
    const h = harness(record({ leg: status.leg, message: status.leg, pollingStopped: status.leg === 'settled', strkReceived: status.strkReceived }), planner, { now: () => Date.parse('2030-01-01T00:00:00.000Z') });
    await h.machine.open();
    await h.machine.preflightSavedQuote();
    expect(planner.planMax).not.toHaveBeenCalled();
    expect(h.machine.store.getState().instructionsVisible).toBe(false);
    expect(h.machine.store.getState().record?.status.leg).toBe(status.leg);
  });

  it('rechecks the active account after quote and planner before showing instructions', async () => {
    let reads = 0;
    let release!: () => void;
    const planner: PublicShieldPlanner = { planMax: vi.fn(async ({ available }: PublicShieldPlanInput) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return plan(available);
    }) };
    const h = harness(null, planner, { now: () => Date.parse('2030-01-01T00:00:00.000Z'), readAccount: () => (++reads === 1 ? ACCOUNT : reads === 2 ? ACCOUNT : '0x456') });
    const quoting = h.machine.createQuote({ source: SOURCE, amountIn: 1_000_000n, refundAddress: '0x1111111111111111111111111111111111111111' });
    await vi.waitFor(() => expect(planner.planMax).toHaveBeenCalled());
    release();
    await quoting;
    expect(h.machine.store.getState().instructionsVisible).toBe(false);
    expect(h.machine.store.getState().flow).toMatchObject({ name: 'failed', message: COPY.bridge.accountChanged });
  });

  it.each(['close', 'discard', 'import'] as const)(
    'does not publish a quote after %s while the final account check is pending',
    async (action) => {
      let reads = 0;
      let releaseFinalAccount!: (value: string | null) => void;
      const finalAccountPending = new Promise<string | null>((resolve) => {
        releaseFinalAccount = resolve;
      });
      const planner: PublicShieldPlanner = {
        planMax: vi.fn(async ({ available }: PublicShieldPlanInput) => plan(available)),
      };
      const h = harness(null, planner, {
        now: () => Date.parse('2030-01-01T00:00:00.000Z'),
        readAccount: () => (++reads < 3 ? ACCOUNT : finalAccountPending),
      });

      const quoting = h.machine.createQuote({
        source: SOURCE,
        amountIn: 1_000_000n,
        refundAddress: '0x1111111111111111111111111111111111111111',
      });
      await vi.waitFor(() => expect(reads).toBe(3));

      if (action === 'close') h.machine.close();
      if (action === 'discard') h.machine.discardRecord();
      if (action === 'import') h.machine.importRecord('sensitive-record');
      const invalidatedState = h.machine.store.getState();
      releaseFinalAccount(ACCOUNT);
      await quoting;

      expect(h.machine.store.getState()).toEqual(invalidatedState);
      expect(h.machine.store.getState().instructionsVisible).toBe(false);
      expect(h.machine.store.getState().plan).toBeNull();
      expect(h.service.discard).toHaveBeenCalledOnce();
      if (action === 'import') {
        expect(h.service.importResumeRecord).toHaveBeenCalledTimes(2);
        expect(h.saved).not.toBeNull();
      } else expect(h.saved).toBeNull();
    },
  );

  it('retains signed evidence when refresh supersedes the final account check', async () => {
    let reads = 0;
    let releaseFinalAccount!: (value: string | null) => void;
    const finalAccountPending = new Promise<string | null>((resolve) => {
      releaseFinalAccount = resolve;
    });
    const planner: PublicShieldPlanner = {
      planMax: vi.fn(async ({ available }: PublicShieldPlanInput) => plan(available)),
    };
    const h = harness(null, planner, {
      now: () => Date.parse('2030-01-01T00:00:00.000Z'),
      readAccount: () => (++reads < 3 ? ACCOUNT : finalAccountPending),
    });

    const quoting = h.machine.createQuote({
      source: SOURCE,
      amountIn: 1_000_000n,
      refundAddress: '0x1111111111111111111111111111111111111111',
    });
    await vi.waitFor(() => expect(reads).toBe(3));

    await h.machine.refresh();
    const refreshedState = h.machine.store.getState();
    releaseFinalAccount(ACCOUNT);
    await quoting;

    expect(h.machine.store.getState()).toEqual(refreshedState);
    expect(h.service.discard).not.toHaveBeenCalled();
    expect(h.saved).not.toBeNull();
  });

  it('rechecks the active account after saved preflight planning', async () => {
    let reads = 0;
    let release!: () => void;
    const planner: PublicShieldPlanner = { planMax: vi.fn(async ({ available }: PublicShieldPlanInput) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return plan(available);
    }) };
    const h = harness(record(), planner, { now: () => Date.parse('2030-01-01T00:00:00.000Z'), readAccount: () => (++reads === 1 ? ACCOUNT : '0x456') });
    const preflight = h.machine.preflightSavedQuote();
    await vi.waitFor(() => expect(planner.planMax).toHaveBeenCalled());
    release();
    await preflight;
    expect(h.machine.store.getState().instructionsVisible).toBe(false);
    expect(h.machine.store.getState().flow.name).toBe('failed');
  });

  it('coalesces same-tick quote creation before account/provider work', async () => {
    let release!: () => void;
    const h = harness(null, { planMax: vi.fn(async ({ available }: PublicShieldPlanInput) => plan(available)) });
    const originalCreate = h.service.createManualDeposit.getMockImplementation()!;
    h.service.createManualDeposit.mockImplementation(async () => {
      await new Promise<void>((resolve) => { release = resolve; });
      return originalCreate();
    });
    const first = h.machine.createQuote({ source: SOURCE, amountIn: 1_000_000n, refundAddress: '0x1111111111111111111111111111111111111111' });
    const second = h.machine.createQuote({ source: SOURCE, amountIn: 1_000_000n, refundAddress: '0x1111111111111111111111111111111111111111' });
    await vi.waitFor(() => expect(h.service.createManualDeposit).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([first, second]);
    expect(h.service.createManualDeposit).toHaveBeenCalledTimes(1);
    expect(h.machine.store.getState().record).not.toBeNull();
  });

  it('revokes instructions when an explicit refresh advances status', async () => {
    const h = harness(record(), undefined, { now: () => Date.parse('2030-01-01T00:00:00.000Z') });
    await h.machine.createQuote({ source: SOURCE, amountIn: 1_000_000n, refundAddress: '0x1111111111111111111111111111111111111111' });
    expect(h.machine.store.getState().instructionsVisible).toBe(true);
    h.setSaved(record({ leg: 'deposit-detected', message: 'detected', pollingStopped: false }));
    await h.machine.refresh();
    expect(h.machine.store.getState().record?.status.leg).toBe('deposit-detected');
    expect(h.machine.store.getState().instructionsVisible).toBe(false);
  });

  it('does not let import replace the record after a preflight is already in flight', async () => {
    let release!: () => void;
    const planner: PublicShieldPlanner = { planMax: vi.fn(async ({ available }: PublicShieldPlanInput) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return plan(available);
    }) };
    const h = harness(record(), planner, { now: () => Date.parse('2030-01-01T00:00:00.000Z') });
    const preflight = h.machine.preflightSavedQuote();
    await vi.waitFor(() => expect(planner.planMax).toHaveBeenCalled());
    h.machine.importRecord('sensitive-record');
    release();
    await preflight;
    expect(h.machine.store.getState().instructionsVisible).toBe(false);
  });

  it('coalesces concurrent shield planning into one fresh plan', async () => {
    let release!: () => void;
    const planner: PublicShieldPlanner = { planMax: vi.fn(async ({ available }: PublicShieldPlanInput) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return plan(available);
    }) };
    const h = harness(record({ leg: 'settled', message: 'settled', pollingStopped: true, strkReceived: 1_234n }), planner);
    const first = h.machine.planShield();
    const second = h.machine.planShield();
    await vi.waitFor(() => expect(planner.planMax).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([first, second]);
    expect(planner.planMax).toHaveBeenCalledTimes(1);
    expect(h.machine.store.getState().flow.name).toBe('ready-to-shield');
  });

  it('does not continue shield planning after close while reading the account', async () => {
    let releaseAccount!: (value: string | null) => void;
    let accountRead = false;
    let accountDeferred = true;
    const planner: PublicShieldPlanner = { planMax: vi.fn(async ({ available }: PublicShieldPlanInput) => plan(available)) };
    const h = harness(record({ leg: 'settled', message: 'settled', pollingStopped: true, strkReceived: 1_234n }), planner, {
      readAccount: () => {
        accountRead = true;
        if (!accountDeferred) return ACCOUNT;
        return new Promise<string | null>((resolve) => { releaseAccount = (value) => { accountDeferred = false; resolve(value); }; });
      },
    });
    const planning = h.machine.planShield();
    await Promise.resolve();
    expect(accountRead).toBe(true);
    h.machine.close();
    const closedState = h.machine.store.getState();
    releaseAccount(ACCOUNT);
    await planning;
    expect(planner.planMax).not.toHaveBeenCalled();
    expect(h.machine.store.getState()).toEqual(closedState);
  });

  it('invalidates a commit guard when the saved evidence is imported during planning', async () => {
    let release!: () => void;
    const planner: PublicShieldPlanner = { planMax: vi.fn(async ({ available }: PublicShieldPlanInput) => {
      await new Promise<void>((resolve) => { release = resolve; });
      return plan(available);
    }) };
    const h = harness(record({ leg: 'settled', message: 'settled', pollingStopped: true, strkReceived: 1_234n }), planner);
    const planning = h.machine.planShield();
    await vi.waitFor(() => expect(planner.planMax).toHaveBeenCalledTimes(1));
    // The first planShield call is the deferred one; import invalidates it.
    h.machine.importRecord('sensitive-record');
    release();
    await planning;
    expect(await h.machine.revalidateShieldPlan()).toBeNull();
  });

  it.each(['close', 'import', 'discard'] as const)('returns null when %s invalidates an in-flight commit guard', async (action) => {
    let defer = false;
    let release!: () => void;
    const planner: PublicShieldPlanner = { planMax: vi.fn(async ({ available }: PublicShieldPlanInput) => {
      if (defer) await new Promise<void>((resolve) => { release = resolve; });
      return plan(available);
    }) };
    const h = harness(record({ leg: 'settled', message: 'settled', pollingStopped: true, strkReceived: 1_234n }), planner);
    await h.machine.planShield();
    defer = true;
    const revalidation = h.machine.revalidateShieldPlan();
    await vi.waitFor(() => expect(planner.planMax).toHaveBeenCalledTimes(2));
    if (action === 'close') h.machine.close();
    if (action === 'import') h.machine.importRecord('sensitive-record');
    if (action === 'discard') h.machine.discardRecord();
    release();
    expect(await revalidation).toBeNull();
  });

  it('returns null when the active account changes while the commit guard awaits planning', async () => {
    let reads = 0;
    let release!: () => void;
    let defer = false;
    const planner: PublicShieldPlanner = { planMax: vi.fn(async ({ available }: PublicShieldPlanInput) => {
      if (defer) await new Promise<void>((resolve) => { release = resolve; });
      return plan(available);
    }) };
    const h = harness(record({ leg: 'settled', message: 'settled', pollingStopped: true, strkReceived: 1_234n }), planner, { readAccount: () => (++reads > 3 ? '0x456' : ACCOUNT) });
    await h.machine.planShield();
    defer = true;
    const revalidation = h.machine.revalidateShieldPlan();
    await vi.waitFor(() => expect(planner.planMax).toHaveBeenCalledTimes(2));
    release();
    expect(await revalidation).toBeNull();
  });

  it('cleans a signed quote that resolves after close', async () => {
    let resolveQuote!: (value: BridgeRecord) => void;
    let saved: BridgeRecord | null = null;
    const service = {
      resume: () => saved,
      createManualDeposit: vi.fn(() => new Promise<BridgeRecord>((resolve) => { resolveQuote = (value) => { saved = value; resolve(value); }; })),
      refresh: async () => saved?.status ?? { leg: 'awaiting-deposit', message: 'waiting', pollingStopped: false } as BridgeStatus,
      watch: async () => saved?.status ?? { leg: 'awaiting-deposit', message: 'waiting', pollingStopped: false } as BridgeStatus,
      exportResumeRecord: () => 'sensitive-record',
      importResumeRecord: vi.fn(() => { saved = record({ leg: 'settled', message: 'different', pollingStopped: true, strkReceived: 3n }); return saved; }),
      discard: vi.fn(() => { saved = null; }),
    };
    const planner: PublicShieldPlanner = { planMax: vi.fn(async ({ available }: PublicShieldPlanInput) => plan(available)) };
    const first = createBridgePanel({ service, loadSources: async () => [SOURCE], readAccount: () => ACCOUNT, planner, now: () => Date.parse('2030-01-01T00:00:00.000Z') });
    const second = createBridgePanel({ service, loadSources: async () => [SOURCE], readAccount: () => ACCOUNT, planner, now: () => Date.parse('2030-01-01T00:00:00.000Z') });
    const flight = first.createQuote({ source: SOURCE, amountIn: 1_000_000n, refundAddress: '0x1111111111111111111111111111111111111111' });
    await vi.waitFor(() => expect(service.createManualDeposit).toHaveBeenCalledTimes(1));
    first.close();
    second.importRecord('sensitive-record');
    await second.createQuote({ source: SOURCE, amountIn: 1_000_000n, refundAddress: '0x1111111111111111111111111111111111111111' });
    expect(service.importResumeRecord).toHaveBeenCalledTimes(1);
    expect(service.createManualDeposit).toHaveBeenCalledTimes(1);
    expect(second.store.getState().notice?.text).toBe(COPY.bridge.busy);
    expect(second.store.getState().record?.status.strkReceived).toBe(3n);
    expect(second.exportRecord()).toBe('sensitive-record');
    resolveQuote(record());
    await flight;
    expect(service.discard).toHaveBeenCalledTimes(1);
    expect(service.resume()?.status.strkReceived).toBe(3n);
  });

  it('never discards a different record that appears before a cancelled quote resolves', async () => {
    let resolveQuote!: (value: BridgeRecord) => void;
    let saved: BridgeRecord | null = null;
    let preserveDifferent = false;
    const differentBase = record({ leg: 'settled', message: 'different', pollingStopped: true, strkReceived: 3n });
    const different = { ...differentBase, signedQuote: { ...differentBase.signedQuote, correlationId: 'different-correlation' } };
    const service = {
      resume: () => saved,
      createManualDeposit: vi.fn(() => new Promise<BridgeRecord>((resolve) => { resolveQuote = (value) => { if (!preserveDifferent) saved = value; resolve(value); }; })),
      refresh: async () => saved?.status ?? { leg: 'awaiting-deposit', message: 'waiting', pollingStopped: false } as BridgeStatus,
      watch: async () => saved?.status ?? { leg: 'awaiting-deposit', message: 'waiting', pollingStopped: false } as BridgeStatus,
      exportResumeRecord: () => 'sensitive-record',
      importResumeRecord: vi.fn(() => { saved = different; return saved; }),
      discard: vi.fn(() => { saved = null; }),
    };
    const planner: PublicShieldPlanner = { planMax: vi.fn(async ({ available }: PublicShieldPlanInput) => plan(available)) };
    const machine = createBridgePanel({ service, loadSources: async () => [SOURCE], readAccount: () => ACCOUNT, planner, now: () => Date.parse('2030-01-01T00:00:00.000Z') });
    const flight = machine.createQuote({ source: SOURCE, amountIn: 1_000_000n, refundAddress: '0x1111111111111111111111111111111111111111' });
    await vi.waitFor(() => expect(service.createManualDeposit).toHaveBeenCalledTimes(1));
    machine.close();
    preserveDifferent = true;
    saved = different;
    resolveQuote(record());
    await flight;
    expect(service.discard).not.toHaveBeenCalled();
    expect(saved).toBe(different);
  });

  it('discards a just-saved quote after an explicit discard during the provider flight', async () => {
    let resolveQuote!: (value: BridgeRecord) => void;
    let saved: BridgeRecord | null = null;
    const service = {
      resume: () => saved,
      createManualDeposit: vi.fn(() => new Promise<BridgeRecord>((resolve) => { resolveQuote = (value) => { saved = value; resolve(value); }; })),
      refresh: async () => saved?.status ?? { leg: 'awaiting-deposit', message: 'waiting', pollingStopped: false } as BridgeStatus,
      watch: async () => saved?.status ?? { leg: 'awaiting-deposit', message: 'waiting', pollingStopped: false } as BridgeStatus,
      exportResumeRecord: () => 'sensitive-record',
      importResumeRecord: vi.fn(() => { saved = record(); return saved; }),
      discard: vi.fn(() => { saved = null; }),
    };
    const planner: PublicShieldPlanner = { planMax: vi.fn(async ({ available }: PublicShieldPlanInput) => plan(available)) };
    const machine = createBridgePanel({ service, loadSources: async () => [SOURCE], readAccount: () => ACCOUNT, planner, now: () => Date.parse('2030-01-01T00:00:00.000Z') });
    const flight = machine.createQuote({ source: SOURCE, amountIn: 1_000_000n, refundAddress: '0x1111111111111111111111111111111111111111' });
    await vi.waitFor(() => expect(service.createManualDeposit).toHaveBeenCalledTimes(1));
    machine.discardRecord();
    resolveQuote(record());
    await flight;
    expect(service.discard).toHaveBeenCalledTimes(2);
    expect(saved).toBeNull();
  });

  it.each(['close', 'discard'] as const)('makes zero provider calls when %s happens during a slow account read', async (action) => {
    let release!: (value: string) => void;
    const h = harness(null, undefined, { readAccount: () => new Promise<string>((resolve) => { release = resolve; }) });
    const quote = h.machine.createQuote({ source: SOURCE, amountIn: 1_000_000n, refundAddress: '0x1111111111111111111111111111111111111111' });
    await Promise.resolve();
    if (action === 'close') h.machine.close();
    if (action === 'discard') h.machine.discardRecord();
    release(ACCOUNT);
    await quote;
    expect(h.service.createManualDeposit).not.toHaveBeenCalled();
  });

  it('keeps existing evidence when an active-flight import is malformed', async () => {
    let resolveQuote!: (value: BridgeRecord) => void;
    const existingBase = record({ leg: 'settled', message: 'existing', pollingStopped: true, strkReceived: 3n });
    const existing = { ...existingBase, signedQuote: { ...existingBase.signedQuote, correlationId: 'existing-correlation' } };
    let saved: BridgeRecord | null = existing;
    const service = {
      resume: () => saved,
      createManualDeposit: vi.fn(() => new Promise<BridgeRecord>((resolve) => { resolveQuote = resolve; })),
      refresh: async () => saved!.status,
      watch: async () => saved!.status,
      exportResumeRecord: () => 'existing-record',
      importResumeRecord: vi.fn(() => { throw new Error('malformed'); }),
      discard: vi.fn(() => { saved = null; }),
    };
    const planner: PublicShieldPlanner = { planMax: vi.fn(async ({ available }: PublicShieldPlanInput) => plan(available)) };
    const machine = createBridgePanel({ service, loadSources: async () => [SOURCE], readAccount: () => ACCOUNT, planner, now: () => Date.parse('2030-01-01T00:00:00.000Z') });
    const flight = machine.createQuote({ source: SOURCE, amountIn: 1_000_000n, refundAddress: '0x1111111111111111111111111111111111111111' });
    await vi.waitFor(() => expect(service.createManualDeposit).toHaveBeenCalledTimes(1));
    machine.importRecord('malformed');
    expect(service.resume()).toBe(existing);
    expect(service.discard).not.toHaveBeenCalled();
    machine.close();
    resolveQuote(record());
    await flight;
    expect(service.resume()).toBe(existing);
  });

  it('allows a later explicit import to supersede an earlier discard', async () => {
    let resolveQuote!: (value: BridgeRecord) => void;
    let saved: BridgeRecord | null = null;
    const imported = record({ leg: 'settled', message: 'imported', pollingStopped: true, strkReceived: 4n });
    const service = {
      resume: () => saved,
      createManualDeposit: vi.fn(() => new Promise<BridgeRecord>((resolve) => { resolveQuote = (value) => { saved = value; resolve(value); }; })),
      refresh: async () => saved?.status ?? { leg: 'awaiting-deposit', message: 'waiting', pollingStopped: false } as BridgeStatus,
      watch: async () => saved?.status ?? { leg: 'awaiting-deposit', message: 'waiting', pollingStopped: false } as BridgeStatus,
      exportResumeRecord: () => 'imported-record',
      importResumeRecord: vi.fn(() => { saved = imported; return imported; }),
      discard: vi.fn(() => { saved = null; }),
    };
    const planner: PublicShieldPlanner = { planMax: vi.fn(async ({ available }: PublicShieldPlanInput) => plan(available)) };
    const machine = createBridgePanel({ service, loadSources: async () => [SOURCE], readAccount: () => ACCOUNT, planner, now: () => Date.parse('2030-01-01T00:00:00.000Z') });
    const flight = machine.createQuote({ source: SOURCE, amountIn: 1_000_000n, refundAddress: '0x1111111111111111111111111111111111111111' });
    await vi.waitFor(() => expect(service.createManualDeposit).toHaveBeenCalledTimes(1));
    machine.discardRecord();
    machine.importRecord('imported-record');
    resolveQuote(record());
    await flight;
    expect(service.discard).toHaveBeenCalledTimes(2);
    expect(saved).toBe(imported);
  });
});
