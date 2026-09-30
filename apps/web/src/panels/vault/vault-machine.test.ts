import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakePrivacyOperations, type PrivacyOperations, type VaultStage } from '@strkworld/privacy';
import { COPY } from '../../copy.js';
import { attachDebugTap, type DebugTap, type VaultDebugStep } from '../../debug/debug-tap.js';
import { PRIVACY_REGISTER } from '../../privacy/register.js';
import type { ShellFailure } from '../../privacy/errors.js';
import { createReceiptLedger } from '../../receipts/receipt-ledger.js';
import { createVaultPanel } from './vault-machine.js';

/**
 * The Vault's counter machine (D-077), against the deterministic fake: what
 * the player reads, what reaches the seam, and what the probe log is told.
 */

const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const ONE = 10n ** 18n;
const POOL_FEE = 6n * ONE;

afterEach(() => {
  attachDebugTap(null);
});

function fake(options: { balance?: bigint; shares?: bigint; capability?: Record<string, unknown> } = {}) {
  return new FakePrivacyOperations({
    balances: { [STRK]: options.balance ?? 100n * ONE },
    poolConfig: { noteMaturityBlocks: 0 },
    ...(options.shares !== undefined ? { vault: { shares: options.shares } } : {}),
    ...(options.capability ? { capability: options.capability } : {}),
  });
}

function machine(operations: PrivacyOperations, overrides: { canStart?: () => boolean } = {}) {
  const receipts = createReceiptLedger();
  const failures: ShellFailure[] = [];
  const panel = createVaultPanel({
    operations,
    receipts,
    canStartFinancialAction: overrides.canStart ?? (() => true),
    onError: (failure) => failures.push(failure),
  });
  return { panel, receipts, failures };
}

function probe(): VaultDebugStep[] {
  const steps: VaultDebugStep[] = [];
  const tap: DebugTap = {
    failure: () => undefined,
    connectState: () => undefined,
    walletSession: () => undefined,
    visit: () => undefined,
    bank: () => undefined,
    sandboxBurst: () => undefined,
    gate: () => undefined,
    vault: (step) => steps.push(step as VaultDebugStep),
  };
  attachDebugTap(tap);
  return steps;
}

describe('the Vault counter (D-077)', () => {
  it('opens on a version query alone: no position read, no wallet prompt', async () => {
    const operations = fake();
    const position = vi.spyOn(operations, 'vaultPositions');
    const { panel } = machine(operations);
    await panel.open();
    const state = panel.store.getState();
    expect(state.capability).toEqual({ status: 'supported' });
    expect(state.position).toEqual({ status: 'unrequested' });
    expect(state.mode).toBe('supply');
    expect(state.door.open).toBe(true);
    expect(state.disclosure).toBe(PRIVACY_REGISTER.find((entry) => entry.route === 'vault.supply')!.disclosure);
    expect(position).not.toHaveBeenCalled();
  });

  it('reads the position only when asked', async () => {
    const { panel } = machine(fake({ shares: 50n * ONE }));
    await panel.open();
    await panel.refreshPosition();
    expect(panel.store.getState().position).toEqual({
      status: 'loaded',
      shares: 50n * ONE,
      assets: 51n * ONE,
      redeemable: 51n * ONE,
    });
  });

  it('supplies: reviews the exact amount and the approved disclosure, then records the receipt', async () => {
    const operations = fake();
    const { panel, receipts } = machine(operations);
    await panel.open();
    panel.setAmount('5');
    await panel.prepare();
    const review = panel.store.getState().flow;
    expect(review.name).toBe('review');
    if (review.name !== 'review') return;
    expect(review.summary.action).toEqual({ kind: 'supply', token: STRK, amount: 5n * ONE });
    expect(review.summary.poolFee).toBe(POOL_FEE);
    expect(review.summary.disclosures).toEqual([
      PRIVACY_REGISTER.find((entry) => entry.route === 'vault.supply')!.disclosure,
    ]);
    expect(review.summary.requiresDisclosure).toBe(true);
    expect(operations.vaultSubmitted).toEqual([]);

    await panel.confirm();
    const done = panel.store.getState();
    expect(done.flow).toMatchObject({ name: 'submitted', outcome: 'succeeded' });
    expect(operations.vaultSubmitted).toEqual([{ kind: 'supply', token: STRK, amount: 5n * ONE }]);
    expect(receipts.pending('vault')).toHaveLength(1);
    expect(done.position).toEqual({ status: 'unrequested' });
    expect(done.notice).toEqual({ tone: 'info', text: COPY.vault.position.changed });

    panel.acknowledge();
    expect(receipts.pending('vault')).toEqual([]);
    expect(panel.store.getState().flow).toEqual({ name: 'composing' });
  });

  it('redeems everything by the vault’s preview, without an amount', async () => {
    const operations = fake({ balance: 20n * ONE, shares: 50n * ONE });
    const { panel } = machine(operations);
    await panel.open();
    panel.setMode('redeem');
    expect(panel.store.getState().disclosure).toBe(PRIVACY_REGISTER.find((entry) => entry.route === 'vault.redeem')!.disclosure);
    panel.setRedeemAll(true);
    await panel.prepare();
    const flow = panel.store.getState().flow;
    expect(flow.name === 'review' && flow.summary.action).toEqual({ kind: 'redeem', token: STRK, amount: 51n * ONE, all: true });
    await panel.confirm();
    expect(operations.vaultSubmitted.at(-1)).toEqual({ kind: 'redeem', token: STRK, amount: 51n * ONE, all: true });
  });

  it('refuses a malformed amount before the seam', async () => {
    const operations = fake();
    const prepare = vi.spyOn(operations, 'prepareVaultSupply');
    const { panel } = machine(operations);
    await panel.open();
    for (const text of ['', '0', 'abc', '1.0000000000000000001']) {
      panel.setAmount(text);
      await panel.prepare();
      expect(panel.store.getState().notice).toEqual({ tone: 'error', text: COPY.notices.badAmount });
    }
    expect(prepare).not.toHaveBeenCalled();
  });

  it('says plainly that the wallet cannot run a shadow account yet, and offers no form', async () => {
    const operations = fake({ capability: { supportsShadowAccounts: false, walletApiVersion: '0.10.3' } });
    const prepare = vi.spyOn(operations, 'prepareVaultSupply');
    const steps = probe();
    const { panel, failures } = machine(operations);
    await panel.open();
    expect(panel.store.getState().capability).toEqual({ status: 'unsupported' });
    panel.setAmount('1');
    await panel.prepare();
    expect(prepare).not.toHaveBeenCalled();
    expect(failures).toEqual([]);
    expect(steps).toEqual([{ step: 'capability', supported: false, walletApi: '0.10.3' }]);
  });

  it('turns a wallet that refuses the commitment as unsupported into the same message, kept in the Vault', async () => {
    const operations = fake();
    vi.spyOn(operations, 'vaultPositions').mockRejectedValue(
      Object.assign(new Error('This wallet does not support STRK20 shadow accounts yet.'), { kind: 'shadow-accounts-unsupported' }),
    );
    const { panel, failures } = machine(operations);
    await panel.open();
    await panel.refreshPosition();
    const state = panel.store.getState();
    expect(state.capability).toEqual({ status: 'unsupported' });
    expect(state.position).toMatchObject({ status: 'failed', message: COPY.errors['shadow-accounts-unsupported'] });
    // Handed on by kind alone: nothing a wallet wrote travels with it.
    expect(failures).toEqual([{ kind: 'shadow-accounts-unsupported', cause: null }]);
  });

  it('hands a 118 to the connect flow by kind, and shows the account message', async () => {
    const operations = fake({ capability: { registration: 'unregistered' } });
    const { panel, failures } = machine(operations);
    await panel.open();
    await panel.refreshPosition();
    expect(panel.store.getState().position).toMatchObject({ status: 'failed', kind: 'not-registered', message: COPY.errors['not-registered'] });
    expect(failures).toEqual([{ kind: 'not-registered', cause: null }]);
  });

  it('refuses to sign when the pool fee moved above the prepared total', async () => {
    const operations = fake();
    const { panel } = machine(operations);
    await panel.open();
    panel.setAmount('1');
    await panel.prepare();
    vi.spyOn(operations, 'poolConfig').mockResolvedValue({
      feeAmount: POOL_FEE + 1n,
      feeToken: STRK,
      proofValidityBlocks: 450,
      noteMaturityBlocks: 0,
    });
    await panel.confirm();
    expect(panel.store.getState().flow).toMatchObject({ name: 'failed', message: COPY.notices.feeMoved, recovery: 'prepare-again' });
    expect(operations.vaultSubmitted).toEqual([]);
  });

  it('holds new work while the D-035 gate is closed', async () => {
    let open = true;
    const operations = fake();
    const { panel } = machine(operations, { canStart: () => open });
    await panel.open();
    panel.setAmount('1');
    open = false;
    await panel.prepare();
    expect(panel.store.getState().notice).toEqual({ tone: 'error', text: COPY.errors['submission-uncertain'] });
    open = true;
    await panel.prepare();
    open = false;
    await panel.confirm();
    expect(panel.store.getState().flow.name).toBe('review');
    expect(operations.vaultSubmitted).toEqual([]);
  });

  it('keeps a declined confirm recoverable, and a second confirm never starts', async () => {
    const operations = fake();
    operations.injectFault({ kind: 'user-rejected', on: 'vaultConfirm' });
    const { panel, failures } = machine(operations);
    await panel.open();
    panel.setAmount('1');
    await panel.prepare();
    const first = panel.confirm();
    const second = panel.confirm();
    await Promise.all([first, second]);
    expect(panel.store.getState().flow).toMatchObject({ name: 'failed', kind: 'user-rejected', recovery: 'prepare-again' });
    expect(failures).toEqual([{ kind: 'user-rejected', cause: null }]);
    panel.cancelPrepared();
    expect(panel.store.getState().flow).toEqual({ name: 'composing' });
  });

  it('shows a receipt that arrived while the window was shut when it reopens', async () => {
    const operations = fake();
    const { panel, receipts } = machine(operations);
    await panel.open();
    panel.setAmount('1');
    await panel.prepare();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const flow = panel.store.getState().flow;
    if (flow.name !== 'review') throw new Error('expected a review');
    // Close mid-confirm: the fake answers only once released.
    vi.spyOn(operations, 'poolConfig').mockImplementationOnce(async () => {
      await held;
      return { feeAmount: POOL_FEE, feeToken: STRK, proofValidityBlocks: 450, noteMaturityBlocks: 0 };
    });
    const confirming = panel.confirm();
    panel.close();
    release();
    await confirming;
    // Closed before the wallet was asked: nothing was sent, nothing recorded.
    expect(receipts.pending('vault')).toEqual([]);
    receipts.record({ building: 'vault', transactionHash: '0x5eed', intents: [] });
    await panel.open();
    expect(panel.store.getState().flow).toEqual({ name: 'submitted', transactionHash: '0x5eed', outcome: 'pending', restored: true });
  });

  it('tells the probe log codes and stage names only', async () => {
    const steps = probe();
    const { panel } = machine(fake({ shares: 50n * ONE }));
    await panel.open();
    await panel.refreshPosition();
    panel.setAmount('5');
    await panel.prepare();
    await panel.confirm();
    const seam = (stage: VaultStage) => ({ step: 'stage', stage });
    expect(steps).toEqual([
      { step: 'capability', supported: true, walletApi: '0.10.4' },
      seam({ stage: 'capability', supported: true }),
      seam({ stage: 'commitment', ok: true }),
      seam({ stage: 'address', resolved: true, deployed: true }),
      seam({ stage: 'position', ok: true }),
      { step: 'prepare', kind: 'supply', all: false },
      seam({ stage: 'capability', supported: true }),
      seam({ stage: 'address', resolved: true, deployed: true }),
      { step: 'confirm', kind: 'supply', stage: 'composing' },
      { step: 'confirm', kind: 'supply', stage: 'awaiting-approval' },
      seam({ stage: 'submit', ok: true }),
      { step: 'confirm', kind: 'supply', stage: 'confirming' },
      seam({ stage: 'receipt', status: 'succeeded' }),
      { step: 'confirm', kind: 'supply', stage: 'done' },
      { step: 'confirm', kind: 'supply', stage: 'submitted' },
    ]);
    const text = JSON.stringify(steps);
    expect(text).not.toMatch(/0x[0-9a-f]{6,}/i);
    expect(text).not.toMatch(/\d{6,}/);
  });

  it('locks every control when the build policy leaves the Vault off', async () => {
    const operations = fake();
    const denyAll = {
      maxIntents: 0,
      maxRelayFee: 0n,
      enabledRoutes: [] as const,
      allowedTokens: { shield: [], unshield: [], transfer: [], swap: [] },
    };
    vi.resetModules();
    vi.doMock('../../production/config.js', async (importOriginal) => ({
      ...(await importOriginal<typeof import('../../production/config.js')>()),
      detectRoutePolicy: () => denyAll,
    }));
    try {
      const { createVaultPanel: create } = await import('./vault-machine.js');
      const { COPY: copy } = await import('../../copy.js');
      const panel = create({ operations, receipts: createReceiptLedger(), canStartFinancialAction: () => true });
      await panel.open();
      expect(panel.store.getState().door).toMatchObject({ open: false, reason: 'not-enabled', message: copy.locked.notEnabled.vault });
      panel.setMode('redeem');
      expect(panel.store.getState().door).toMatchObject({ open: false, reason: 'not-enabled' });
      panel.setAmount('1');
      const prepare = vi.spyOn(operations, 'prepareVaultRedeem');
      await panel.prepare();
      expect(prepare).not.toHaveBeenCalled();
    } finally {
      vi.doUnmock('../../production/config.js');
      vi.resetModules();
    }
  });
});
