// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { COPY } from '../../copy.js';
import { createDemoOperations } from '../../privacy/demo-operations.js';
import { PrivacyProvider } from '../../privacy/PrivacyProvider.js';
import { VisitLayerView } from '../../visits/VisitLayer.js';
import { DegenCatalogProvider } from './DegenCatalogProvider.js';

/**
 * The degen station (D-067) as a player drives it in demo: every step is a
 * click, a choice or a keystroke on the rendered counter, and the assertions
 * read what is on screen. The list comes from the lazily loaded demo catalog
 * and the quote from the demo seam's DEMO rates.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const DOG = '0x040e81cfeb176bfdbc5047bbc55eb471cfab20a6b221f38d8fda134e1bfffca4';
const SSTR = '0x0102d5e124c51b936ee87302e0f938165aec96fb6c2027ae7f3a5ed46c77573b';

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  const owner = root;
  root = null;
  if (owner) act(() => owner.unmount());
  container?.remove();
  container = null;
});

/** Let the demo seam's and the lazy list's promise chains settle, then React's effects. */
async function settle(): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function button(label: string): HTMLButtonElement {
  const found = [...container!.querySelectorAll('button')].find((candidate) => candidate.textContent === label);
  if (!found) throw new Error(`No button labelled ${label}`);
  return found;
}

function select(label: string): HTMLSelectElement {
  const found = [...container!.querySelectorAll('label')].find((candidate) => candidate.firstChild?.textContent === label);
  const control = found?.querySelector('select');
  if (!control) throw new Error(`No select labelled ${label}`);
  return control;
}

async function click(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.click();
  });
  await settle();
}

async function choose(control: HTMLSelectElement, value: string): Promise<void> {
  const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(control, value);
    control.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  await act(async () => {
    setValue.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('the degen station, driven through the screen in demo', () => {
  it('lists the degen tokens with their tags, reviews a DOG buy and confirms it', async () => {
    const operations = createDemoOperations({ funded: true });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <PrivacyProvider operations={operations}>
          <DegenCatalogProvider demo build={{ production: false }}>
            <VisitLayerView
              state={{ name: 'visiting', building: 'exchange', surface: { name: 'station', station: 'exchange:degen' } }}
              connected
              onOpenMenu={() => {}}
              onRequestExit={() => {}}
              onCloseSurface={() => {}}
              onDismissLocked={() => {}}
            />
          </DegenCatalogProvider>
        </PrivacyProvider>,
      );
    });
    await settle();

    const window = container.querySelector('.panel')!;
    expect(window.getAttribute('data-brand')).toBe('degen');
    expect(container.textContent).toContain(COPY.degen.eyebrow);
    expect(container.textContent).toContain(COPY.degen.demo);
    const rows = [...container.querySelectorAll('.degen-token')];
    expect(rows.map((row) => row.querySelector('.degen-token-symbol')!.textContent)).toEqual([
      'STRK', 'LORDS', 'DREAMS', 'SLAY', 'BROTHER', 'tBTC', 'CASH', 'DOG', 'EKUBO', 'SSTR',
    ]);
    const sstr = rows.at(-1)!;
    expect(sstr.getAttribute('data-display-only')).toBe('true');
    expect([...sstr.querySelectorAll('.degen-chip')].map((chip) => chip.textContent))
      .toEqual(['Verified', 'Community', 'Unruggable', COPY.degen.displayOnly]);

    await click(button(COPY.balance.refresh));
    const buy = select(COPY.exchange.buy);
    expect([...buy.options].map((option) => option.value)).not.toContain(SSTR);
    await choose(buy, DOG);
    await type(container.querySelector<HTMLInputElement>('input[name="amount"]')!, '2');
    await click(button(COPY.flow.review));

    const gate = container.querySelector('.confirm-gate')!;
    expect(gate.textContent).toContain('2 STRK');
    expect(gate.textContent).toContain('2000 DOG');
    expect(gate.textContent).toContain('1990 DOG');
    expect(gate.textContent).toContain('2100-01-01T00:00:00.000Z');
    expect(gate.querySelector('.commit-disclosures')!.textContent)
      .toBe('This swap hides who traded, but not the tokens or amounts. The executor and public exchange activity are visible on-chain.');

    await click(button(COPY.flow.confirm));
    expect(container.textContent).toContain(COPY.flow.submitted);
    expect(operations.submitted).toHaveLength(1);
    expect(operations.submitted[0]![0]).toMatchObject({ kind: 'swap', tokenOut: DOG, minAmountOut: 199_000_000n });
  });
});
