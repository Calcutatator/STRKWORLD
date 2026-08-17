import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FakePrivacyOperations, type Address } from '@strkworld/privacy';
import { COPY } from '../../copy.js';
import { PrivacyProvider } from '../../privacy/PrivacyProvider.js';
import { PRIVACY_REGISTER, type RouteGrade } from '../../privacy/register.js';
import { parseTokenAmount } from '../../format.js';
import { createBankPanel, type BankPanel as BankPanelMachine } from './bank-machine.js';
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

function operations() {
  return new FakePrivacyOperations({
    balances: { [STRK]: parseTokenAmount('100')! },
    registered: [BOB],
    latencyMs: 2,
  });
}

function render(panel: BankPanelMachine, seam: FakePrivacyOperations): string {
  return renderToStaticMarkup(
    <PrivacyProvider operations={seam}>
      <BankPanel panel={panel} onClose={() => {}} />
    </PrivacyProvider>,
  );
}

/** The confirm button's opening tag, or null when it is not on screen at all. */
function confirmButton(markup: string): string | null {
  return markup.match(/<button[^>]*class="confirm"[^>]*>/)?.[0] ?? null;
}

describe('BankPanel rendering', () => {
  it('renders the queued batch disclosure at the commit point, after a tab switch', async () => {
    const seam = operations();
    const panel = createBankPanel({ operations: seam });
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
    const panel = createBankPanel({ operations: seam });
    await panel.open();
    panel.setAmount('1');
    await panel.addToBatch();
    await panel.prepare();

    const markup = render(panel, seam);
    const button = markup.indexOf('class="confirm"');
    const disclosure = markup.indexOf(SHIELD_DISCLOSURE);
    expect(disclosure).toBeGreaterThan(-1);
    expect(disclosure).toBeLessThan(button);
  });

  it('disables confirm while the wallet works, and keeps the disclosure on screen', async () => {
    const seam = operations();
    const panel = createBankPanel({ operations: seam });
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
    const panel = createBankPanel({ operations: seam, register: [unapproved] });
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

  it('offers a way back to the counter after a submission', async () => {
    const seam = operations();
    const panel = createBankPanel({ operations: seam });
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
    const panel = createBankPanel({ operations: seam });
    await panel.open();
    panel.setMode('transfer');
    await panel.refreshBalance();

    const markup = render(panel, seam);
    expect(markup).toContain('name="amount"');
    expect(markup).not.toContain(`>${COPY.bank.max}<`);
  });

  it('states review figures exactly', async () => {
    const seam = operations();
    const panel = createBankPanel({ operations: seam });
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
