import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FakePrivacyOperations, type Address } from '@strkworld/privacy';
import { COPY } from '../../copy.js';
import { PrivacyProvider } from '../../privacy/PrivacyProvider.js';
import { createSubmissionUncertainty } from '../../privacy/submission-uncertainty.js';
import { PRIVACY_REGISTER, type RouteGrade } from '../../privacy/register.js';
import { parseTokenAmount } from '../../format.js';
import { createReceiptLedger } from '../../receipts/receipt-ledger.js';
import {
  createBankPanel,
  type BankPanel as BankPanelMachine,
  type BankPanelOptions,
  type BankMode,
} from './bank-machine.js';
import { BankPanel } from './BankPanel.js';

/**
 * Render-path rules.
 *
 * The machine tests prove what the Bank decides; these prove what actually
 * reaches a screen. Both matter and they fail differently: every blocker fixed
 * here was a correct machine rendered wrongly.
 *
 * Static rendering rather than a DOM: it needs no jsdom and no testing-library,
 * and every rule below is about what is present at a given state rather than
 * about interaction. `useStore` reads through `useSyncExternalStore`'s server
 * snapshot, so a machine driven before rendering renders exactly its state.
 */

const STRK: Address = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const BOB: Address = '0x02b4c7d1a1f8f39e0e6e8b9a2c7d0e3f4a5b6c7d8e9f0a1b2c3d4e5f60718293';
const SHIELD_DISCLOSURE = PRIVACY_REGISTER.find((entry) => entry.route === 'bank.shield')!.disclosure!;
const allowFinancialActions = () => true;

function createAllowedBankPanel(options: Omit<BankPanelOptions, 'canStartFinancialAction'>) {
  return createBankPanel({ ...options, canStartFinancialAction: allowFinancialActions });
}

function operations() {
  return new FakePrivacyOperations({
    balances: { [STRK]: parseTokenAmount('100')! },
    registered: [BOB],
    latencyMs: 2,
  });
}

function render(
  panel: BankPanelMachine,
  seam: FakePrivacyOperations,
  experience: 'menu' | 'station' = 'menu',
  submissionUncertainty = createSubmissionUncertainty(),
  options: { allowedModes?: readonly BankMode[]; initialMode?: BankMode; title?: string } = {},
): string {
  return renderToStaticMarkup(
    <PrivacyProvider operations={seam} submissionUncertainty={submissionUncertainty}>
      <BankPanel panel={panel} experience={experience} onClose={() => {}} {...options} />
    </PrivacyProvider>,
  );
}

/** The ConfirmGate subtree, so assertions cannot be satisfied by the page around it. */
function commitGate(markup: string): string | null {
  const start = markup.indexOf('class="confirm-gate"');
  if (start === -1) return null;
  return markup.slice(start);
}

/** The confirm button's opening tag, or null when it is not on screen at all. */
function confirmButton(markup: string): string | null {
  return markup.match(/<button[^>]*class="confirm"[^>]*>/)?.[0] ?? null;
}

describe('BankPanel rendering', () => {
  it('keeps the approved disclosure inside the station commit gate', async () => {
    const seam = operations();
    const panel = createAllowedBankPanel({
      operations: seam,
      receipts: createReceiptLedger(),
      maxIntents: 1,
    });
    await panel.open();
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();

    const gate = commitGate(render(panel, seam, 'station'));
    expect(gate).not.toBeNull();
    expect(gate).toContain(SHIELD_DISCLOSURE);
    expect(confirmButton(gate!)).not.toBeNull();
  });

  it('renders the queued batch disclosure at the commit point, after a tab switch', async () => {
    const seam = operations();
    const panel = createAllowedBankPanel({ operations: seam, receipts: createReceiptLedger() });
    await panel.open();
    panel.setAmount('1');
    await panel.addToBatch();
    // The reproduction: queue a shield, then move to a tab whose route needs no
    // disclosure. The header disclosure goes; the commit surface must not.
    panel.setMode('transfer');
    await panel.prepare();

    const markup = render(panel, seam);
    expect(markup).toContain(SHIELD_DISCLOSURE);
    expect(confirmButton(markup)).not.toBeNull();

    // And it sits inside the commit gate, not somewhere else on the page.
    const gate = markup.slice(markup.indexOf('commit-disclosures'));
    expect(gate).toContain(SHIELD_DISCLOSURE);
  });

  it('never shows a confirm button without the disclosures for what it commits', async () => {
    const seam = operations();
    const panel = createAllowedBankPanel({ operations: seam, receipts: createReceiptLedger() });
    await panel.open();
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();

    // Inside the gate's own subtree. An earlier version of this test only
    // asserted "somewhere before the button", which the panel header satisfied
    // while never leaving shield mode — so it would have passed with the gate
    // rendering no disclosure at all.
    const gate = commitGate(render(panel, seam));
    expect(gate).not.toBeNull();
    expect(gate).toContain(SHIELD_DISCLOSURE);
    expect(gate!.indexOf(SHIELD_DISCLOSURE)).toBeLessThan(gate!.indexOf('class="confirm"'));
  });

  it('withdraws the tab-keyed header disclosure at the commit point', async () => {
    // The reverse mismatch: a private transfer queued while the shield tab is
    // selected used to show public-deposit copy over a private transfer.
    const seam = operations();
    const panel = createAllowedBankPanel({ operations: seam, receipts: createReceiptLedger() });
    await panel.open();
    panel.setMode('transfer');
    panel.setRecipient(BOB);
    panel.setAmount('1');
    await panel.addToBatch();
    panel.setMode('shield');
    await panel.prepare();

    const markup = render(panel, seam);
    // A private transfer discloses nothing, so nothing must be disclosed.
    expect(markup).not.toContain(SHIELD_DISCLOSURE);
    expect(markup).not.toContain('data-testid="disclosure"');
    expect(commitGate(markup)).not.toContain('commit-disclosures');
  });

  it('keeps the Post Office transfer in ConfirmGate without a public disclosure', async () => {
    const seam = operations();
    const panel = createAllowedBankPanel({
      operations: seam,
      receipts: createReceiptLedger(),
      allowedModes: ['transfer'],
      initialMode: 'transfer',
      maxIntents: 1,
    });
    await panel.open();
    panel.setRecipient(BOB);
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();

    const markup = render(panel, seam, 'station', undefined, {
      allowedModes: ['transfer'],
      initialMode: 'transfer',
      title: 'The Post Office',
    });
    const gate = commitGate(markup);
    expect(gate).not.toBeNull();
    expect(gate).toContain('class="confirm"');
    expect(gate).not.toContain('commit-disclosures');
    expect(markup).toContain('The Post Office');
    expect(markup).toContain('Private transfer');
    expect(markup).not.toContain('Shield');
    expect(markup).not.toContain('Unshield');
    expect(markup).not.toContain('Add to this visit');
  });

  it('keeps a queued Post Office action reviewable without Menu Mode batch controls', async () => {
    const seam = operations();
    const panel = createAllowedBankPanel({
      operations: seam,
      receipts: createReceiptLedger(),
      allowedModes: ['transfer'],
      initialMode: 'transfer',
      maxIntents: 1,
    });
    await panel.open();
    panel.setRecipient(BOB);
    panel.setAmount('1');
    await panel.addToBatch();

    const markup = render(panel, seam, 'station', undefined, {
      allowedModes: ['transfer'],
      initialMode: 'transfer',
      title: 'The Post Office',
    });
    expect(markup).toContain('Private transfer 1 STRK');
    expect(markup).toMatch(/<button[^>]*class="review"[^>]*>Check this before you confirm<\/button>/);
    expect(markup).not.toContain(COPY.batch.title);
    expect(markup).not.toContain(COPY.batch.add);
    expect(markup).not.toContain(COPY.batch.empty);
    expect(markup).not.toContain(COPY.batch.clear);
    expect(markup).not.toContain(COPY.batch.why);
  });

  it('keeps the clear-batch control in Bank Menu Mode', async () => {
    const seam = operations();
    const panel = createAllowedBankPanel({ operations: seam, receipts: createReceiptLedger() });
    await panel.open();
    panel.setAmount('1');
    await panel.addToBatch();

    const markup = render(panel, seam, 'menu');
    expect(markup).toContain(COPY.batch.title);
    expect(markup).toContain(COPY.batch.clear);
    expect(markup).toContain(COPY.batch.why);
  });

  it('disables confirm while the wallet works, and keeps the disclosure on screen', async () => {
    const seam = operations();
    const panel = createAllowedBankPanel({ operations: seam, receipts: createReceiptLedger() });
    await panel.open();
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();

    const submitting = panel.confirm();
    const markup = render(panel, seam);
    expect(confirmButton(markup)).toContain('disabled');
    expect(markup).toContain(SHIELD_DISCLOSURE);
    expect(markup).toContain(COPY.flow.handingOver);
    await submitting;
  });

  it('renders a locked door for a locked route, not a form nobody can submit', async () => {
    const unapproved: RouteGrade = {
      building: 'bank',
      route: 'bank.shield',
      grade: 'public-edge',
      observable: 'test fixture',
      disclosure: null,
      approvedBy: null,
      approvedOn: null,
      rationale: null,
      returnToPool: false,
    };
    const seam = operations();
    const panel = createAllowedBankPanel({
      operations: seam,
      receipts: createReceiptLedger(),
      register: [unapproved],
    });
    await panel.open();

    const markup = render(panel, seam);
    expect(markup).toContain(COPY.locked.unapprovedRoute);
    expect(markup).toContain('data-lock-reason="unapproved-route"');
    // No amount field, no balance control, and nothing offering a way around.
    expect(markup).not.toContain('name="amount"');
    expect(markup).not.toContain(COPY.balance.refresh);
    expect(confirmButton(markup)).toBeNull();
    // The tab itself is marked, so the door is visibly shut before it is tried.
    expect(markup).toMatch(/<button[^>]*data-locked="true"/);
  });

  it('shows uncertainty without a retry path or another financial form', async () => {
    const seam = operations();
    const panel = createAllowedBankPanel({ operations: seam, receipts: createReceiptLedger() });
    await panel.open();
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();
    seam.injectFault({ kind: 'submission-uncertain', on: 'confirm' });
    await panel.confirm();

    const markup = render(panel, seam, 'station');
    expect(markup).toContain(COPY.errors['submission-uncertain']);
    expect(markup).not.toContain('Try again');
    expect(markup).not.toContain('Nothing was sent');
    expect(markup).not.toContain('name="amount"');
    expect(markup).not.toContain('Review this action');
  });

  it('renders balance/recovery only while the D-035 gate blocks an open review', async () => {
    const seam = operations();
    const uncertainty = createSubmissionUncertainty();
    const panel = createBankPanel({
      operations: seam,
      receipts: createReceiptLedger(),
      canStartFinancialAction: () => {
        const state = uncertainty.store.getState();
        return !state.active || state.acknowledged;
      },
    });
    await panel.open();
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();
    uncertainty.retain();
    await panel.confirm();

    const markup = render(panel, seam, 'station', uncertainty);
    expect(seam.submitted).toHaveLength(0);
    expect(markup).toContain(COPY.balance.refresh);
    expect(markup).not.toContain('name="amount"');
    expect(confirmButton(markup)).toBeNull();
  });

  it('opens a new Bank with its financial form withheld while the session gate is active', async () => {
    const seam = operations();
    const prepare = vi.spyOn(seam, 'prepare');
    const uncertainty = createSubmissionUncertainty();
    uncertainty.retain();
    const panel = createBankPanel({
      operations: seam,
      receipts: createReceiptLedger(),
      canStartFinancialAction: () => {
        const state = uncertainty.store.getState();
        return !state.active || state.acknowledged;
      },
    });
    await panel.open();
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();

    const markup = render(panel, seam, 'menu', uncertainty);
    expect(panel.store.getState().batch).toHaveLength(0);
    expect(prepare).not.toHaveBeenCalled();
    expect(seam.submitted).toHaveLength(0);
    expect(markup).toContain(COPY.balance.refresh);
    expect(markup).not.toContain('name="amount"');
    expect(markup).not.toContain(COPY.batch.add);
    expect(confirmButton(markup)).toBeNull();
  });

  it('releases the same Bank surface after acknowledgement', async () => {
    const seam = operations();
    const uncertainty = createSubmissionUncertainty();
    const panel = createBankPanel({
      operations: seam,
      receipts: createReceiptLedger(),
      canStartFinancialAction: () => {
        const state = uncertainty.store.getState();
        return !state.active || state.acknowledged;
      },
      onError: (failure) => {
        if (failure.kind === 'submission-uncertain') uncertainty.retain();
      },
    });
    await panel.open();
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();
    seam.injectFault({ kind: 'submission-uncertain', on: 'confirm' });
    await panel.confirm();

    expect(confirmButton(render(panel, seam, 'station', uncertainty))).toBeNull();
    uncertainty.acknowledge();
    const markup = render(panel, seam, 'station', uncertainty);
    expect(markup).toContain('name="amount"');
    expect(markup).not.toContain(COPY.submissionUncertainty.acknowledge);
  });

  it('offers a way back to the counter after a submission', async () => {
    const seam = operations();
    const panel = createAllowedBankPanel({ operations: seam, receipts: createReceiptLedger() });
    await panel.open();
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();
    await panel.confirm();

    const markup = render(panel, seam);
    expect(markup).toContain(COPY.flow.submitted);
    expect(markup).toContain(COPY.flow.back);
  });

  it('offers no MAX control until a maximum can be stated', async () => {
    const seam = operations();
    const panel = createAllowedBankPanel({ operations: seam, receipts: createReceiptLedger() });
    await panel.open();
    panel.setMode('transfer');
    await panel.refreshBalance();

    const markup = render(panel, seam);
    expect(markup).toContain('name="amount"');
    expect(markup).not.toContain(`>${COPY.bank.max}<`);
  });

  it('states review figures exactly', async () => {
    const seam = operations();
    const panel = createAllowedBankPanel({ operations: seam, receipts: createReceiptLedger() });
    await panel.open();
    panel.setMode('transfer');
    panel.setRecipient(BOB);
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();

    const markup = render(panel, seam);
    // The relay estimate is 0.001 STRK — a four-decimal display would show it
    // as 0.001, but the pool fee and total must survive at full precision.
    expect(markup).toContain('6 STRK');
    expect(markup).toContain('0.001 STRK');
  });
});

describe('BankPanel — closing during a signature', () => {
  it('says plainly that closing will not cancel it', async () => {
    const seam = operations();
    const panel = createAllowedBankPanel({ operations: seam, receipts: createReceiptLedger() });
    await panel.open();
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();

    const submitting = panel.confirm();
    const markup = render(panel, seam);
    // The close control stays enabled — a disabled one traps the player behind
    // a wallet that may never answer, and the world can unmount the panel
    // regardless. The receipt ledger is what makes closing safe.
    expect(markup).toContain(COPY.flow.closingWillNotCancel);
    expect(markup.match(/<button[^>]*class="panel-close"[^>]*>/)?.[0]).not.toContain('disabled');
    await submitting;
  });

  it('shows a receipt recovered from the ledger on reopening', async () => {
    const receipts = createReceiptLedger();
    const seam = operations();
    const first = createAllowedBankPanel({ operations: seam, receipts });
    await first.open();
    first.setAmount('1');
    await first.addToBatch();
    await first.prepare();
    await first.confirm();
    first.close();

    const reopened = createAllowedBankPanel({ operations: seam, receipts });
    await reopened.open();

    const markup = render(reopened, seam);
    expect(markup).toContain(COPY.flow.submitted);
    expect(markup).toContain(COPY.flow.back);
  });
});
