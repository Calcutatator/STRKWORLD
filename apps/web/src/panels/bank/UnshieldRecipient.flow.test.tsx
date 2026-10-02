// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { WalletSession, WalletSessionSnapshot } from '@strkworld/privacy';
import { COPY } from '../../copy.js';
import { shortenAddress } from '../../format.js';
import { createDemoOperations } from '../../privacy/demo-operations.js';
import { PrivacyProvider } from '../../privacy/PrivacyProvider.js';
import { createSubmissionUncertainty } from '../../privacy/submission-uncertainty.js';
import { createReceiptLedger } from '../../receipts/receipt-ledger.js';
import { createBankPanel, type BankPanel as BankPanelMachine, type BankMode } from './bank-machine.js';
import { BankPanel } from './BankPanel.js';

/**
 * The Unshield form's recipient, as a player drives it: it defaults to the
 * connected wallet's own address, and "Send to another address" reveals the
 * Paste field with its existing validation.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const OWN = '0x07ea1c3d5f70829a4b6c8d0e2f41538a6b7c9d0e1f2a3b4c5d6e7f8091a29731';
const OTHER = '0x02b4c7d1a1f8f39e0e6e8b9a2c7d0e3f4a5b6c7d8e9f0a1b2c3d4e5f60718293';

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  const owner = root;
  root = null;
  if (owner) act(() => owner.unmount());
  container?.remove();
  container = null;
});

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function button(label: string): HTMLButtonElement {
  const found = [...container!.querySelectorAll('button')].find((candidate) => candidate.textContent === label);
  if (!found) throw new Error(`No button labelled ${label}`);
  return found;
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.click();
  });
  await settle();
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function blur(input: HTMLInputElement): Promise<void> {
  await act(async () => {
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  });
}

function connectedSession(account: string | null): WalletSession {
  const snapshot = {
    phase: account ? 'connected' : 'selection-required',
    wallets: [],
    selectedKey: null,
    account,
    generation: 1,
  } as WalletSessionSnapshot;
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
  } as unknown as WalletSession;
}

async function mount(options: { account?: string | null; mode?: BankMode; session?: boolean } = {}): Promise<BankPanelMachine> {
  const operations = createDemoOperations({ funded: true });
  const panel = createBankPanel({
    operations,
    receipts: createReceiptLedger(),
    canStartFinancialAction: () => true,
    initialMode: options.mode ?? 'unshield',
  });
  void panel.open();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  const session = options.session === false ? undefined : connectedSession(options.account === undefined ? OWN : options.account);
  await act(async () => {
    root!.render(
      <PrivacyProvider operations={operations} walletSession={session} submissionUncertainty={createSubmissionUncertainty()}>
        <BankPanel panel={panel} onClose={() => {}} />
      </PrivacyProvider>,
    );
  });
  await settle();
  return panel;
}

const recipientInput = () => container!.querySelector<HTMLInputElement>('input[name="recipient"]');
const ownLine = () => container!.querySelector('[data-testid="unshield-own-wallet"]');

describe('the Unshield recipient', () => {
  it('defaults to the connected wallet, shown read-only, with no address field', async () => {
    const panel = await mount();
    expect(ownLine()?.textContent).toBe(`${COPY.bank.toYourWallet} (${shortenAddress(OWN)})`);
    expect(recipientInput()).toBeNull();
    expect(button(COPY.bank.sendToAnother)).toBeTruthy();
    expect(container!.textContent).not.toContain(COPY.bank.useMyWallet);
    expect(panel.store.getState().recipientText).toBe(OWN);
  });

  it('queues an unshield to the wallet\'s own address without typing one, and is ready again after the form clears', async () => {
    const panel = await mount();
    await type(container!.querySelector<HTMLInputElement>('input[name="amount"]')!, '1');
    expect(button(COPY.batch.add).disabled).toBe(false);
    await click(button(COPY.batch.add));
    const [intent] = panel.store.getState().batch;
    expect(intent?.kind === 'unshield' ? intent.recipient : null).toBe(OWN);
    // The machine clears the form on Add; the wallet recipient is filled again.
    expect(panel.store.getState().recipientText).toBe(OWN);
    expect(ownLine()).not.toBeNull();
    expect(recipientInput()).toBeNull();
  });

  it('reveals the Paste field and its validation for another address, and switches back', async () => {
    const panel = await mount();
    await click(button(COPY.bank.sendToAnother));
    expect(ownLine()).toBeNull();
    const input = recipientInput()!;
    expect(input.value).toBe('');
    await type(container!.querySelector<HTMLInputElement>('input[name="amount"]')!, '1');
    expect(button(COPY.bank.enterRecipient).disabled).toBe(true);

    await type(input, 'not an address');
    await blur(input);
    expect(container!.querySelector('.ui-recipient .ui-amount-message')?.textContent).toBe(COPY.notices.badRecipient);
    expect(button(COPY.bank.checkRecipient).disabled).toBe(true);

    await type(input, OTHER);
    await blur(input);
    expect(button(COPY.batch.add).disabled).toBe(false);
    await click(button(COPY.batch.add));
    const [intent] = panel.store.getState().batch;
    expect(intent?.kind === 'unshield' ? intent.recipient : null).toBe(OTHER);

    await click(button(COPY.bank.useMyWallet));
    expect(recipientInput()).toBeNull();
    expect(ownLine()?.textContent).toContain(shortenAddress(OWN));
    expect(panel.store.getState().recipientText).toBe(OWN);
  });

  it('keeps the D-024 disclosure on screen for the Unshield route', async () => {
    const panel = await mount();
    expect(panel.store.getState().disclosure).not.toBeNull();
    expect(container!.querySelector('[data-testid="disclosure"]')).not.toBeNull();
  });

  it('shows the plain Recipient field when no wallet session is connected', async () => {
    const connecting = await mount({ account: null });
    expect(ownLine()).toBeNull();
    expect(recipientInput()).not.toBeNull();
    expect(container!.textContent).not.toContain(COPY.bank.useMyWallet);
    expect(connecting.store.getState().recipientText).toBe('');
  });

  it('shows the plain Recipient field in demo, where there is no session', async () => {
    await mount({ session: false });
    expect(ownLine()).toBeNull();
    expect(recipientInput()).not.toBeNull();
  });

  it('leaves a private transfer\'s recipient alone', async () => {
    const panel = await mount({ mode: 'transfer' });
    expect(ownLine()).toBeNull();
    expect(recipientInput()).not.toBeNull();
    expect(container!.textContent).not.toContain(COPY.bank.sendToAnother);
    expect(panel.store.getState().recipientText).toBe('');
  });
});
