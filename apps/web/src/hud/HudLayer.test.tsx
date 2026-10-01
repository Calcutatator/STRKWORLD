// @vitest-environment jsdom
import { act, type ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakePrivacyOperations, type WalletSession } from '@strkworld/privacy';
import type { ShellEvents, WorldEvents } from '@strkworld/shared';
import { App } from '../App.js';
import { createEventBus } from '../bus/event-bus.js';
import { COPY } from '../copy.js';
import { createPresenceController } from '../presence/presence-controller.js';
import { PrivacyProvider } from '../privacy/PrivacyProvider.js';
import type { ConnectState } from '../connect/connect-machine.js';
import { createViewerStorage, type StorageLike } from '../store/viewer-storage.js';
import { WalletSessionProvider } from '../wallet/WalletSessionProvider.js';
import { HUD_BALANCE_HIDDEN_KEY, HUD_GUIDE_DISMISSED_KEY, HudLayer } from './HudLayer.js';

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

function memory() {
  const values = new Map<string, string>();
  const page: StorageLike = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
  };
  return { values, storage: createViewerStorage(() => page) };
}

const blocked = createViewerStorage(() => {
  throw new DOMException('The operation is insecure.', 'SecurityError');
});

function click(element: Element | null | undefined): void {
  if (!element) throw new Error('nothing to click');
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

const text = (view: HTMLElement, selector: string): string | null | undefined =>
  view.querySelector(selector)?.textContent;

describe('HudLayer', () => {
  it('shows the wallet status, the balance the Bank published and what is in flight', () => {
    const bus = createEventBus<ShellEvents>();
    const shown = memory();
    shown.values.set(HUD_BALANCE_HIDDEN_KEY, '0');
    const view = mount(<HudLayer shell={bus} storage={shown.storage} />);
    const live = view.querySelector('.journey-hud > [role="status"]');

    expect(view.querySelector('.journey-hud')?.getAttribute('aria-label')).toBe(COPY.hud.label);
    expect(text(view, '.journey-hud-wallet')).toBe(COPY.hud.wallet.unknown);
    expect(text(view, '.journey-hud-balance strong')).toBe(COPY.hud.balanceUnknown);
    expect(live?.getAttribute('aria-live')).toBe('polite');
    expect(live?.textContent).toBe(COPY.hud.pendingNone);
    expect(view.querySelector('.journey-hud-pending')).toBeNull();

    act(() => {
      bus.emit('wallet:status', { status: 'connected' });
      bus.emit('hud:balance', { display: '12.5 STRK' });
      bus.emit('hud:pending', { count: 1 });
    });
    expect(text(view, '.journey-hud-wallet')).toBe(COPY.hud.wallet.connected);
    expect(view.querySelector('.journey-hud-wallet')?.getAttribute('data-status')).toBe('connected');
    expect(text(view, '.journey-hud-balance strong')).toBe('12.5 STRK');
    expect(live?.textContent).toBe(`1 ${COPY.hud.pendingOne}`);
    // The visible chip duplicates the live region, so it is hidden from
    // assistive technology and the count is announced once.
    expect(view.querySelector('.journey-hud-pending')?.getAttribute('aria-hidden')).toBe('true');
    expect(view.querySelector('.journey-hud-spinner')).not.toBeNull();

    act(() => bus.emit('hud:pending', { count: 2 }));
    expect(live?.textContent).toBe(`2 ${COPY.hud.pendingMany}`);
    act(() => bus.emit('hud:pending', { count: 0 }));
    expect(live?.textContent).toBe(COPY.hud.pendingNone);
    expect(view.querySelector('.journey-hud-pending')).toBeNull();
    // The live region is the same node throughout, so changes are announced.
    expect(view.querySelector('.journey-hud > [role="status"]')).toBe(live);

    act(() => bus.emit('wallet:status', { status: 'disconnected' }));
    expect(text(view, '.journey-hud-wallet')).toBe(COPY.hud.wallet.disconnected);
    expect(text(view, '.journey-hud-balance strong')).toBe(COPY.hud.balanceUnknown);
  });

  describe('mounted after the provider published (D-072: behind the entry gate)', () => {
    const connected: ConnectState = {
      name: 'connected',
      capability: { supportsStrk20: true, walletApiVersion: '0.10.3', registration: 'unknown' },
      registrationConfirmed: false,
    };

    /** The provider mounts and publishes first; the HUD arrives later, as the gate lets the city in. */
    async function mountLate(initialConnectState: ConnectState | undefined): Promise<{ view: HTMLElement; published: unknown[] }> {
      const bus = createEventBus<ShellEvents>();
      const operations = new FakePrivacyOperations();
      const published: unknown[] = [];
      bus.on('wallet:status', (payload) => published.push(payload));
      const tree = (city: boolean) => (
        <PrivacyProvider operations={operations} initialConnectState={initialConnectState} shellBus={bus}>
          {city ? <HudLayer shell={bus} storage={memory().storage} /> : null}
        </PrivacyProvider>
      );
      const view = mount(tree(false));
      await act(async () => { await Promise.resolve(); });
      expect(published.length, 'the provider published before the HUD existed').toBeGreaterThan(0);
      await act(async () => { root!.render(tree(true)); });
      return { view, published };
    }

    it('shows a demo player "Wallet not connected", not "Checking wallet…"', async () => {
      const { view, published } = await mountLate(undefined);
      expect(text(view, '.journey-hud-wallet')).toBe(COPY.hud.wallet.disconnected);
      expect(text(view, '.journey-hud-wallet')).not.toBe(COPY.hud.wallet.unknown);
      // Read from the provider, not re-published on the bus.
      expect(published).toEqual([{ status: 'disconnected' }]);
    });

    it('shows a production player "Wallet connected" whatever the mount order', async () => {
      const { view } = await mountLate(connected);
      expect(text(view, '.journey-hud-wallet')).toBe(COPY.hud.wallet.connected);
    });
  });

  it('only listens: it never publishes on the bus, and mounts without the financial seam', () => {
    const bus = createEventBus<ShellEvents>();
    const emit = vi.spyOn(bus, 'emit');
    // No PrivacyProvider: the HUD cannot read a balance because it cannot
    // reach the seam at all. It renders only what the Bank chose to publish.
    const view = mount(<HudLayer shell={bus} storage={memory().storage} />);
    click(view.querySelector('.journey-hud-toggle'));
    click(view.querySelector('.journey-hud-help'));
    click(view.querySelector('.journey-hud-help'));
    expect(emit).not.toHaveBeenCalled();
  });

  it('remembers the balance toggle per viewer', () => {
    const bus = createEventBus<ShellEvents>();
    const browser = memory();
    let view = mount(<HudLayer shell={bus} storage={browser.storage} />);
    act(() => {
      bus.emit('wallet:status', { status: 'connected' });
      bus.emit('hud:balance', { display: '4 STRK' });
    });

    // Hidden by default: a balance on screen is a balance on every stream.
    const toggle = view.querySelector('.journey-hud-toggle');
    expect(text(view, '.journey-hud-balance strong')).toBe(COPY.hud.balanceHidden);
    expect(view.textContent).not.toContain('4 STRK');
    expect(toggle?.getAttribute('aria-label')).toBe(COPY.hud.showBalance);
    click(toggle);
    expect(text(view, '.journey-hud-balance strong')).toBe('4 STRK');
    expect(view.querySelector('.journey-hud-toggle')?.getAttribute('aria-label')).toBe(COPY.hud.hideBalance);
    expect(browser.values.get(HUD_BALANCE_HIDDEN_KEY)).toBe('0');

    unmount();
    view = mount(<HudLayer shell={bus} storage={browser.storage} />);
    act(() => {
      bus.emit('wallet:status', { status: 'connected' });
      bus.emit('hud:balance', { display: '4 STRK' });
    });
    expect(text(view, '.journey-hud-balance strong')).toBe('4 STRK');

    click(view.querySelector('.journey-hud-toggle'));
    expect(text(view, '.journey-hud-balance strong')).toBe(COPY.hud.balanceHidden);
    expect(browser.values.get(HUD_BALANCE_HIDDEN_KEY)).toBe('1');
  });

  it('renders and toggles correctly when storage refuses every access', () => {
    const bus = createEventBus<ShellEvents>();
    const view = mount(<HudLayer shell={bus} storage={blocked} />);
    act(() => {
      bus.emit('wallet:status', { status: 'connected' });
      bus.emit('hud:balance', { display: '7 STRK' });
    });

    // Nothing is remembered, so this is always a first run.
    expect((view.querySelector('.journey-guide') as HTMLElement).hidden).toBe(false);
    expect(text(view, '.journey-hud-balance strong')).toBe(COPY.hud.balanceHidden);
    click(view.querySelector('.journey-hud-toggle'));
    expect(text(view, '.journey-hud-balance strong')).toBe('7 STRK');
    click(view.querySelector('.journey-guide-dismiss'));
    expect((view.querySelector('.journey-guide') as HTMLElement).hidden).toBe(true);
  });

  it('opens Getting started on the first run, remembers the dismissal and reopens from ?', () => {
    const bus = createEventBus<ShellEvents>();
    const browser = memory();
    let view = mount(<HudLayer shell={bus} storage={browser.storage} />);
    let guide = view.querySelector('.journey-guide') as HTMLElement;
    let help = view.querySelector('.journey-hud-help') as HTMLButtonElement;

    expect(guide.hidden).toBe(false);
    expect(help.getAttribute('aria-label')).toBe(COPY.hud.help);
    expect(help.getAttribute('aria-expanded')).toBe('true');
    expect(help.getAttribute('aria-controls')).toBe(guide.id);
    expect(guide.getAttribute('aria-labelledby')).toBe(guide.querySelector('h2')?.id);
    // The first-run card does not pull focus away from the street.
    expect(document.activeElement).toBe(document.body);

    click(guide.querySelector('.journey-guide-dismiss'));
    expect(guide.hidden).toBe(true);
    expect(help.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(help);
    expect(browser.values.get(HUD_GUIDE_DISMISSED_KEY)).toBe('1');

    unmount();
    view = mount(<HudLayer shell={bus} storage={browser.storage} />);
    guide = view.querySelector('.journey-guide') as HTMLElement;
    help = view.querySelector('.journey-hud-help') as HTMLButtonElement;
    expect(guide.hidden).toBe(true);

    click(help);
    expect(guide.hidden).toBe(false);
    const heading = guide.querySelector('h2');
    expect(document.activeElement).toBe(heading);

    // Escape belongs to the card while focus is in it; the visit layer's
    // window listener never sees it.
    const windowKeys = vi.fn();
    window.addEventListener('keydown', windowKeys);
    act(() => {
      heading?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    window.removeEventListener('keydown', windowKeys);
    expect(guide.hidden).toBe(true);
    expect(document.activeElement).toBe(help);
    expect(windowKeys).not.toHaveBeenCalled();
  });

  it("lists the World's real bindings, and never calls the Bridge private", () => {
    const view = mount(<HudLayer shell={createEventBus<ShellEvents>()} storage={memory().storage} />);
    const guide = view.querySelector('.journey-guide') as HTMLElement;
    const inputs = [...guide.querySelectorAll('dt')].map((node) => node.textContent);
    expect(inputs).toEqual(['WASD or arrow keys', 'Shift', 'Space', 'F', 'E', 'Esc']);
    expect(guide.textContent).toContain('Menu Mode');
    expect(guide.textContent).toContain('sandbox');

    const route = [...guide.querySelectorAll('.journey-guide-route li')].map((node) => node.textContent ?? '');
    expect(route).toHaveLength(3);
    expect(route[0]).toContain('Bridge');
    expect(route[0]).toContain('public');
    expect(route[1]).toContain('Bank');
    expect(route[2]).toContain('Exchange');
    expect(route[2]).toContain('Post Office');
    for (const line of [...route, COPY.next.bridgeArrival, COPY.next.bridgeArrivalHere]) {
      if (/bridge/i.test(line)) expect(line, line).not.toMatch(/privat/i);
    }
  });

  it('mounts through App in both the demo and the production composition', () => {
    const worldOut = createEventBus<WorldEvents>();
    const shellIn = createEventBus<ShellEvents>();
    const demo = renderToStaticMarkup(
      <App
        worldOut={worldOut}
        shellIn={shellIn}
        presence={createPresenceController({})}
        operations={new FakePrivacyOperations()}
      />,
    );
    expect(demo).toContain('class="journey-hud"');
    expect(demo).toContain(COPY.guide.title);

    // ConnectedProductionApp renders App inside the WalletSessionProvider
    // with the session's own operations; the HUD rides along unchanged.
    const session = connectedSession('0x123');
    const production = renderToStaticMarkup(
      <WalletSessionProvider session={session}>
        <App
          worldOut={worldOut}
          shellIn={shellIn}
          presence={createPresenceController({})}
          operations={session.operations}
          walletSession={session}
        />
      </WalletSessionProvider>,
    );
    expect(production).toContain('class="journey-hud"');
  });
});

function connectedSession(account: string): WalletSession {
  const snapshot = {
    phase: 'connected' as const,
    wallets: [],
    selectedKey: 'wallet-1',
    account,
    generation: 1,
  };
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
