// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { QuoteResponse } from '@defuse-protocol/one-click-sdk-typescript';
import { LocalBridgeStore, type BridgeRecord } from '@strkworld/bridge';
import { FakePrivacyOperations, type WalletSession } from '@strkworld/privacy';
import type { ShellEvents, WorldEvents } from '@strkworld/shared';
import { createEventBus } from '../bus/event-bus.js';
import { COPY } from '../copy.js';
import { HudLayer } from '../hud/HudLayer.js';
import { BankJourneyNotice } from '../panels/JourneyNotice.js';
import { PRIVACY_REGISTER, type RouteGrade } from '../privacy/register.js';
import { createViewerStorage, type StorageLike } from '../store/viewer-storage.js';
import { WalletSessionProvider } from '../wallet/WalletSessionProvider.js';
import { ArrivalNudgeProvider, useArrivalNudge } from './ArrivalNudgeProvider.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;
let container: HTMLElement | null = null;

function mount(element: ReactElement): HTMLElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  const owner = createRoot(container);
  root = owner;
  act(() => owner.render(element));
  return container;
}

function unmount(): void {
  const owner = root;
  root = null;
  if (owner) act(() => owner.unmount());
  container?.remove();
  container = null;
}

afterEach(unmount);

function settled(depositAddress = '0xdeposit-one'): BridgeRecord {
  return {
    v: 1,
    createdAt: 1_000,
    updatedAt: 1_001,
    source: { assetId: 'nep141:arb-usdc.omft.near', symbol: 'USDC', chainName: 'arbitrum', decimals: 6, depositMode: 'manual' },
    amountIn: 1_000_000n,
    starknetRecipient: '0x123',
    refundAddress: '0x1111111111111111111111111111111111111111',
    signedQuote: {
      correlationId: 'corr',
      timestamp: '2026-08-18T00:00:00.000Z',
      signature: 'sig',
      quoteRequest: { recipient: '0x123', deadline: '2030-08-18T00:30:00.000Z', slippageTolerance: 100 },
      quote: { depositAddress, deadline: '2030-08-18T00:30:00.000Z' },
    } as unknown as QuoteResponse,
    status: {
      leg: 'settled',
      settlementTxHash: '0xsettled',
      strkReceived: 5_000_000_000_000_000_000n,
      message: 'STRK arrived.',
      pollingStopped: true,
    },
  };
}

function page() {
  const values = new Map<string, string>();
  const storage: StorageLike = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
  return { bridge: new LocalBridgeStore(storage), viewer: createViewerStorage(() => storage) };
}

function Probe() {
  const nudge = useArrivalNudge();
  return <output data-waiting={nudge ? String(nudge.waiting) : 'none'} />;
}

const waiting = (view: HTMLElement): string | null | undefined =>
  view.querySelector('output')?.getAttribute('data-waiting');

describe('ArrivalNudgeProvider', () => {
  it('is absent outside the provider, so a bare window shows no nudge', () => {
    expect(waiting(mount(<Probe />))).toBe('none');
  });

  it('re-reads the saved record on the moments it can change, never on a timer', () => {
    const browser = page();
    const world = createEventBus<WorldEvents>();
    const view = mount(
      <ArrivalNudgeProvider world={world} storage={browser.viewer}>
        <Probe />
      </ArrivalNudgeProvider>,
    );
    expect(waiting(view)).toBe('false');

    // The Bridge window saves a settled status while the player is inside it.
    browser.bridge.save(settled());
    expect(waiting(view)).toBe('false');
    act(() => world.emit('building:exited', { building: 'bridge' }));
    expect(waiting(view)).toBe('true');

    // Another tab discards the record.
    browser.bridge.clear();
    act(() => {
      window.dispatchEvent(new StorageEvent('storage'));
    });
    expect(waiting(view)).toBe('false');

    browser.bridge.save(settled('0xdeposit-two'));
    act(() => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(waiting(view)).toBe('true');
  });

  it("follows the register's D-021 hook and the shield door it points at", () => {
    const withoutReturn: readonly RouteGrade[] = PRIVACY_REGISTER.map((entry) =>
      entry.route === 'bridge.deposit' ? { ...entry, returnToPool: false } : entry,
    );
    const shieldLocked: readonly RouteGrade[] = PRIVACY_REGISTER.map((entry) =>
      entry.route === 'bank.shield' ? { ...entry, approvedBy: null, approvedOn: null } : entry,
    );
    for (const register of [withoutReturn, shieldLocked]) {
      const browser = page();
      browser.bridge.save(settled());
      const view = mount(
        <ArrivalNudgeProvider world={createEventBus<WorldEvents>()} storage={browser.viewer} register={register}>
          <Probe />
        </ArrivalNudgeProvider>,
      );
      expect(waiting(view)).toBe('false');
      unmount();
    }
  });

  it("binds to the production wallet session's account", () => {
    for (const [account, expected] of [['0x0123', 'true'], ['0x456', 'false']] as const) {
      const browser = page();
      browser.bridge.save(settled());
      const view = mount(
        <WalletSessionProvider session={connectedSession(account)}>
          <ArrivalNudgeProvider world={createEventBus<WorldEvents>()} storage={browser.viewer}>
            <Probe />
          </ArrivalNudgeProvider>
        </WalletSessionProvider>,
      );
      expect(waiting(view), account).toBe(expected);
      unmount();
    }
  });

  it('shares one dismissal between the HUD and the Bank window', () => {
    const browser = page();
    browser.bridge.save(settled());
    const view = mount(
      <ArrivalNudgeProvider world={createEventBus<WorldEvents>()} storage={browser.viewer}>
        <HudLayer shell={createEventBus<ShellEvents>()} storage={page().viewer} />
        <div data-window="bank">
          <BankJourneyNotice building="bank" flow={{ name: 'composing' }} />
        </div>
        <div data-window="post-office">
          <BankJourneyNotice building="post-office" flow={{ name: 'composing' }} />
        </div>
      </ArrivalNudgeProvider>,
    );

    expect(view.querySelector('.journey-hud-nudge p')?.textContent).toBe(COPY.next.bridgeArrival);
    expect(view.querySelector('[data-window="bank"] .journey-arrival p')?.textContent).toBe(COPY.next.bridgeArrivalHere);
    // The Post Office cannot shield, so it carries no shield nudge.
    expect(view.querySelector('[data-window="post-office"]')?.textContent).toBe('');

    act(() => {
      view.querySelector('.journey-hud-nudge button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(view.querySelector('.journey-hud-nudge')).toBeNull();
    expect(view.querySelector('.journey-arrival')).toBeNull();
  });

  it('keeps the commit point clear of the nudge', () => {
    const browser = page();
    browser.bridge.save(settled());
    const summary = {} as never;
    for (const flow of [
      { name: 'preparing' },
      { name: 'review', summary },
      { name: 'submitting', stage: 'proving', message: 'proving', summary },
    ] as const) {
      const view = mount(
        <ArrivalNudgeProvider world={createEventBus<WorldEvents>()} storage={browser.viewer}>
          <BankJourneyNotice building="bank" flow={flow} />
        </ArrivalNudgeProvider>,
      );
      expect(view.querySelector('.journey-arrival'), flow.name).toBeNull();
      unmount();
    }
  });
});

function connectedSession(account: string): WalletSession {
  const snapshot = { phase: 'connected' as const, wallets: [], selectedKey: 'wallet-1', account, generation: 1 };
  return {
    operations: new FakePrivacyOperations(),
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    connect: async () => snapshot,
    refreshDiscovery: () => undefined,
    readAccount: () => account,
    disconnect: async () => undefined,
    destroy: () => undefined,
  };
}
