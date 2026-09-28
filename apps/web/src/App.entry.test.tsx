// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShellEvents, WorldEvents } from '@strkworld/shared';
import { createEventBus } from './bus/event-bus.js';
import { COPY } from './copy.js';
import { createPresenceController } from './presence/presence-controller.js';
import { PRIVACY_REGISTER } from './privacy/register.js';

/**
 * D-072 in the demo composition: `App` loads its own demo seam, so it runs
 * the entry gate itself, around the city. The World and the visit layer are
 * stood in for (they need a renderer); everything else is the real tree.
 */

const demo = vi.hoisted(() => ({ funded: false, operations: null as unknown }));

vi.mock('./privacy/demo-loader.js', async () => {
  const { createDemoOperations } = await import('./privacy/demo-operations.js');
  return {
    loadDemoOperations: async () => {
      const operations = createDemoOperations({ funded: demo.funded });
      demo.operations = operations;
      return operations;
    },
  };
});
vi.mock('./world/WorldHost.js', () => ({
  WorldHost: () => <div data-testid="world-host">world</div>,
}));
vi.mock('./visits/VisitLayer.js', () => ({
  VisitLayer: () => <div data-testid="visit-layer">visits</div>,
}));

import { App } from './App.js';
import type { FakePrivacyOperations } from '@strkworld/privacy';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const SHIELD_DISCLOSURE = PRIVACY_REGISTER.find((entry) => entry.route === 'entry.shield')!.disclosure!;
const STRK = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  sessionStorage.clear();
  demo.funded = false;
  demo.operations = null;
});

afterEach(() => {
  const owner = root;
  root = null;
  if (owner) act(() => owner.unmount());
  container?.remove();
  container = null;
});

async function settle(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) {
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

async function click(target: HTMLElement): Promise<void> {
  await act(async () => {
    target.click();
  });
  await settle();
}

async function mountDemo(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <App
        worldOut={createEventBus<WorldEvents>()}
        shellIn={createEventBus<ShellEvents>()}
        presence={createPresenceController({})}
      />,
    );
  });
  await settle();
}

describe('the demo composition behind the entry gate (D-072)', () => {
  it('keeps the World, the HUD and presence out until a fresh demo player deposits their way in', async () => {
    await mountDemo();

    expect(container!.querySelector('[data-testid="entry-gate"]')?.getAttribute('data-gate')).toBe('ready');
    expect(container!.querySelector('[data-testid="world-host"]')).toBeNull();
    expect(container!.querySelector('.journey-hud')).toBeNull();
    expect(container!.textContent).not.toContain(COPY.presence.unavailable);

    await click(button(COPY.entry.action));
    expect(container!.querySelector('[data-gate="deposit"]')).not.toBeNull();

    const input = container!.querySelector<HTMLInputElement>('input[name="amount"]')!;
    const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(input, '25');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(button(COPY.entry.review));
    expect(container!.querySelector('.commit-disclosures')?.textContent).toBe(SHIELD_DISCLOSURE);
    await click(button(COPY.flow.confirm));

    expect(container!.querySelector('[data-testid="entry-gate"]')).toBeNull();
    expect(container!.querySelector('[data-testid="world-host"]')).not.toBeNull();
    expect(container!.querySelector('.journey-hud')).not.toBeNull();
    // The practice deposit is in the pool and, in the demo, spendable at once.
    const [balance] = await (demo.operations as FakePrivacyOperations).balances([STRK]);
    expect(balance).toMatchObject({ total: 25n * 10n ** 18n, spendable: 25n * 10n ** 18n });
  });

  it('lets a funded demo player straight in after the one check', async () => {
    demo.funded = true;
    await mountDemo();
    await click(button(COPY.entry.action));
    expect(container!.querySelector('[data-testid="entry-gate"]')).toBeNull();
    expect(container!.querySelector('[data-testid="world-host"]')).not.toBeNull();
    expect((demo.operations as FakePrivacyOperations).submitted).toEqual([]);
  });
});
