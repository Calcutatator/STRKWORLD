// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FakePrivacyOperations,
  WalletApiPrivacyOperations,
  type Address,
  type PoolReadClient,
  type PrivacyOperations,
  type PrivateSubmissionGateway,
  type WalletStrk20Account,
} from '@strkworld/privacy';
import type { ShellEvents, WorldEvents } from '@strkworld/shared';
import { COPY } from '../../copy.js';
import { createEventBus } from '../../bus/event-bus.js';
import type { ConnectState } from '../../connect/connect-machine.js';
import { PrivacyProvider, usePrivacy } from '../../privacy/PrivacyProvider.js';
import { PanelLayer } from '../PanelLayer.js';

/**
 * D-074: a Post Office send to a recipient the pool has never seen, driven
 * through the building overlay. The player is registered and funded, so the
 * failure is the recipient's: the Post Office stays open and says so, and the
 * connect flow never moves to `not-registered`, whose card would replace the
 * room.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const STRK: Address = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const PLAYER: Address = '0xabc';
const STRANGER: Address = '0x0111111111111111111111111111111111111111111111111111111111111111';
const FEE_RECIPIENT: Address = '0x789';
const POOL_FEE = 6n * 10n ** 18n;
const CONNECTED: ConnectState = {
  name: 'connected',
  capability: { supportsStrk20: true, walletApiVersion: '0.10.3', registration: 'registered' },
  registrationConfirmed: true,
};

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
  for (let turn = 0; turn < 3; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** The connect flow's state as the shell holds it, next to the room it decides. */
function ConnectStateProbe() {
  return <output data-testid="connect-state">{usePrivacy().connectState.name}</output>;
}

async function enterPostOffice(operations: PrivacyOperations): Promise<void> {
  const world = createEventBus<WorldEvents>();
  const shell = createEventBus<ShellEvents>();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <PrivacyProvider operations={operations} initialConnectState={CONNECTED} shellBus={shell}>
        <ConnectStateProbe />
        <PanelLayer world={world} />
      </PrivacyProvider>,
    );
  });
  await act(async () => {
    world.emit('building:entered', { building: 'post-office' });
  });
  await settle();
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

async function type(name: 'amount' | 'recipient', value: string): Promise<void> {
  const input = container!.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function composeSend(recipient: Address): Promise<void> {
  await type('amount', '1');
  await type('recipient', recipient);
  await click(button(COPY.gameMode.reviewAction));
  await click(button(COPY.flow.review));
}

function postOffice(): Element | null {
  return container!.querySelector('section.panel[data-building="post-office"]');
}

/** What the player must see: the Post Office, still open, saying whose problem it is. */
function expectRecipientFailureInPlace(): void {
  expect(postOffice()).not.toBeNull();
  expect(container!.querySelector('.flow-failed p')?.textContent).toBe(COPY.errors['recipient-not-registered']);
  expect(container!.querySelector('[data-testid="not-registered"]')).toBeNull();
  expect(container!.textContent).not.toContain(COPY.errors['not-registered']);
  expect(container!.querySelector('[data-testid="connect-state"]')?.textContent).toBe('connected');
}

function walletApiSeam() {
  const refusal = { code: 118, message: 'An error occurred (NOT_REGISTERED)' };
  const wallet: WalletStrk20Account = {
    address: PLAYER,
    strk20Balances: async (tokens) => tokens.map((token) => ({ token, balance: '0x64' })),
    // The wallet refuses to prove and submit the send with 118 although the pool
    // reads the recipient as registered: only then is the wallet asked at all
    // (D-074). Since D-082 the wallet submits a send itself.
    strk20InvokeTransaction: vi.fn(() => Promise.reject(refusal)),
    strk20PrepareInvoke: vi.fn(async () => { throw new Error('a send is not relayed'); }),
  };
  const pool: PoolReadClient = {
    config: async () => ({ feeAmount: POOL_FEE, feeToken: STRK, proofValidityBlocks: 450, noteMaturityBlocks: 10 }),
    // Both preflights pass, so the 118 can only come from the proving call.
    publicKey: async () => '0x99',
    receipt: async () => {
      throw new Error('no receipt read in this test');
    },
  };
  const gateway: PrivateSubmissionGateway = {
    estimate: vi.fn(async () => ({
      token: STRK,
      recipient: FEE_RECIPIENT,
      amount: 1n,
      authorization: 'fee-auth',
      expiresAtBlock: 1_450,
    })),
    submit: vi.fn(async () => ({ transactionHash: '0xsent' })),
  };
  const operations = new WalletApiPrivacyOperations({
    wallet,
    pool,
    supportedVersions: async () => ['0.10.3'],
    policy: {
      maxIntents: 1,
      maxRelayFee: 5n,
      enabledRoutes: ['transfer'],
      allowedTokens: { shield: [], unshield: [], transfer: [STRK], swap: [] },
    },
  });
  return { operations, wallet, gateway };
}

describe('a Post Office send to an unregistered recipient (D-074)', () => {
  it('shows the recipient line in the Post Office when the wallet answers 118 while proving', async () => {
    const { operations, wallet, gateway } = walletApiSeam();
    await enterPostOffice(operations);
    expect(postOffice()).not.toBeNull();

    await composeSend(STRANGER);
    await click(container!.querySelector<HTMLButtonElement>('button.confirm')!);

    expect(wallet.strk20InvokeTransaction).toHaveBeenCalledOnce();
    expect(wallet.strk20PrepareInvoke).not.toHaveBeenCalled();
    expect(gateway.estimate).not.toHaveBeenCalled();
    expect(gateway.submit).not.toHaveBeenCalled();
    expectRecipientFailureInPlace();

    // Back returns to the counter with the send still queued, not to a card.
    await click(button(COPY.flow.back));
    expect(postOffice()).not.toBeNull();
    expect(container!.querySelector('input[name="recipient"]')).not.toBeNull();
    expect(container!.querySelector('[data-testid="connect-state"]')?.textContent).toBe('connected');
  });

  it('shows the same line when the prepare-time pool read finds the recipient unregistered', async () => {
    const operations = new FakePrivacyOperations({ balances: { [STRK]: 100n * 10n ** 18n } });
    // The Add's preflight could not tell; the prepare's own read then says no.
    vi.spyOn(operations, 'recipientStatus').mockResolvedValue('unknown');
    await enterPostOffice(operations);

    await composeSend(STRANGER);

    expect(operations.submitted).toHaveLength(0);
    expectRecipientFailureInPlace();
  });
});

describe('a Post Office send, wallet style (D-091)', () => {
  const FRIEND: Address = '0x02b4c7d1a1f8f39e0e6e8b9a2c7d0e3f4a5b6c7d8e9f0a1b2c3d4e5f60718293';

  async function blur(name: 'amount' | 'recipient'): Promise<void> {
    const input = container!.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
    await act(async () => {
      input.focus();
      input.blur();
    });
  }

  function submit(): HTMLButtonElement {
    return container!.querySelector<HTMLButtonElement>('.panel-compose button[type="submit"]')!;
  }

  it('asks for a recipient, flags a bad address inline on blur, and shows the pool fee', async () => {
    await enterPostOffice(new FakePrivacyOperations({ balances: { [STRK]: 100n * 10n ** 18n }, registered: [FRIEND] }));
    expect(submit().textContent).toBe(COPY.bank.enterRecipient);
    expect(submit().disabled).toBe(true);
    const fee = [...container!.querySelectorAll('.panel-compose .ui-detail')].find((row) => row.textContent?.startsWith(COPY.bank.poolFee));
    expect(fee?.querySelector('dd')?.textContent).toBe('6 STRK');

    await type('recipient', 'not an address');
    // Not while typing: a half-typed address is not called wrong.
    expect(container!.querySelector('.ui-recipient .ui-amount-message')?.textContent).toBe('');
    await blur('recipient');
    expect(container!.querySelector('.ui-recipient .ui-amount-message')?.textContent).toBe(COPY.notices.badRecipient);
    expect(submit().textContent).toBe(COPY.bank.checkRecipient);
    expect(submit().disabled).toBe(true);

    await type('recipient', FRIEND);
    await blur('recipient');
    expect(container!.querySelector('.ui-recipient .ui-amount-message')?.textContent).toBe('');
    expect(submit().textContent).toBe(COPY.kit.enterAmount);
    await type('amount', '1');
    expect(submit().textContent).toBe(COPY.gameMode.reviewAction);
    expect(submit().disabled).toBe(false);
  });

  it('pastes the recipient from the clipboard when the browser offers one', async () => {
    const clipboard = { readText: vi.fn(async () => ` ${FRIEND} `) };
    Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
    try {
      await enterPostOffice(new FakePrivacyOperations({ balances: { [STRK]: 100n * 10n ** 18n }, registered: [FRIEND] }));
      const paste = [...container!.querySelectorAll('button')].find((candidate) => candidate.getAttribute('aria-label') === COPY.kit.pasteLabel)!;
      await click(paste);
      expect(clipboard.readText).toHaveBeenCalledOnce();
      expect(container!.querySelector<HTMLInputElement>('input[name="recipient"]')?.value).toBe(FRIEND);
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  });

  it('still refuses an unregistered recipient at Add with its own line (D-074)', async () => {
    const operations = new FakePrivacyOperations({ balances: { [STRK]: 100n * 10n ** 18n }, registered: [FRIEND] });
    await enterPostOffice(operations);
    await type('recipient', STRANGER);
    await type('amount', '1');
    await click(submit());
    expect(container!.querySelector('.panel-notice')?.textContent).toBe(COPY.notices.recipientUnregistered);
    expect(container!.querySelector('.batch-list')).toBeNull();
  });
});
