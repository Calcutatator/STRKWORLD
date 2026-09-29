// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { FakePrivacyOperations, type PrivacyOperations } from '@strkworld/privacy';
import type { ShellEvents, WorldEvents } from '@strkworld/shared';
import { createEventBus } from '../../bus/event-bus.js';
import type { ConnectState } from '../../connect/connect-machine.js';
import { COPY } from '../../copy.js';
import { createDemoOperations } from '../../privacy/demo-operations.js';
import { PrivacyProvider, usePrivacy } from '../../privacy/PrivacyProvider.js';
import { PRIVACY_REGISTER } from '../../privacy/register.js';
import { VisitLayer } from '../../visits/VisitLayer.js';

/**
 * The Vault (D-077) as a player drives it through the real visit layer, in
 * demo: the World opens the door and the counter, and every step after that
 * is a click or a keystroke on the rendered window. The assertions read what
 * is on screen, and what reached the seam.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
const DISCLOSURE = PRIVACY_REGISTER.find((entry) => entry.route === 'vault.supply')!.disclosure!;
const CONNECTED: ConnectState = {
  name: 'connected',
  capability: { supportsStrk20: true, walletApiVersion: '0.10.4', registration: 'registered', supportsShadowAccounts: true },
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

function ConnectStateProbe() {
  return <output data-testid="connect-state">{usePrivacy().connectState.name}</output>;
}

async function openCounter(operations: PrivacyOperations) {
  const world = createEventBus<WorldEvents>();
  const shell = createEventBus<ShellEvents>();
  const stations: Array<ShellEvents['world:stations']> = [];
  shell.on('world:stations', (payload) => stations.push(payload));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <PrivacyProvider operations={operations} initialConnectState={CONNECTED} shellBus={shell}>
        <ConnectStateProbe />
        <VisitLayer world={world} shell={shell} />
      </PrivacyProvider>,
    );
  });
  await act(async () => world.emit('building:entered', { building: 'vault' }));
  await act(async () => world.emit('station:activated', { building: 'vault', station: 'vault:lending' }));
  await settle();
  return { stations };
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

async function type(value: string): Promise<void> {
  const input = container!.querySelector<HTMLInputElement>('input[name="amount"]')!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function vault(): Element {
  const panel = container!.querySelector('section.panel[data-building="vault"]');
  if (!panel) throw new Error('The Vault window is not open.');
  return panel;
}

describe('the Vault counter, driven through the screen in demo (D-077)', () => {
  it('supplies STRK and redeems it all, with the approved disclosure at every commit point', async () => {
    const operations = createDemoOperations({ funded: true });
    const { stations } = await openCounter(operations);

    // The World was told the counter is open: presentation only.
    expect(stations.at(-1)).toEqual({
      building: 'vault',
      stations: [{ station: 'vault:lending', label: 'SUPPLY / REDEEM', status: 'available' }],
    });

    // Vesu's window, what it does, and how fees work; the disclosure previewed.
    const panel = vault();
    expect(panel.querySelector('.vault-eyebrow')?.textContent).toBe(COPY.vault.eyebrow);
    expect(panel.textContent).toContain(COPY.vault.intro);
    expect(panel.querySelector('.vault-note')?.textContent).toBe(COPY.vault.feeNote);
    expect(panel.querySelector('[data-testid="disclosure"]')?.textContent).toBe(DISCLOSURE);

    // The position is read only when asked.
    expect(panel.textContent).toContain(COPY.vault.position.unrequested);
    await click(button(COPY.vault.position.show));
    expect(vault().textContent).toContain(COPY.vault.position.empty);

    // Supply 5 STRK.
    await type('5');
    await click(button(COPY.gameMode.reviewAction));
    const review = vault().querySelector('.panel-review')!;
    expect([...review.querySelectorAll('.vault-review dd')].map((dd) => dd.textContent)).toEqual(['5 STRK']);
    expect(review.textContent).toContain(COPY.vault.review.networkByWallet);
    expect([...review.querySelectorAll('.commit-disclosures li')].map((li) => li.textContent)).toEqual([DISCLOSURE]);
    // At the commit point the gate carries the disclosure; the header preview is withdrawn.
    expect(vault().querySelector('[data-testid="disclosure"]')).toBeNull();
    const confirm = review.querySelector<HTMLButtonElement>('button.confirm')!;
    expect(confirm.disabled).toBe(false);
    await click(confirm);
    expect(operations.vaultSubmitted).toEqual([{ kind: 'supply', token: STRK, amount: 5n * 10n ** 18n }]);
    expect(vault().querySelector('.flow-done')?.textContent).toContain(COPY.vault.submitted.succeeded);
    expect(vault().textContent).toContain(COPY.vault.position.changed);

    // Back at the counter, the position now shows what it holds.
    await click(button(COPY.flow.back));
    await click(button(COPY.vault.position.show));
    expect(vault().textContent).toContain(COPY.vault.position.worth);

    // Redeem everything: no amount to type, the vault's preview reviewed.
    await click(button(COPY.vault.redeem));
    const all = vault().querySelector<HTMLInputElement>('input[name="redeem-all"]')!;
    await click(all);
    expect(vault().querySelector('input[name="amount"]')).toBeNull();
    await click(button(COPY.gameMode.reviewAction));
    const redeem = vault().querySelector('.panel-review')!;
    expect(redeem.textContent).toContain(COPY.vault.review.redeemAll);
    expect(redeem.textContent).toContain(COPY.vault.review.allNote);
    expect([...redeem.querySelectorAll('.commit-disclosures li')].map((li) => li.textContent)).toEqual([
      PRIVACY_REGISTER.find((entry) => entry.route === 'vault.redeem')!.disclosure,
    ]);
    await click(redeem.querySelector<HTMLButtonElement>('button.confirm')!);
    expect(operations.vaultSubmitted.at(-1)).toMatchObject({ kind: 'redeem', all: true });
    await click(button(COPY.flow.back));
    await click(button(COPY.vault.position.show));
    expect(vault().textContent).toContain(COPY.vault.position.empty);
  });

  it('tells a wallet without shadow accounts so plainly, offers no form, and keeps the city open', async () => {
    const operations = new FakePrivacyOperations({
      balances: { [STRK]: 100n * 10n ** 18n },
      capability: { supportsShadowAccounts: false, walletApiVersion: '0.10.3' },
    });
    await openCounter(operations);
    const panel = vault();
    expect(panel.querySelector('.vault-unsupported')?.textContent).toBe(COPY.errors['shadow-accounts-unsupported']);
    expect(panel.querySelector('input[name="amount"]')).toBeNull();
    expect(panel.querySelector('button.confirm')).toBeNull();
    // A fact about the wallet's release: the connect flow never moves.
    expect(container!.querySelector('[data-testid="connect-state"]')?.textContent).toBe('connected');
    expect(operations.vaultSubmitted).toEqual([]);
  });
});
