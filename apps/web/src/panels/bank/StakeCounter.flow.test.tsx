// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { ENDUR_XSTRK, ENDUR_XSTRK_ASSET } from '@strkworld/privacy';
import { COPY } from '../../copy.js';
import { createDemoOperations } from '../../privacy/demo-operations.js';
import { PrivacyProvider } from '../../privacy/PrivacyProvider.js';
import { BankPanel } from './BankPanel.js';

/**
 * The staking station as a player drives it, against the demo seam: every
 * step below is a click or a keystroke on the rendered counter, and the
 * assertions read what is on screen.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  const owner = root;
  root = null;
  if (owner) act(() => owner.unmount());
  container?.remove();
  container = null;
});

/** Let the demo seam's promise chains settle, then React's effects. */
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

describe('the staking station, driven through the screen in demo', () => {
  it('reads the pool balance, reviews STRK in and xSTRK out, confirms without a disclosure and shows the receipt', async () => {
    const operations = createDemoOperations();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <PrivacyProvider operations={operations}>
          <BankPanel experience="station" allowedModes={['stake']} initialMode="stake" onClose={() => {}} />
        </PrivacyProvider>,
      );
    });
    await settle();

    const panel = container.querySelector('section.panel')!;
    expect(panel.getAttribute('data-building')).toBe('bank');
    expect(panel.getAttribute('data-brand')).toBe('endur');
    expect(container.querySelector('.stake-eyebrow')?.textContent).toBe(COPY.stake.eyebrow);
    expect(container.textContent).toContain(COPY.stake.intro);
    expect(container.querySelector('.stake-intro .stake-note')?.textContent).toBe(COPY.stake.unstaking);
    expect(container.querySelector('[data-testid="disclosure"]')).toBeNull();

    // Compose from the pool balance, read only because the player asked.
    await click(button(COPY.balance.refresh));
    expect(container.querySelector('.balance-total')?.textContent).toBe('250 STRK');
    await type(container.querySelector<HTMLInputElement>('input[name="amount"]')!, '5');
    expect(container.querySelector('input[name="recipient"]')).toBeNull();
    await click(button(COPY.gameMode.reviewAction));
    expect(container.querySelector('.station-action')?.textContent).toBe('Stake 5 STRK → xSTRK');

    // Review: STRK in, exact; xSTRK out, named only.
    await click(button(COPY.flow.review));
    const review = container.querySelector('.panel-review')!;
    const figures = [...review.querySelectorAll('.stake-review dd')].map((dd) => dd.textContent);
    expect(figures).toEqual(['5 STRK', 'xSTRK']);
    expect(review.textContent).toContain(COPY.stake.amountAtExecution);
    expect(review.querySelector('.stake-note')?.textContent).toBe(COPY.stake.unstaking);
    expect(review.querySelector('.commit-disclosures')).toBeNull();
    expect(review.querySelector('.confirm-blocked')).toBeNull();
    const confirm = review.querySelector<HTMLButtonElement>('button.confirm')!;
    expect(confirm.disabled).toBe(false);
    expect(panel.getAttribute('data-brand')).toBe('endur');

    // Confirm through the shared gate: one stake reaches the seam.
    await click(confirm);
    expect(operations.submitted).toEqual([[
      { kind: 'stake', tokenIn: ENDUR_XSTRK_ASSET, tokenOut: ENDUR_XSTRK, amountIn: 5n * 10n ** 18n },
    ]]);
    expect(container.querySelector('.flow-done')?.textContent).toContain(COPY.flow.submitted);
    expect(container.querySelector('.journey-next')?.textContent).toBe(COPY.next.afterStake);
    expect(container.textContent).toContain(COPY.balance.changed);

    // Back to the counter: the receipt is acknowledged and the form returns.
    await click(button(COPY.flow.back));
    expect(container.querySelector('.journey-next')).toBeNull();
    expect(container.querySelector('input[name="amount"]')).not.toBeNull();
    expect(container.textContent).toContain(COPY.stake.unstaking);
  });
});
