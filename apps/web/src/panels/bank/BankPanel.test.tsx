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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

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
  options: { allowedModes?: readonly BankMode[]; initialMode?: BankMode; title?: string; register?: readonly RouteGrade[] } = {},
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
  it('shows the avatar attention cue while a requested private balance waits on the wallet', async () => {
    const seam = operations();
    const panel = createAllowedBankPanel({ operations: seam, receipts: createReceiptLedger() });
    await panel.open();

    const loading = panel.refreshBalance();
    const markup = render(panel, seam);
    expect(markup).toContain('data-wallet-attention="balance"');
    expect(markup).toMatch(/<img[^>]+avatar-walker\/walk\.png/);
    await loading;

    expect(render(panel, seam)).not.toContain('data-wallet-attention');
  });

  it('shows the avatar attention cue only for the wallet-owned approval stage', async () => {
    const seam = new FakePrivacyOperations({
      balances: { [STRK]: parseTokenAmount('100')! },
      registered: [BOB],
    });
    const approval = deferred<void>();
    const approvalEntered = deferred<void>();
    const originalPrepare = seam.prepare.bind(seam);
    seam.prepare = async (...args) => {
      const batch = await originalPrepare(...args);
      return {
        ...batch,
        confirm: async (options: Parameters<typeof batch.confirm>[0]) => {
          options.onProgress?.({ stage: 'awaiting-approval', message: COPY.flow.awaitingApproval });
          approvalEntered.resolve();
          await approval.promise;
          return { transactionHash: '0xattention' };
        },
      };
    };
    const panel = createAllowedBankPanel({ operations: seam, receipts: createReceiptLedger() });
    await panel.open();
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();

    const confirming = panel.confirm();
    await approvalEntered.promise;
    expect(render(panel, seam)).toContain('data-wallet-attention="confirm"');

    approval.resolve();
    await confirming;
    expect(render(panel, seam)).not.toContain('data-wallet-attention');
  });

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
    // The transfer's disclosure is waived (D-065), so nothing must be disclosed.
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

  it('composes a transfer as one send in Bank Menu Mode, and says why a second is refused (D-065)', async () => {
    const seam = operations();
    const panel = createAllowedBankPanel({ operations: seam, receipts: createReceiptLedger() });
    await panel.open();
    panel.setMode('transfer');

    const empty = render(panel, seam, 'menu');
    expect(empty).toContain(COPY.postOffice.oneAtATime);
    expect(empty).toContain(COPY.bank.enterRecipient);
    panel.setRecipient(BOB);
    panel.setAmount('1');
    // Filled in, the button reviews one send, never "add to this visit".
    expect(render(panel, seam, 'menu')).toContain(COPY.gameMode.reviewAction);
    panel.setRecipient('');
    panel.setAmount('');
    expect(empty).not.toContain(COPY.batch.add);
    expect(empty).not.toContain(COPY.batch.empty);
    expect(empty).not.toContain(COPY.batch.why);

    panel.setRecipient(BOB);
    panel.setAmount('1');
    await panel.addToBatch();
    panel.setRecipient(BOB);
    panel.setAmount('2');
    await panel.addToBatch();

    const refused = render(panel, seam, 'menu');
    expect(refused).toContain(COPY.notices.oneRecipientPerSend);
    expect(refused).toContain('Private transfer 1 STRK');
    expect(refused).not.toContain('Private transfer 2 STRK');
    // What is queued keeps its Remove and Clear controls.
    expect(refused).toContain(COPY.batch.remove);
    expect(refused).toContain(COPY.batch.clear);
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

  it('marks non-active mode tabs from the machine route register', async () => {
    const unapproved: RouteGrade = {
      building: 'bank',
      route: 'bank.unshield',
      grade: 'public-edge',
      observable: 'test fixture',
      disclosure: null,
      approvedBy: null,
      approvedOn: null,
      rationale: null,
      returnToPool: false,
    };
    const shieldRoute = PRIVACY_REGISTER.find((entry) => entry.route === 'bank.shield')!;
    const seam = operations();
    const panel = createAllowedBankPanel({
      operations: seam,
      receipts: createReceiptLedger(),
      allowedModes: ['shield', 'unshield'],
      initialMode: 'shield',
      register: [shieldRoute, unapproved],
    });
    await panel.open();

    const markup = render(panel, seam, 'menu', undefined, {
      allowedModes: ['shield', 'unshield'],
      initialMode: 'shield',
      register: [shieldRoute, unapproved],
    });
    expect(markup).toMatch(/<button[^>]*data-locked="true"[^>]*>Unshield<\/button>/);
  });

  it('tells the player a restored receipt settled while the room was shut, not that it was just sent', async () => {
    const receipts = createReceiptLedger();
    receipts.record({ building: 'bank', transactionHash: '0xrestored', intents: [] });
    const seam = operations();
    const panel = createAllowedBankPanel({ operations: seam, receipts });
    await panel.open();

    const markup = render(panel, seam);
    expect(markup).toContain(COPY.flow.receiptWaiting);
    expect(markup).not.toContain(COPY.flow.submitted);
  });

  it('says "Sent." for a receipt confirmed this session, not the restored line', async () => {
    const seam = operations();
    const panel = createAllowedBankPanel({ operations: seam, receipts: createReceiptLedger() });
    await panel.open();
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();
    await panel.confirm();

    const markup = render(panel, seam);
    expect(markup).toContain(COPY.flow.submitted);
    expect(markup).not.toContain(COPY.flow.receiptWaiting);
  });

  it('gives pool fee and network cost an accessible, keyboard-reachable "what\'s this?" disclosure at the review point', async () => {
    const seam = operations();
    const panel = createAllowedBankPanel({ operations: seam, receipts: createReceiptLedger() });
    await panel.open();
    // A spend's review states both; a shield's states the fee on top instead (D-094).
    panel.setMode('transfer');
    panel.setRecipient(BOB);
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();

    const markup = render(panel, seam);
    // <details>/<summary> is native keyboard- and screen-reader-reachable, not hover-only.
    expect(markup).toMatch(/<details class="glossary-term"><summary>Pool fee<\/summary>/);
    expect(markup).toContain(COPY.glossary.poolFee);
    expect(markup).toMatch(/<details class="glossary-term"><summary>Network cost<\/summary>/);
    expect(markup).toContain(COPY.glossary.networkCost);
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

  it('shows the relay message with a way back to the queued item, in the Bank and the Post Office (D-070)', async () => {
    const message = COPY.errors['relay-not-configured'].replaceAll("'", '&#x27;');
    for (const [mode, options] of [
      ['unshield', {}],
      ['transfer', { allowedModes: ['transfer'] as const, initialMode: 'transfer' as const, title: COPY.buildings['post-office'] }],
    ] as const) {
      const seam = operations();
      const panel = createAllowedBankPanel({
        operations: seam,
        receipts: createReceiptLedger(),
        ...('allowedModes' in options ? { allowedModes: options.allowedModes, initialMode: options.initialMode } : {}),
      });
      await panel.open();
      panel.setMode(mode);
      panel.setRecipient(BOB);
      panel.setAmount('1');
      await panel.addToBatch();
      seam.injectFault({ kind: 'relay-not-configured', on: 'prepare' });
      await panel.prepare();

      const markup = render(panel, seam, 'menu', createSubmissionUncertainty(), options);
      expect(markup, mode).toContain(`<div class="flow-failed" role="alert"><p>${message}</p><button type="button">${COPY.flow.back}</button>`);
      expect(markup, mode).not.toContain(COPY.errors.unreachable);
    }
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

  it('shows the pool fee on every control, and the private balance on the field of each that spends it (D-091)', async () => {
    const seam = operations();
    const panel = createAllowedBankPanel({ operations: seam, receipts: createReceiptLedger() });
    await panel.open();
    await settle();
    await panel.refreshBalance();

    // D-094: shielding spends the wallet's public STRK, so its field shows
    // that, never the pool figure or its settling note, and its disclosure
    // stays in the header.
    const shield = render(panel, seam);
    expect(shield).toContain(SHIELD_DISCLOSURE);
    expect(shield).not.toContain('class="balance-total"');
    expect(shield).toContain(`<span class="ui-amount-balance">${COPY.kit.walletBalance}: <span class="ui-figure">1000 STRK</span></span>`);
    expect(shield).not.toContain(COPY.kit.poolBalance);
    expect(shield).not.toContain(COPY.balance.maturityUnknown);
    expect(shield).toMatch(/<dt>[^]*?Pool fee[^]*?<\/dt><dd>6 STRK<\/dd>/);

    for (const mode of ['unshield', 'transfer', 'stake'] as const) {
      panel.setMode(mode);
      const markup = render(panel, seam);
      expect(markup, mode).toContain(`<span class="ui-amount-balance">${COPY.kit.poolBalance}: <span class="ui-figure">100 STRK</span></span>`);
      expect(markup, mode).not.toContain('class="balance-total"');
      // Its Refresh sits beside the balance line, and no empty card is left above.
      expect(markup, mode).toContain(`aria-label="${COPY.balance.refreshLabel}">${COPY.balance.refreshShort}</button>`);
      expect(markup, mode).not.toContain('class="panel-balance"');
      // One primary at a time: nothing is queued, so there is no review button.
      expect(markup, mode).not.toContain('class="review"');
      expect(markup, mode).toMatch(/<dt>[^]*?Pool fee[^]*?<\/dt><dd>6 STRK<\/dd>/);
      // Swap conventions stay at the Exchange.
      expect(markup, mode).not.toContain(COPY.kit.half);
      expect(markup, mode).not.toContain('Slippage');
    }
  });

  it('says an amount over the read balance is too much, inline and on the button', async () => {
    const seam = operations();
    const panel = createAllowedBankPanel({ operations: seam, receipts: createReceiptLedger() });
    await panel.open();
    panel.setMode('unshield');
    await panel.refreshBalance();
    panel.setRecipient(BOB);
    panel.setAmount('101');

    const markup = render(panel, seam);
    expect(markup).toContain(COPY.kit.exceedsBalance);
    expect(markup).toMatch(new RegExp(`<button type="submit" disabled="">${COPY.kit.insufficient.replace('{symbol}', 'STRK')}</button>`));
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
    // A send is wallet-submitted (D-082): the seam states no relay estimate,
    // and the pool fee and total survive at full precision.
    expect(markup).toContain('6 STRK');
    expect(markup).toContain('<dd>0 STRK</dd>');
    expect(markup).not.toContain('0.001 STRK');
  });

  it('states a queued shield\'s public leg in STRK, never in base units (D-072)', async () => {
    const seam = operations();
    const panel = createAllowedBankPanel({ operations: seam, receipts: createReceiptLedger() });
    await panel.open();
    panel.setMode('shield');
    panel.setAmount('0.5');
    await panel.addToBatch();
    await panel.prepare();

    const markup = render(panel, seam);
    const warnings = markup.slice(markup.indexOf('class="review-warnings"'));
    // D-094: the public leg is the deposit, the amount plus the pool fee on top.
    expect(warnings).toContain('Depositing 6.5 STRK is public: the amount and your address are visible on-chain.');
    expect(markup).not.toContain('500000000000000000');
    // The approved disclosure is still the register's own words, at the commit point.
    expect(commitGate(markup)).toContain(SHIELD_DISCLOSURE);
  });
});

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('BankPanel — the Shield tab shows the wallet balance it spends (D-094)', () => {
  function walletSeam(publicStrk: string, privateStrk = '0') {
    return new FakePrivacyOperations({
      balances: { [STRK]: parseTokenAmount(privateStrk)! },
      publicBalances: { [STRK]: parseTokenAmount(publicStrk)! },
      registered: [BOB],
    });
  }

  it('shows "Wallet balance: 29 STRK", not the pool balance or its settling note', async () => {
    const seam = walletSeam('29');
    const panel = createAllowedBankPanel({ operations: seam, receipts: createReceiptLedger() });
    await panel.open();
    await settle();
    const markup = render(panel, seam);
    expect(markup).toContain(`<span class="ui-amount-balance">Wallet balance: <span class="ui-figure">29 STRK</span></span>`);
    expect(markup).not.toContain('Pool balance');
    expect(markup).not.toContain(COPY.balance.maturityUnknown);
    expect(markup).not.toContain('class="balance-total"');
    // Refresh sits beside it, and Max is offered.
    expect(markup).toContain(`aria-label="${COPY.balance.refreshLabel}">${COPY.balance.refreshShort}</button>`);
    expect(markup).toMatch(/aria-label="Fill in the most you can use">Max<\/button>/);
  });

  it('says it is reading the wallet balance until the chain answers', async () => {
    const seam = walletSeam('29');
    const panel = createAllowedBankPanel({ operations: seam, receipts: createReceiptLedger() });
    await panel.open();
    const markup = render(panel, seam);
    expect(markup).toContain(COPY.balance.publicLoading);
    expect(markup).not.toContain(COPY.balance.unrequested);
  });

  it('shows what is shielded, the pool fee on top and the total from the wallet', async () => {
    const seam = walletSeam('29');
    const panel = createAllowedBankPanel({ operations: seam, receipts: createReceiptLedger() });
    await panel.open();
    await settle();
    panel.setAmount('13');
    const markup = render(panel, seam);
    expect(markup).toContain('<dt>You shield</dt><dd>13 STRK</dd>');
    expect(markup).toMatch(/<dt>[^]*?Pool fee[^]*?<\/dt><dd>6 STRK<\/dd>/);
    expect(markup).toContain('<dt>Total from your wallet</dt><dd>19 STRK</dd>');
    expect(markup).toContain(COPY.bank.shieldFeeOnTop);
  });

  it('nudges that the fee is fixed when it is a large share of a small shield', async () => {
    const seam = walletSeam('29');
    const panel = createAllowedBankPanel({ operations: seam, receipts: createReceiptLedger() });
    await panel.open();
    await settle();
    panel.setAmount('3');
    expect(render(panel, seam)).toContain(COPY.bank.shieldFeeNudge);
    panel.setAmount('13');
    expect(render(panel, seam)).not.toContain(COPY.bank.shieldFeeNudge);
  });

  it('says Insufficient STRK when the amount plus the fee is more than the wallet holds', async () => {
    const seam = walletSeam('29');
    const panel = createAllowedBankPanel({ operations: seam, receipts: createReceiptLedger() });
    await panel.open();
    await settle();
    panel.setAmount('24');
    const markup = render(panel, seam);
    expect(markup).toContain(COPY.bank.exceedsWallet);
    expect(markup).toContain('<button type="submit" disabled="">Insufficient STRK</button>');
    panel.setAmount('23');
    expect(render(panel, seam)).not.toContain('Insufficient STRK');
  });

  it('notes why Max left some behind', async () => {
    const seam = walletSeam('29');
    const panel = createAllowedBankPanel({ operations: seam, receipts: createReceiptLedger() });
    await panel.open();
    await settle();
    panel.applyMax();
    const markup = render(panel, seam);
    expect(markup).toContain('value="23"');
    expect(markup).toContain(COPY.bank.shieldMaxNote);
  });

  it('switching to Unshield shows the pool balance again, with its own note', async () => {
    const seam = walletSeam('29', '100');
    const panel = createAllowedBankPanel({ operations: seam, receipts: createReceiptLedger() });
    await panel.open();
    await settle();
    panel.setMode('unshield');
    await panel.refreshBalance();
    const markup = render(panel, seam);
    expect(markup).toContain(`${COPY.kit.poolBalance}: <span class="ui-figure">100 STRK</span>`);
    expect(markup).not.toContain(COPY.kit.walletBalance);

    panel.setMode('shield');
    await settle();
    expect(render(panel, seam)).toContain(`${COPY.kit.walletBalance}: <span class="ui-figure">29 STRK</span>`);
  });

  it('reviews the shield with the fee on top, and says when the funds appear', async () => {
    const seam = walletSeam('29');
    const panel = createAllowedBankPanel({ operations: seam, receipts: createReceiptLedger() });
    await panel.open();
    await settle();
    panel.setAmount('9');
    await panel.addToBatch();
    await panel.prepare();
    const review = render(panel, seam);
    const figures = review.slice(review.indexOf('data-review="shield"'));
    expect(figures).toMatch(/<dt>You shield<\/dt><dd>9 STRK<\/dd>[^]*?Pool fee[^]*?<dd[^>]*>6 STRK<\/dd><dt>Total from your wallet<\/dt><dd>15 STRK<\/dd>/);
    expect(review).toContain('Depositing 15 STRK is public');
    expect(review).toContain('<li>Shield 9 STRK</li>');

    await panel.confirm();
    expect(panel.store.getState().flow).toMatchObject({ name: 'submitted', shielded: true });
    const done = render(panel, seam);
    expect(done).toContain(COPY.flow.submitted);
    expect(done).toContain(COPY.bank.shieldArrives.replace("'", '&#x27;'));
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
    // Restored on reopen, not confirmed in this session — the room was shut
    // when it settled, so this is the receiptWaiting line, not "Sent.".
    expect(markup).toContain(COPY.flow.receiptWaiting);
    expect(markup).not.toContain(COPY.flow.submitted);
    expect(markup).toContain(COPY.flow.back);
  });
});
