// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { ENDUR_XSTRK, ENDUR_XSTRK_ASSET, FakePrivacyOperations } from '@strkworld/privacy';
import { COPY } from '../../copy.js';
import { PrivacyProvider } from '../../privacy/PrivacyProvider.js';
import { PRIVACY_REGISTER } from '../../privacy/register.js';
import { VisitLayerView } from '../../visits/VisitLayer.js';

/**
 * The unstaking counter (D-085) as a player drives it, under the stake form
 * in the Bank's staking station, against the demo fake: every step is a click
 * or a keystroke on the rendered counter.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const ONE = 10n ** 18n;
const DISCLOSURE = PRIVACY_REGISTER.find((entry) => entry.route === 'bank.unstake')!.disclosure!;

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

async function render(operations: FakePrivacyOperations): Promise<HTMLElement> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <PrivacyProvider operations={operations}>
        <VisitLayerView
          state={{ name: 'visiting', building: 'bank', surface: { name: 'station', station: 'bank:unstaking' } }}
          connected
          onOpenMenu={() => {}}
          onRequestExit={() => {}}
          onCloseSurface={() => {}}
          onDismissLocked={() => {}}
        />
      </PrivacyProvider>,
    );
  });
  await settle();
  // D-103: unstaking is the UNSTAKE counter's own window, in Endur's look,
  // with no stake form and no tabs beside it.
  const panel = container.querySelector<HTMLElement>('section.panel')!;
  expect(panel.getAttribute('data-brand')).toBe('endur');
  expect(container.querySelector('[role="tablist"]')).toBeNull();
  expect(container.textContent).not.toContain(COPY.stake.intro);
  return container.querySelector<HTMLElement>('section.unstake-counter')!;
}

describe('the unstaking counter, driven through the screen in demo (D-085)', () => {
  it('reads the requests on request, shows the wait and a ready one, requests with the disclosure, and claims', async () => {
    const operations = new FakePrivacyOperations({
      balances: { [ENDUR_XSTRK_ASSET]: 30n * ONE, [ENDUR_XSTRK]: 8n * ONE },
      poolConfig: { noteMaturityBlocks: 0 },
      endur: { requests: [{ assets: 5n * ONE, shares: 4n * ONE, claimableInSeconds: 0 }] },
    });
    const counter = await render(operations);
    expect(counter.querySelector('h3')?.textContent).toBe(COPY.unstake.title);
    expect(counter.textContent).toContain(COPY.unstake.intro);
    // Nothing is read until the player asks.
    expect(counter.querySelector('.unstake-list')).toBeNull();

    await click(button(COPY.unstake.readRequests));
    const ready = counter.querySelector('.unstake-list li')!;
    expect(ready.getAttribute('data-status')).toBe('ready');
    expect(ready.textContent).toBe(`${COPY.unstake.owedLead} 5 STRK ${COPY.unstake.statusReady}`);
    expect(counter.querySelector('.vault-stand-in')?.textContent).toContain(COPY.unstake.standInTail);
    expect(counter.querySelector<HTMLAnchorElement>('.vault-stand-in a')?.rel).toBe('noopener noreferrer');

    // Request: the review names the xSTRK and shows the approved disclosure.
    await type(counter.querySelector<HTMLInputElement>('input[name="unstake-amount"]')!, '4');
    // D-091, D-103: the xSTRK sent, what comes back at the demo rate, the fee
    // on top, the total from the pool in both tokens, then the rate and the wait.
    const rows = [...counter.querySelectorAll('.unstake-compose .ui-detail')].map((row) => row.querySelector('dd')!.firstChild!.textContent);
    expect(rows).toEqual(['4 xSTRK', '≈ 5 STRK', '6 STRK', '4 xSTRK + 6 STRK', '1 xSTRK = 1.25 STRK', COPY.unstake.waitValue]);
    expect(counter.querySelector('.unstake-compose')?.textContent).toContain(COPY.unstake.wait);
    await click(button(COPY.unstake.request));
    const review = counter.querySelector('.panel-review')!;
    expect([...review.querySelectorAll('.ui-detail dd')].map((dd) => dd.textContent)).toEqual([
      '4 xSTRK', COPY.unstake.receiveLater, '6 STRK', COPY.unstake.networkByWallet, '4 xSTRK + 6 STRK',
    ]);
    expect(review.querySelector('[data-testid="commit-disclosures"]')?.textContent).toContain(DISCLOSURE);
    await click(review.querySelector<HTMLButtonElement>('button.confirm')!);
    expect(operations.endurSubmitted).toEqual([{ kind: 'request', shares: 4n * ONE, leftover: 0n }]);
    expect(counter.querySelector('.flow-done')?.textContent).toContain(COPY.unstake.submitted.succeeded);
    await click(button(COPY.flow.back));

    // A new read: the new request waits seven days, the old one is ready.
    await click(button(COPY.unstake.readRequests));
    const statuses = [...counter.querySelectorAll('.unstake-list li')].map((li) => li.getAttribute('data-status'));
    expect(statuses).toEqual(['ready', 'waiting']);
    expect(counter.querySelectorAll('.unstake-list li')[1]!.textContent).toContain(`7 days ${COPY.unstake.statusWaiting}`);

    // Claim the ready one into the pool.
    await click(button(COPY.unstake.claim));
    const claim = counter.querySelector('.panel-review')!;
    // A claim moves what Endur paid, not the pool's: only the fee leaves the pool.
    expect([...claim.querySelectorAll('.ui-detail dd')].map((dd) => dd.textContent)).toEqual([
      '5 STRK', '5 STRK', '6 STRK', COPY.unstake.networkByWallet, '6 STRK', '1',
    ]);
    expect(claim.querySelector('[data-testid="commit-disclosures"]')?.textContent).toContain(DISCLOSURE);
    await click(claim.querySelector<HTMLButtonElement>('button.confirm')!);
    expect(operations.endurSubmitted.map(({ kind }) => kind)).toEqual(['request', 'claim']);
  });

  it('labels a past-due unfunded request as waiting for Endur, with no claim', async () => {
    const operations = new FakePrivacyOperations({
      balances: { [ENDUR_XSTRK_ASSET]: 30n * ONE },
      poolConfig: { noteMaturityBlocks: 0 },
      endur: { requests: [{ assets: 5n * ONE, shares: 4n * ONE, claimableInSeconds: -60, funded: false }] },
    });
    const counter = await render(operations);
    await click(button(COPY.unstake.readRequests));
    const item = counter.querySelector('.unstake-list li')!;
    expect(item.getAttribute('data-status')).toBe('awaiting-funds');
    expect(item.textContent).toContain(COPY.unstake.statusAwaitingFunds);
    expect(counter.querySelector('.unstake-claim')).toBeNull();
  });

  it('offers no claim while nothing is ready', async () => {
    const operations = new FakePrivacyOperations({
      balances: { [ENDUR_XSTRK_ASSET]: 30n * ONE },
      poolConfig: { noteMaturityBlocks: 0 },
      endur: { requests: [{ assets: 5n * ONE, shares: 4n * ONE, claimableInSeconds: 3_600 }] },
    });
    const counter = await render(operations);
    await click(button(COPY.unstake.readRequests));
    expect(counter.querySelector('.unstake-list li')?.textContent).toContain(`1 hour ${COPY.unstake.statusWaiting}`);
    expect(counter.querySelector('.unstake-claim')).toBeNull();
    expect(counter.querySelector('.unstake-nothing-ready')?.textContent).toBe(COPY.unstake.nothingReady);
  });
});
