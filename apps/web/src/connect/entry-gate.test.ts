import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FakePrivacyOperations,
  PrivacyError,
  type DepositStatus,
  type Intent,
  type PreparedBatch,
  type WalletRoutePolicy,
} from '@strkworld/privacy';
import { COPY } from '../copy.js';
import { attachDebugTap } from '../debug/debug-tap.js';
import { EXCHANGE_CATALOG } from '../panels/exchange/catalog.js';
import { PRIVACY_REGISTER } from '../privacy/register.js';
import { parseRoutePolicy } from '../production/config.js';
import {
  DEFAULT_WATCH_ATTEMPTS,
  createEntryGate,
  entryPolicyKey,
  entryTokens,
  type EntryGate,
  type EntryGateOptions,
  type EntryGateState,
  type EntryToken,
} from './entry-gate.js';
import type { EntryPassMemory } from './entry-pass.js';

const STRK = EXCHANGE_CATALOG.find((asset) => asset.symbol === 'STRK')!.token;
const ETH = EXCHANGE_CATALOG.find((asset) => asset.symbol === 'ETH')!.token;
const USDC = EXCHANGE_CATALOG.find((asset) => asset.symbol === 'USDC')!.token;
const ONE = 10n ** 18n;
const SHIELD_POLICY = parseRoutePolicy({
  VITE_STRK20_SHIELD_ENABLED: 'true',
  VITE_STRK20_SHIELD_MAX_INTENTS: '1',
  VITE_STRK20_SHIELD_ALLOWED_TOKENS: STRK,
});
const SHIELD_DISCLOSURE = PRIVACY_REGISTER.find((entry) => entry.route === 'entry.shield')!.disclosure;
const TOKENS = entryTokens(null);
/** Reads the receipt at once and never waits between reads. */
const NO_WAIT = { intervalMs: 0, attempts: 3, sleep: async () => undefined } as const;

let gate: EntryGate | null = null;

afterEach(() => {
  gate?.stop();
  gate = null;
  attachDebugTap(null);
});

function open(options: Partial<EntryGateOptions> & Pick<EntryGateOptions, 'operations'>): EntryGate {
  gate = createEntryGate({ tokens: TOKENS, policy: null, watch: NO_WAIT, ...options });
  gate.start();
  return gate;
}

function state(): EntryGateState {
  return gate!.store.getState();
}

/** A pass memory in plain memory, so a test can see what was remembered. */
function memory(remembered = false): EntryPassMemory & { remembered: boolean; recalls: number } {
  const owned = {
    remembered,
    recalls: 0,
    async recall() {
      owned.recalls += 1;
      return owned.remembered;
    },
    async remember() {
      owned.remembered = true;
    },
  };
  return owned;
}

async function flush(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
}

describe('the entry gate machine (D-072)', () => {
  it('starts at the check and asks the wallet nothing until the player presses the button', async () => {
    const operations = new FakePrivacyOperations({ balances: { [STRK]: ONE } });
    const check = vi.spyOn(operations, 'hasPrivateFunds');
    const balances = vi.spyOn(operations, 'balances');
    open({ operations });
    await flush();

    expect(state()).toEqual({ name: 'ready' });
    expect(check).not.toHaveBeenCalled();
    expect(balances).not.toHaveBeenCalled();
  });

  it('passes straight into the city when the pool holds anything, after one read', async () => {
    const operations = new FakePrivacyOperations({ balances: { [ETH]: 1n } });
    const check = vi.spyOn(operations, 'hasPrivateFunds');
    open({ operations });

    const checking = gate!.check();
    expect(state()).toEqual({ name: 'checking' });
    await checking;

    expect(state()).toEqual({ name: 'passed' });
    expect(check).toHaveBeenCalledOnce();
  });

  it('learns only yes or no from the check', async () => {
    // A seam answering anything but a real `true` keeps the door shut.
    for (const answer of [1, 'true', {}, null, undefined]) {
      const operations = new FakePrivacyOperations();
      vi.spyOn(operations, 'hasPrivateFunds').mockResolvedValue(answer as never);
      open({ operations });
      await gate!.check();
      expect(state().name, String(answer)).toBe('deposit');
      gate!.stop();
    }
  });

  it('offers the deposit card when every balance is zero', async () => {
    open({ operations: new FakePrivacyOperations({ balances: { [STRK]: 0n } }) });
    await gate!.check();
    expect(state()).toEqual({ name: 'deposit', form: { token: STRK, amountText: '' }, notice: null });
  });

  it('treats a 118 at the check as nothing in the pool yet, not as a failure', async () => {
    const operations = new FakePrivacyOperations();
    operations.injectFault({ kind: 'not-registered', on: 'balances' });
    open({ operations });
    await gate!.check();
    expect(state()).toMatchObject({ name: 'deposit', notice: null });
  });

  it.each(['user-rejected', 'unreachable', 'unsupported-wallet', 'unknown'] as const)(
    'returns a %s check to the check card with its message kind, and retries on request',
    async (kind) => {
      const operations = new FakePrivacyOperations({ balances: { [STRK]: ONE } });
      operations.injectFault({ kind, on: 'balances' });
      open({ operations });

      await gate!.check();
      expect(state()).toEqual({ name: 'check-failed', failure: kind });
      expect(COPY.errors[kind]).toBeTruthy();

      await gate!.check();
      expect(state()).toEqual({ name: 'passed' });
    },
  );

  it('ignores a second press while the wallet is still asking', async () => {
    const operations = new FakePrivacyOperations({ balances: { [STRK]: ONE }, latencyMs: 5 });
    const check = vi.spyOn(operations, 'hasPrivateFunds');
    open({ operations });
    const first = gate!.check();
    await gate!.check();
    await first;
    expect(check).toHaveBeenCalledOnce();
    expect(state().name).toBe('passed');
  });

  it('deposits through the Bank shield path, shows the register disclosure, and passes once the receipt lands', async () => {
    const operations = new FakePrivacyOperations();
    const prepare = vi.spyOn(operations, 'prepare');
    const status = vi.spyOn(operations, 'depositStatus');
    open({ operations });
    await gate!.check();

    gate!.setAmount('12.5');
    await gate!.review();

    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare.mock.calls[0]![0]).toEqual([{ kind: 'shield', token: STRK, amount: 12_500000000000000000n }]);
    const reviewing = state();
    expect(reviewing).toMatchObject({
      name: 'review',
      review: {
        amount: 12_500000000000000000n,
        disclosures: [SHIELD_DISCLOSURE],
        feeCeiling: 6n * ONE,
      },
    });

    await gate!.confirm();

    expect(operations.submitted).toEqual([[{ kind: 'shield', token: STRK, amount: 12_500000000000000000n }]]);
    expect(status).toHaveBeenCalledWith('0xfake0001', expect.anything());
    expect(state()).toEqual({ name: 'passed' });
  });

  it('passes the prepared total as the fee ceiling, so a moved fee signs nothing', async () => {
    const operations = new FakePrivacyOperations();
    open({ operations });
    await gate!.check();
    gate!.setAmount('1');
    await gate!.review();
    operations.setPoolFee(7n * ONE);

    await gate!.confirm();

    expect(operations.submitted).toEqual([]);
    expect(state()).toMatchObject({ name: 'deposit-failed', failure: 'unknown', form: { amountText: '1' } });
  });

  it('takes any amount above zero in the token\'s own decimals, and nothing else', async () => {
    const operations = new FakePrivacyOperations();
    const prepare = vi.spyOn(operations, 'prepare');
    open({ operations, tokens: entryTokens({ ...SHIELD_POLICY, allowedTokens: { ...SHIELD_POLICY.allowedTokens, shield: [USDC] } }) });
    await gate!.check();

    for (const text of ['', '0', '0.0', '-1', 'abc', '1.0000001']) {
      gate!.setAmount(text);
      await gate!.review();
      expect(state(), text).toMatchObject({ name: 'deposit', notice: COPY.notices.badAmount });
    }
    expect(prepare).not.toHaveBeenCalled();

    gate!.setAmount('0.000001');
    await gate!.review();
    expect(prepare.mock.calls[0]![0]).toEqual([{ kind: 'shield', token: USDC, amount: 1n }]);
  });

  it('switches token only to one it offers', async () => {
    const tokens: readonly EntryToken[] = entryTokens({
      ...SHIELD_POLICY,
      allowedTokens: { ...SHIELD_POLICY.allowedTokens, shield: [STRK, ETH] },
    });
    const operations = new FakePrivacyOperations();
    const prepare = vi.spyOn(operations, 'prepare');
    open({ operations, tokens });
    await gate!.check();

    gate!.setToken(USDC);
    expect(state()).toMatchObject({ form: { token: STRK } });
    gate!.setToken(`0x${ETH.slice(3)}`);
    expect(state()).toMatchObject({ form: { token: ETH } });
    gate!.setAmount('0.5');
    await gate!.review();
    expect(prepare.mock.calls[0]![0]).toEqual([{ kind: 'shield', token: ETH, amount: 5n * 10n ** 17n }]);
  });

  it('leads the not-registered card back to the check, never straight to a second deposit', async () => {
    const operations = new FakePrivacyOperations();
    const prepare = vi.spyOn(operations, 'prepare');
    open({ operations });
    await gate!.check();
    gate!.setAmount('3');
    await gate!.review();
    operations.injectFault({ kind: 'not-registered', on: 'confirm' });

    await gate!.confirm();
    expect(state()).toEqual({ name: 'not-registered', form: { token: STRK, amountText: '3' } });
    expect(gate!).not.toHaveProperty('backToDeposit');

    // Registering inside the wallet often makes a first deposit too: the check finds it.
    const check = vi.spyOn(operations, 'hasPrivateFunds').mockResolvedValueOnce(true);
    await gate!.check();
    expect(check).toHaveBeenCalledOnce();
    expect(state()).toEqual({ name: 'passed' });
    expect(prepare).toHaveBeenCalledOnce();
    expect(operations.submitted).toEqual([]);
  });

  it('returns a registered player with nothing yet to the form as they left it', async () => {
    const operations = new FakePrivacyOperations();
    open({ operations });
    await gate!.check();
    gate!.setAmount('3');
    await gate!.review();
    operations.injectFault({ kind: 'not-registered', on: 'confirm' });
    await gate!.confirm();

    await gate!.check();
    expect(state()).toEqual({ name: 'deposit', form: { token: STRK, amountText: '3' }, notice: null });
  });

  it('keeps the form after a declined deposit, and lets the player try again', async () => {
    const operations = new FakePrivacyOperations();
    open({ operations });
    await gate!.check();
    gate!.setAmount('3');
    await gate!.review();
    operations.injectFault({ kind: 'user-rejected', on: 'confirm' });

    await gate!.confirm();
    expect(state()).toEqual({ name: 'deposit-failed', form: { token: STRK, amountText: '3' }, failure: 'user-rejected' });

    await gate!.review();
    expect(state().name).toBe('review');
    await gate!.confirm();
    expect(state().name).toBe('passed');
  });

  it('says a reverted deposit did not go through', async () => {
    const operations = new FakePrivacyOperations({ deposits: 'failed' });
    open({ operations });
    await gate!.check();
    gate!.setAmount('3');
    await gate!.review();
    await gate!.confirm();
    expect(state()).toMatchObject({ name: 'deposit-failed', failure: 'reverted' });
  });

  it('offers to check again when the receipt is slow, without asking the wallet again', async () => {
    const operations = new FakePrivacyOperations({ deposits: 'pending' });
    const status = vi.spyOn(operations, 'depositStatus');
    const invoke = vi.spyOn(operations, 'prepare');
    open({ operations });
    await gate!.check();
    gate!.setAmount('3');
    await gate!.review();
    await gate!.confirm();

    expect(state()).toEqual({ name: 'unconfirmed', form: { token: STRK, amountText: '3' }, transactionHash: '0xfake0001' });
    expect(status).toHaveBeenCalledTimes(NO_WAIT.attempts);

    operations.setDepositStatus('0xfake0001', 'landed');
    await gate!.checkDeposit();
    expect(state()).toEqual({ name: 'passed' });
    expect(invoke).toHaveBeenCalledOnce();
    expect(operations.submitted).toHaveLength(1);
  });

  it('keeps watching past one failed receipt read', async () => {
    const operations = new FakePrivacyOperations();
    operations.injectFault({ kind: 'unreachable', on: 'depositStatus' });
    open({ operations });
    await gate!.check();
    gate!.setAmount('3');
    await gate!.review();
    await gate!.confirm();
    expect(state()).toEqual({ name: 'passed' });
  });

  describe('when the receipt cannot be read', () => {
    const DOWN = new PrivacyError('unreachable', 'The network check for this deposit could not be made.');

    /** Answers in order: a status, or a read that fails. */
    function scripted(operations: FakePrivacyOperations, answers: Array<DepositStatus | Error>) {
      return vi.spyOn(operations, 'depositStatus').mockImplementation(async () => {
        const next = answers.length > 1 ? answers.shift()! : answers[0]!;
        if (next instanceof Error) throw next;
        return next;
      });
    }

    async function deposit(): Promise<void> {
      await gate!.check();
      gate!.setAmount('3');
      await gate!.review();
      await gate!.confirm();
    }

    it('says it cannot reach the network check after failed reads in a row, not that the deposit is slow', async () => {
      const operations = new FakePrivacyOperations();
      const status = scripted(operations, [DOWN]);
      open({ operations, watch: { ...NO_WAIT, attempts: 10, failureLimit: 3 } });
      await deposit();

      expect(state()).toEqual({ name: 'receipt-unreachable', form: { token: STRK, amountText: '3' }, transactionHash: '0xfake0001' });
      expect(status).toHaveBeenCalledTimes(3);
    });

    it('counts only failures in a row: an answer in between resets the count', async () => {
      const operations = new FakePrivacyOperations();
      const status = scripted(operations, [DOWN, DOWN, 'pending', DOWN, DOWN, 'landed']);
      open({ operations, watch: { ...NO_WAIT, attempts: 10, failureLimit: 3 } });
      await deposit();

      expect(state()).toEqual({ name: 'passed' });
      expect(status).toHaveBeenCalledTimes(6);
    });

    it('watches again on request once the check is back, with no wallet prompt', async () => {
      const operations = new FakePrivacyOperations();
      const status = scripted(operations, [DOWN, DOWN, DOWN, 'landed']);
      const check = vi.spyOn(operations, 'hasPrivateFunds');
      open({ operations, watch: { ...NO_WAIT, attempts: 10, failureLimit: 3 } });
      await deposit();
      expect(state().name).toBe('receipt-unreachable');

      await gate!.checkDeposit();
      expect(state()).toEqual({ name: 'passed' });
      expect(status).toHaveBeenCalledTimes(4);
      expect(check).toHaveBeenCalledOnce();
      expect(operations.submitted).toHaveLength(1);
    });

    it('offers the balance check instead, which lets the player in once the wallet shows the deposit', async () => {
      const operations = new FakePrivacyOperations();
      scripted(operations, [DOWN]);
      open({ operations, watch: { ...NO_WAIT, attempts: 10, failureLimit: 3 } });
      await deposit();
      expect(state().name).toBe('receipt-unreachable');

      // The fake's shield minted a note, so the wallet now reports funds.
      await gate!.check();
      expect(state()).toEqual({ name: 'passed' });
    });
  });

  it('waits longer between receipt reads each time, up to a cap', async () => {
    const operations = new FakePrivacyOperations({ deposits: 'pending' });
    const sleep = vi.fn(async (_ms: number, _signal?: AbortSignal) => undefined);
    open({ operations, watch: { intervalMs: 1_000, maxIntervalMs: 5_000, attempts: 6, sleep } });
    await gate!.check();
    gate!.setAmount('3');
    await gate!.review();
    await gate!.confirm();
    // Read at once, then five more after a wait each.
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1_000, 2_000, 4_000, 5_000, 5_000]);
    expect(sleep).toHaveBeenCalledWith(1_000, expect.anything());
  });

  it('by default reads at once, then after 3, 6 and 12 seconds and every 20 after, for about three minutes', async () => {
    const operations = new FakePrivacyOperations({ deposits: 'pending' });
    const status = vi.spyOn(operations, 'depositStatus');
    const sleep = vi.fn(async (_ms: number, _signal?: AbortSignal) => undefined);
    open({ operations, watch: { sleep } });
    await gate!.check();
    gate!.setAmount('3');
    await gate!.review();
    await gate!.confirm();

    const waits = sleep.mock.calls.map(([ms]) => ms);
    expect(waits.slice(0, 5)).toEqual([3_000, 6_000, 12_000, 20_000, 20_000]);
    expect(status).toHaveBeenCalledTimes(DEFAULT_WATCH_ATTEMPTS);
    const total = waits.reduce((sum, ms) => sum + ms, 0);
    expect(total).toBeGreaterThanOrEqual(170_000);
    expect(total).toBeLessThanOrEqual(200_000);
    expect(state().name).toBe('unconfirmed');
  });

  it('reviews a STRK deposit with the pool fee on top, and the note is the typed amount (D-094)', async () => {
    // The fake's pool fee is 6 STRK.
    const operations = new FakePrivacyOperations({ publicBalances: { [STRK]: 20n * ONE } });
    open({ operations });
    await gate!.check();

    gate!.setAmount('0.5');
    await gate!.review();
    expect(state()).toMatchObject({ name: 'review', review: { amount: 5n * 10n ** 17n, poolFee: 6n * ONE, feeCeiling: 6n * ONE } });
    await gate!.confirm();
    expect(operations.submitted).toEqual([[{ kind: 'shield', token: STRK, amount: 5n * 10n ** 17n }]]);
    // 0.5 STRK reached the pool; 0.5 + 6 left the wallet.
    expect(await operations.publicBalance(STRK)).toBe(20n * ONE - 65n * 10n ** 17n);
    expect(state().name).toBe('passed');
  });

  it('never weighs another token against the STRK fee', async () => {
    const operations = new FakePrivacyOperations();
    open({ operations, tokens: entryTokens({ ...SHIELD_POLICY, allowedTokens: { ...SHIELD_POLICY.allowedTokens, shield: [USDC] } }) });
    await gate!.check();
    // One USDC is 1_000000 base units, far below 6 STRK in wei, and says nothing about the fee.
    gate!.setAmount('1');
    await gate!.review();
    expect(state()).toMatchObject({ name: 'review', review: { poolFee: null } });
  });

  it('discards a reviewed shield the player cancels', async () => {
    const operations = new FakePrivacyOperations();
    open({ operations });
    await gate!.check();
    gate!.setAmount('3');
    const discard = vi.fn();
    const prepare = vi.spyOn(operations, 'prepare').mockImplementationOnce(async (intents) => {
      const batch = await new FakePrivacyOperations().prepare(intents);
      return { ...batch, discard } as PreparedBatch;
    });
    await gate!.review();
    gate!.cancelReview();
    expect(discard).toHaveBeenCalledOnce();
    expect(state()).toEqual({ name: 'deposit', form: { token: STRK, amountText: '3' }, notice: null });
    expect(prepare).toHaveBeenCalledOnce();
  });

  it('refuses a prepared batch that is not exactly the shield asked for', async () => {
    const operations = new FakePrivacyOperations();
    open({ operations });
    await gate!.check();
    gate!.setAmount('3');
    const discard = vi.fn();
    vi.spyOn(operations, 'prepare').mockImplementationOnce(async () => ({
      intents: [{ kind: 'shield', token: ETH, amount: 3n * ONE } as Intent],
      poolFee: 0n,
      gasEstimate: 0n,
      totalCost: 0n,
      warnings: [],
      promptCount: 1,
      confirm: vi.fn(),
      discard,
    }));
    await gate!.review();
    expect(state()).toMatchObject({ name: 'deposit-failed', failure: 'unknown' });
    expect(discard).toHaveBeenCalledOnce();
  });

  it('deposits with no pre-commit line at all: copy is not part of the gate (D-118)', async () => {
    const operations = new FakePrivacyOperations();
    const register = PRIVACY_REGISTER.map((entry) => entry.route === 'entry.shield' ? { ...entry, disclosure: null } : entry);
    open({ operations, register });
    await gate!.check();
    expect(gate!.door.open).toBe(true);
    gate!.setAmount('3');
    await gate!.review();
    expect(state()).toMatchObject({ name: 'review', review: { disclosures: [] } });
    await gate!.confirm();
    expect(operations.submitted).toEqual([[{ kind: 'shield', token: STRK, amount: 3n * ONE }]]);
  });

  it('keeps the deposit door shut when this build has not switched shield on', async () => {
    const operations = new FakePrivacyOperations();
    const prepare = vi.spyOn(operations, 'prepare');
    open({ operations, policy: parseRoutePolicy({}), tokens: entryTokens(parseRoutePolicy({})) });
    expect(gate!.door).toMatchObject({ open: false, reason: 'not-enabled', message: COPY.locked.notEnabled.shield });
    expect(gate!.tokens).toEqual([]);
    await gate!.check();
    gate!.setAmount('3');
    await gate!.review();
    expect(prepare).not.toHaveBeenCalled();
  });

  it('opens the deposit door for the live STRK shield policy', () => {
    open({ operations: new FakePrivacyOperations(), policy: SHIELD_POLICY, tokens: entryTokens(SHIELD_POLICY) });
    expect(gate!.door).toMatchObject({ open: true });
    expect(gate!.tokens).toEqual([{ token: STRK, symbol: 'STRK', decimals: 18 }]);
  });

  describe('the balance check on every card after the first', () => {
    it('runs from the deposit card and lets in a player who had funds after all', async () => {
      const operations = new FakePrivacyOperations();
      const check = vi.spyOn(operations, 'hasPrivateFunds');
      open({ operations });
      await gate!.check();
      gate!.setAmount('2');

      check.mockResolvedValueOnce(true);
      const checking = gate!.check();
      expect(state()).toEqual({ name: 'checking' });
      await checking;
      expect(state()).toEqual({ name: 'passed' });
      expect(check).toHaveBeenCalledTimes(2);
    });

    it('returns to the deposit card with its form as the player left it when there is still nothing', async () => {
      open({ operations: new FakePrivacyOperations() });
      await gate!.check();
      gate!.setAmount('2');
      await gate!.check();
      expect(state()).toEqual({ name: 'deposit', form: { token: STRK, amountText: '2' }, notice: null });
    });

    it('keeps that form through a declined check and its retry', async () => {
      const operations = new FakePrivacyOperations();
      open({ operations });
      await gate!.check();
      gate!.setAmount('2');
      operations.injectFault({ kind: 'user-rejected', on: 'balances' });

      await gate!.check();
      expect(state()).toEqual({ name: 'check-failed', failure: 'user-rejected' });
      await gate!.check();
      expect(state()).toEqual({ name: 'deposit', form: { token: STRK, amountText: '2' }, notice: null });
    });

    it('runs from a failed deposit', async () => {
      const operations = new FakePrivacyOperations();
      open({ operations });
      await gate!.check();
      gate!.setAmount('3');
      await gate!.review();
      operations.injectFault({ kind: 'user-rejected', on: 'confirm' });
      await gate!.confirm();
      expect(state().name).toBe('deposit-failed');

      vi.spyOn(operations, 'hasPrivateFunds').mockResolvedValueOnce(true);
      await gate!.check();
      expect(state()).toEqual({ name: 'passed' });
    });

    it('runs from the locked card, where this build takes no deposit', async () => {
      const operations = new FakePrivacyOperations();
      const check = vi.spyOn(operations, 'hasPrivateFunds');
      open({ operations, policy: parseRoutePolicy({}), tokens: entryTokens(parseRoutePolicy({})) });
      await gate!.check();
      expect(gate!.door.open).toBe(false);
      expect(state().name).toBe('deposit');

      check.mockResolvedValueOnce(true);
      await gate!.check();
      expect(state()).toEqual({ name: 'passed' });
    });

    it('runs from the unconfirmed card, and lets the player in once the wallet shows the deposit', async () => {
      const operations = new FakePrivacyOperations({ deposits: 'pending' });
      open({ operations });
      await gate!.check();
      gate!.setAmount('3');
      await gate!.review();
      await gate!.confirm();
      expect(state().name).toBe('unconfirmed');

      // The fake's shield minted a note, so the wallet now reports funds.
      await gate!.check();
      expect(state()).toEqual({ name: 'passed' });
    });

    it('warns before a second deposit when a sent one has not shown up yet', async () => {
      const operations = new FakePrivacyOperations({ deposits: 'pending' });
      open({ operations });
      await gate!.check();
      gate!.setAmount('3');
      await gate!.review();
      await gate!.confirm();
      expect(state().name).toBe('unconfirmed');

      vi.spyOn(operations, 'hasPrivateFunds').mockResolvedValue(false);
      await gate!.check();
      expect(state()).toEqual({
        name: 'deposit',
        form: { token: STRK, amountText: '3' },
        notice: COPY.entry.sentNotYet,
      });
    });

    it('does not warn once the sent deposit is known to have reverted', async () => {
      const operations = new FakePrivacyOperations({ deposits: 'failed' });
      open({ operations });
      await gate!.check();
      gate!.setAmount('3');
      await gate!.review();
      await gate!.confirm();
      expect(state()).toMatchObject({ name: 'deposit-failed', failure: 'reverted' });

      vi.spyOn(operations, 'hasPrivateFunds').mockResolvedValue(false);
      await gate!.check();
      expect(state()).toMatchObject({ name: 'deposit', notice: null });
    });

    it('does nothing mid-step', async () => {
      const operations = new FakePrivacyOperations();
      const check = vi.spyOn(operations, 'hasPrivateFunds');
      open({ operations });
      await gate!.check();
      gate!.setAmount('3');
      await gate!.review();
      expect(state().name).toBe('review');

      await gate!.check();
      expect(state().name).toBe('review');
      expect(check).toHaveBeenCalledOnce();
    });
  });

  describe('an account switched in place', () => {
    /** The session's account, which a test moves as a wallet would. */
    function session(initial = '0xabc') {
      const owned = { account: initial as string | null, reads: 0 };
      return { owned, readAccount: () => { owned.reads += 1; return owned.account; } };
    }

    it('drops a check answered after the account moved while the wallet was asking', async () => {
      const operations = new FakePrivacyOperations({ balances: { [STRK]: ONE } });
      const { owned, readAccount } = session();
      const pass = memory();
      let answer!: (funded: boolean) => void;
      vi.spyOn(operations, 'hasPrivateFunds').mockImplementationOnce(
        () => new Promise<boolean>((resolve) => { answer = resolve; }),
      );
      open({ operations, memory: pass, account: '0xabc', readAccount });
      await flush();

      const checking = gate!.check();
      expect(state()).toEqual({ name: 'checking' });
      owned.account = '0xdef';
      answer(true);
      await checking;
      await flush();

      expect(state()).toEqual({ name: 'ready' });
      expect(pass.remembered).toBe(false);
      expect(owned.reads).toBeGreaterThan(0);
    });

    it('drops a "nothing yet" too, rather than show the deposit card to the wrong account', async () => {
      const operations = new FakePrivacyOperations();
      const { owned, readAccount } = session();
      vi.spyOn(operations, 'hasPrivateFunds').mockImplementationOnce(async () => {
        owned.account = '0xdef';
        return false;
      });
      open({ operations, account: '0xabc', readAccount });
      await gate!.check();
      expect(state()).toEqual({ name: 'ready' });
    });

    it('drops a deposit whose account moved while the wallet was signing', async () => {
      const operations = new FakePrivacyOperations();
      const { owned, readAccount } = session();
      const pass = memory();
      let sign!: () => void;
      vi.spyOn(operations, 'prepare').mockImplementationOnce(async (intents) => {
        const batch = await new FakePrivacyOperations().prepare(intents);
        return {
          ...batch,
          confirm: async (options: Parameters<PreparedBatch['confirm']>[0]) => {
            options.onProgress?.({ stage: 'awaiting-approval', message: 'Confirm the shield in your wallet' });
            await new Promise<void>((resolve) => { sign = resolve; });
            return { transactionHash: '0x5eed' };
          },
        } as PreparedBatch;
      });
      const status = vi.spyOn(operations, 'depositStatus').mockResolvedValue('landed');
      open({ operations, memory: pass, account: '0xabc', readAccount });
      await flush();
      await gate!.check();
      gate!.setAmount('3');
      await gate!.review();

      const confirming = gate!.confirm();
      await flush();
      expect(state()).toMatchObject({ name: 'depositing', stage: 'awaiting-approval' });
      owned.account = '0xdef';
      sign();
      await confirming;
      await flush();

      expect(state()).toEqual({ name: 'ready' });
      expect(status).not.toHaveBeenCalled();
      expect(pass.remembered).toBe(false);
    });

    it.each(['landed', 'failed'] as const)('drops a %s receipt read after the account moved', async (answer) => {
      const operations = new FakePrivacyOperations();
      const { owned, readAccount } = session();
      const pass = memory();
      vi.spyOn(operations, 'depositStatus').mockImplementation(async () => {
        owned.account = '0xdef';
        return answer;
      });
      open({ operations, memory: pass, account: '0xabc', readAccount });
      await flush();
      await gate!.check();
      gate!.setAmount('3');
      await gate!.review();
      await gate!.confirm();
      await flush();

      expect(state()).toEqual({ name: 'ready' });
      expect(pass.remembered).toBe(false);
    });

    it('drops the account when the re-read itself fails', async () => {
      const operations = new FakePrivacyOperations({ balances: { [STRK]: ONE } });
      open({ operations, account: '0xabc', readAccount: () => { throw new Error('session gone'); } });
      await gate!.check();
      expect(state()).toEqual({ name: 'ready' });
    });

    it('does not honour this tab\'s pass once the account has moved', async () => {
      const operations = new FakePrivacyOperations();
      const check = vi.spyOn(operations, 'hasPrivateFunds');
      open({ operations, memory: memory(true), account: '0xabc', readAccount: () => '0xdef' });
      await flush();
      expect(state()).toEqual({ name: 'ready' });
      expect(check).not.toHaveBeenCalled();
    });

    it('lets the same account in, whatever its spelling, and reads it without the wallet', async () => {
      const operations = new FakePrivacyOperations({ balances: { [STRK]: ONE } });
      const pass = memory();
      const balances = vi.spyOn(operations, 'balances');
      open({ operations, memory: pass, account: '0xabc', readAccount: async () => '0x0ABC' });
      await flush();
      await gate!.check();
      await flush();

      expect(state()).toEqual({ name: 'passed' });
      expect(pass.remembered).toBe(true);
      // One balance read, the check itself: the re-read is the session's own.
      expect(balances).toHaveBeenCalledOnce();
    });
  });

  describe('once per session', () => {
    it('lets a remembered account straight in with no wallet read', async () => {
      const operations = new FakePrivacyOperations();
      const check = vi.spyOn(operations, 'hasPrivateFunds');
      const pass = memory(true);
      open({ operations, memory: pass });
      expect(state()).toEqual({ name: 'recalling' });
      await flush();
      expect(state()).toEqual({ name: 'passed' });
      expect(check).not.toHaveBeenCalled();
    });

    it('remembers a pass from the check or from a landed deposit', async () => {
      const funded = memory();
      open({ operations: new FakePrivacyOperations({ balances: { [STRK]: ONE } }), memory: funded });
      await flush();
      await gate!.check();
      await flush();
      expect(funded.remembered).toBe(true);
      gate!.stop();

      const deposited = memory();
      open({ operations: new FakePrivacyOperations(), memory: deposited });
      await flush();
      await gate!.check();
      expect(deposited.remembered).toBe(false);
      gate!.setAmount('1');
      await gate!.review();
      await gate!.confirm();
      await flush();
      expect(deposited.remembered).toBe(true);
    });

    it('checks as usual when the memory cannot answer', async () => {
      const broken: EntryPassMemory = { recall: async () => { throw new Error('storage gone'); }, remember: async () => undefined };
      open({ operations: new FakePrivacyOperations(), memory: broken });
      await flush();
      expect(state()).toEqual({ name: 'ready' });
    });
  });

  describe('lifecycle', () => {
    it('writes nothing from a check answered after stop, and can start again', async () => {
      const operations = new FakePrivacyOperations({ balances: { [STRK]: ONE } });
      let answer!: (funded: boolean) => void;
      vi.spyOn(operations, 'hasPrivateFunds').mockImplementationOnce(() => new Promise<boolean>((resolve) => { answer = resolve; }));
      open({ operations });
      const checking = gate!.check();
      gate!.stop();
      answer(true);
      await checking;
      expect(state()).toEqual({ name: 'ready' });

      gate!.start();
      await gate!.check();
      expect(state()).toEqual({ name: 'passed' });
    });

    it('aborts the wallet read it owns when stopped', async () => {
      const operations = new FakePrivacyOperations();
      const signals: (AbortSignal | undefined)[] = [];
      vi.spyOn(operations, 'hasPrivateFunds').mockImplementation((signal) => {
        signals.push(signal);
        return new Promise<boolean>(() => undefined);
      });
      open({ operations });
      void gate!.check();
      gate!.stop();
      expect(signals[0]?.aborted).toBe(true);
    });

    it('stops watching the receipt when stopped', async () => {
      const operations = new FakePrivacyOperations({ deposits: 'pending' });
      let wake!: () => void;
      const sleep = vi.fn((_ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
        wake = resolve;
        signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }));
      open({ operations, watch: { intervalMs: 10, attempts: 5, sleep } });
      await gate!.check();
      gate!.setAmount('1');
      await gate!.review();
      const confirming = gate!.confirm();
      await flush();
      expect(state().name).toBe('landing');
      gate!.stop();
      wake();
      await confirming;
      expect(state()).toEqual({ name: 'ready' });
    });
  });

  it('logs each change of state by name, and nothing else (D-069)', async () => {
    const names: unknown[] = [];
    attachDebugTap({
      failure: () => undefined,
      connectState: () => undefined,
      walletSession: () => undefined,
      visit: () => undefined,
      bank: () => undefined,
      sandboxBurst: () => undefined,
      gate: (name) => names.push(name),
    });
    open({ operations: new FakePrivacyOperations() });
    await gate!.check();
    gate!.setAmount('1');
    gate!.setAmount('12');
    await gate!.review();
    await gate!.confirm();

    expect(names).toEqual(['ready', 'checking', 'deposit', 'preparing', 'review', 'depositing', 'landing', 'passed']);
    expect(names.every((name) => typeof name === 'string')).toBe(true);
  });
});

describe('entryTokens', () => {
  it('offers every token of the Railway allowlist, with catalog decimals, in its order', () => {
    const USDT = EXCHANGE_CATALOG.find((asset) => asset.symbol === 'USDT')!.token;
    const WBTC = EXCHANGE_CATALOG.find((asset) => asset.symbol === 'WBTC')!.token;
    const railway = parseRoutePolicy({
      VITE_STRK20_SHIELD_ENABLED: 'true',
      VITE_STRK20_SHIELD_MAX_INTENTS: '1',
      VITE_STRK20_SHIELD_ALLOWED_TOKENS: [STRK, ETH, USDC, USDT, WBTC].join(','),
    });
    expect(entryTokens(railway).map(({ symbol, decimals }) => [symbol, decimals])).toEqual([
      ['STRK', 18], ['ETH', 18], ['USDC', 6], ['USDT', 6], ['WBTC', 8],
    ]);
    // A token the catalog cannot describe is skipped, not offered without decimals.
    const withUnlisted = parseRoutePolicy({
      VITE_STRK20_SHIELD_ENABLED: 'true',
      VITE_STRK20_SHIELD_MAX_INTENTS: '1',
      VITE_STRK20_SHIELD_ALLOWED_TOKENS: `0x1234,${USDC}`,
    });
    expect(withUnlisted.allowedTokens.shield).toEqual(['0x1234', USDC]);
    expect(entryTokens(withUnlisted).map(({ symbol }) => symbol)).toEqual(['USDC']);
  });

  it('offers STRK without a policy, the pool\'s own money (D-013)', () => {
    expect(entryTokens(null)).toEqual([{ token: STRK, symbol: 'STRK', decimals: 18 }]);
  });

  it('follows the allowlist order with catalog metadata, once each, and drops what it cannot describe', () => {
    const policy: WalletRoutePolicy = {
      ...SHIELD_POLICY,
      allowedTokens: { ...SHIELD_POLICY.allowedTokens, shield: [USDC, '0x123', `0x${STRK.slice(3)}`, STRK] },
    };
    expect(entryTokens(policy)).toEqual([
      { token: USDC, symbol: 'USDC', decimals: 6 },
      { token: STRK, symbol: 'STRK', decimals: 18 },
    ]);
  });

  it('offers nothing for a hostile or empty policy', () => {
    const hostile = { ...SHIELD_POLICY };
    Object.defineProperty(hostile, 'allowedTokens', { get() { throw new Error('hostile'); } });
    expect(entryTokens(hostile as WalletRoutePolicy)).toEqual([]);
    expect(entryTokens(parseRoutePolicy({}))).toEqual([]);
  });

  it('keys a policy by what it means to the gate', () => {
    expect(entryPolicyKey(null)).toBe('none');
    expect(entryPolicyKey(SHIELD_POLICY)).toBe(entryPolicyKey(parseRoutePolicy({
      VITE_STRK20_SHIELD_ENABLED: 'true',
      VITE_STRK20_SHIELD_MAX_INTENTS: '1',
      VITE_STRK20_SHIELD_ALLOWED_TOKENS: STRK,
    })));
    expect(entryPolicyKey(parseRoutePolicy({}))).not.toBe(entryPolicyKey(SHIELD_POLICY));
  });
});

describe('the fake as the gate sees it', () => {
  it.each([
    ['landed', 'passed'],
    ['failed', 'deposit-failed'],
    ['pending', 'unconfirmed'],
  ] as const)('a %s receipt ends at %s', async (deposits: DepositStatus, name) => {
    open({ operations: new FakePrivacyOperations({ deposits }) });
    await gate!.check();
    gate!.setAmount('1');
    await gate!.review();
    await gate!.confirm();
    expect(state().name).toBe(name);
  });

  it('surfaces a thrown non-privacy error as unknown', async () => {
    const operations = new FakePrivacyOperations();
    vi.spyOn(operations, 'hasPrivateFunds').mockRejectedValue(new Error('boom'));
    open({ operations });
    await gate!.check();
    expect(state()).toEqual({ name: 'check-failed', failure: 'unknown' });
    expect(new PrivacyError('unknown', 'x').kind).toBe('unknown');
  });
});
