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
import { HUD_GUIDE_DISMISSED_KEY, HudLayer } from './HudLayer.js';

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

const pillLabel = (view: HTMLElement): string | null | undefined => text(view, '.journey-hud-pill .journey-hud-label');
const pill = (view: HTMLElement): HTMLButtonElement => view.querySelector('.journey-hud-pill') as HTMLButtonElement;
const menu = (view: HTMLElement): HTMLElement => view.querySelector('.journey-hud-menu') as HTMLElement;
const item = (view: HTMLElement, action: 'help' | 'disconnect'): HTMLButtonElement | null =>
  view.querySelector(`.journey-hud-menu-item[data-action="${action}"]`);

function key(target: EventTarget, name: string, code = name): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: name, code, bubbles: true, cancelable: true });
  act(() => {
    target.dispatchEvent(event);
  });
  return event;
}

describe('HudLayer', () => {
  it('is one quiet wallet pill: the lamp, one word, and what is in flight', () => {
    const bus = createEventBus<ShellEvents>();
    const view = mount(<HudLayer shell={bus} storage={memory().storage} />);
    const live = view.querySelector('.journey-hud > [role="status"]');

    expect(view.querySelector('.journey-hud')?.getAttribute('aria-label')).toBe(COPY.hud.label);
    expect(pillLabel(view)).toBe(COPY.hud.wallet.unknown);
    expect(pill(view).querySelector('.journey-hud-lamp')?.getAttribute('aria-hidden')).toBe('true');
    expect(live?.getAttribute('aria-live')).toBe('polite');
    expect(live?.textContent).toBe(COPY.hud.pendingNone);
    expect(view.querySelector('.journey-hud-pending')).toBeNull();

    act(() => {
      bus.emit('wallet:status', { status: 'connected' });
      bus.emit('hud:pending', { count: 1 });
    });
    expect(pillLabel(view)).toBe('Connected');
    expect(view.querySelector('.journey-hud-wallet')?.getAttribute('data-status')).toBe('connected');
    expect(pill(view).getAttribute('aria-label')).toBe(`Connected. ${COPY.hud.menuLabel}`);
    expect(live?.textContent).toBe(`1 ${COPY.hud.pendingOne}`);
    // The visible chip duplicates the live region, so it is hidden from
    // assistive technology and the count is announced once.
    expect(view.querySelector('.journey-hud-pill .journey-hud-pending')?.getAttribute('aria-hidden')).toBe('true');
    expect(view.querySelector('.journey-hud-spinner')).not.toBeNull();

    act(() => bus.emit('hud:pending', { count: 2 }));
    expect(live?.textContent).toBe(`2 ${COPY.hud.pendingMany}`);
    act(() => bus.emit('hud:pending', { count: 0 }));
    expect(live?.textContent).toBe(COPY.hud.pendingNone);
    expect(view.querySelector('.journey-hud-pending')).toBeNull();
    // The live region is the same node throughout, so changes are announced.
    expect(view.querySelector('.journey-hud > [role="status"]')).toBe(live);

    act(() => bus.emit('wallet:status', { status: 'disconnected' }));
    expect(pillLabel(view)).toBe(COPY.hud.wallet.disconnected);
  });

  it('D-120: shows no balance row, no Hide toggle and no ? button, whatever the Bank publishes', () => {
    const bus = createEventBus<ShellEvents>();
    const view = mount(<HudLayer shell={bus} storage={memory().storage} onSignOut={async () => undefined} />);
    act(() => {
      bus.emit('wallet:status', { status: 'connected' });
      bus.emit('hud:balance', { display: '12.5 STRK' });
    });
    click(pill(view));
    expect(view.querySelector('.journey-hud-balance')).toBeNull();
    expect(view.querySelector('.journey-hud-toggle')).toBeNull();
    expect(view.querySelector('.journey-hud-help')).toBeNull();
    expect(view.textContent).not.toContain('12.5 STRK');
    expect(view.textContent).not.toContain('Shielded balance');
    expect(view.textContent).not.toContain('Check at the Bank');
    const labels = [...view.querySelectorAll('button')].map((button) => button.textContent);
    expect(labels).not.toContain('Hide');
    expect(labels).not.toContain('?');
  });

  it('opens and closes its menu from the pill; Escape closes it and goes no further', () => {
    const bus = createEventBus<ShellEvents>();
    const view = mount(<HudLayer shell={bus} storage={memory().storage} onSignOut={async () => undefined} />);
    act(() => bus.emit('wallet:status', { status: 'connected' }));

    expect(menu(view).hidden).toBe(true);
    expect(pill(view).getAttribute('aria-expanded')).toBe('false');
    expect(pill(view).getAttribute('aria-controls')).toBe(menu(view).id);

    click(pill(view));
    expect(menu(view).hidden).toBe(false);
    expect(pill(view).getAttribute('aria-expanded')).toBe('true');
    expect([...menu(view).querySelectorAll('button')].map((button) => button.textContent))
      .toEqual([COPY.hud.help, 'Disconnect & return to menu']);

    click(pill(view));
    expect(menu(view).hidden).toBe(true);

    // Escape, from wherever focus is: the visit layer's window listener never
    // hears it, so an open counter does not also close.
    click(pill(view));
    const windowKeys = vi.fn();
    window.addEventListener('keydown', windowKeys);
    const escape = key(document.body, 'Escape');
    window.removeEventListener('keydown', windowKeys);
    expect(menu(view).hidden).toBe(true);
    expect(escape.defaultPrevented).toBe(true);
    expect(windowKeys).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(pill(view));

    // A press outside closes it too.
    click(pill(view));
    act(() => {
      document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(menu(view).hidden).toBe(true);
  });

  it('takes no keys while closed, and only Escape while open: E and movement stay the World\'s', () => {
    const bus = createEventBus<ShellEvents>();
    const view = mount(<HudLayer shell={bus} storage={memory().storage} onSignOut={async () => undefined} />);
    const heard: string[] = [];
    const listener = (event: KeyboardEvent) => heard.push(event.code);
    window.addEventListener('keydown', listener);
    try {
      for (const [name, code] of [['e', 'KeyE'], ['w', 'KeyW'], [' ', 'Space'], ['ArrowUp', 'ArrowUp']] as const) {
        expect(key(document.body, name, code).defaultPrevented, code).toBe(false);
      }
      const escapeClosed = key(document.body, 'Escape');
      expect(escapeClosed.defaultPrevented).toBe(false);
      expect(heard).toEqual(['KeyE', 'KeyW', 'Space', 'ArrowUp', 'Escape']);

      click(pill(view));
      heard.length = 0;
      expect(key(document.body, 'e', 'KeyE').defaultPrevented).toBe(false);
      expect(key(document.body, 'w', 'KeyW').defaultPrevented).toBe(false);
      expect(heard).toEqual(['KeyE', 'KeyW']);
      expect(menu(view).hidden).toBe(false);
    } finally {
      window.removeEventListener('keydown', listener);
    }
  });

  it('signs out from the menu, once, only where the composition offers it', async () => {
    const bus = createEventBus<ShellEvents>();
    let finish!: () => void;
    const onSignOut = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const view = mount(<HudLayer shell={bus} storage={memory().storage} onSignOut={onSignOut} />);
    act(() => bus.emit('wallet:status', { status: 'connected' }));

    click(pill(view));
    click(item(view, 'disconnect'));
    expect(onSignOut).toHaveBeenCalledOnce();
    expect(menu(view).hidden).toBe(true);
    expect(pillLabel(view)).toBe(COPY.hud.disconnecting);
    expect(item(view, 'disconnect')?.disabled).toBe(true);
    click(item(view, 'disconnect'));
    expect(onSignOut).toHaveBeenCalledOnce();
    await act(async () => {
      finish();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(pillLabel(view)).toBe('Connected');

    // The demo has no title screen to return to: Help alone.
    unmount();
    const demo = mount(<HudLayer shell={bus} storage={memory().storage} />);
    click(pill(demo));
    expect(item(demo, 'disconnect')).toBeNull();
    expect(item(demo, 'help')).not.toBeNull();
  });

  it('swallows a sign-out that throws or rejects: the session has already forgotten the account', async () => {
    const bus = createEventBus<ShellEvents>();
    const throwing = vi.fn(() => { throw new Error('gone'); });
    let view = mount(<HudLayer shell={bus} storage={memory().storage} onSignOut={throwing} />);
    click(pill(view));
    expect(() => click(item(view, 'disconnect'))).not.toThrow();
    expect(throwing).toHaveBeenCalledOnce();
    unmount();

    const rejecting = vi.fn(async () => { throw new Error('wallet said no'); });
    view = mount(<HudLayer shell={bus} storage={memory().storage} onSignOut={rejecting} />);
    click(pill(view));
    click(item(view, 'disconnect'));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(rejecting).toHaveBeenCalledOnce();
  });

  it('names the connected account inside the menu only, never on the pill', () => {
    const bus = createEventBus<ShellEvents>();
    const account = '0x07ea2000000000000000000000000000000000000000000000000000000009731';
    const view = mount(
      <WalletSessionProvider session={connectedSession(account)}>
        <HudLayer shell={bus} storage={memory().storage} onSignOut={async () => undefined} />
      </WalletSessionProvider>,
    );
    act(() => bus.emit('wallet:status', { status: 'connected' }));
    expect(pill(view).textContent).not.toContain('0x');
    expect(text(view, '.journey-hud-account')).toBe('0x07ea…09731');
    act(() => bus.emit('wallet:status', { status: 'disconnected' }));
    expect(view.querySelector('.journey-hud-account')).toBeNull();
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
      expect(pillLabel(view)).toBe(COPY.hud.wallet.disconnected);
      expect(pillLabel(view)).not.toBe(COPY.hud.wallet.unknown);
      // Read from the provider, not re-published on the bus.
      expect(published).toEqual([{ status: 'disconnected' }]);
    });

    it('shows a production player "Connected" whatever the mount order', async () => {
      const { view } = await mountLate(connected);
      expect(pillLabel(view)).toBe(COPY.hud.wallet.connected);
    });
  });

  it('only listens: it never publishes on the bus, and mounts without the financial seam', async () => {
    const bus = createEventBus<ShellEvents>();
    const emit = vi.spyOn(bus, 'emit');
    // No PrivacyProvider: the HUD cannot read a balance because it cannot
    // reach the seam at all.
    const view = mount(<HudLayer shell={bus} storage={memory().storage} onSignOut={async () => undefined} />);
    click(pill(view));
    click(item(view, 'help'));
    click(pill(view));
    click(item(view, 'disconnect'));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(emit).not.toHaveBeenCalled();
  });

  it('renders and opens Help correctly when storage refuses every access', () => {
    const bus = createEventBus<ShellEvents>();
    const view = mount(<HudLayer shell={bus} storage={blocked} />);
    act(() => bus.emit('wallet:status', { status: 'connected' }));

    // Nothing is remembered, so this is always a first run.
    expect((view.querySelector('.journey-guide') as HTMLElement).hidden).toBe(false);
    expect(pillLabel(view)).toBe('Connected');
    click(view.querySelector('.journey-guide-dismiss'));
    expect((view.querySelector('.journey-guide') as HTMLElement).hidden).toBe(true);
    click(pill(view));
    click(item(view, 'help'));
    expect((view.querySelector('.journey-guide') as HTMLElement).hidden).toBe(false);
  });

  it('opens Getting started on the first run, remembers the dismissal and reopens from Help in the wallet menu', () => {
    const bus = createEventBus<ShellEvents>();
    const browser = memory();
    let view = mount(<HudLayer shell={bus} storage={browser.storage} />);
    let guide = view.querySelector('.journey-guide') as HTMLElement;

    expect(guide.hidden).toBe(false);
    expect(guide.getAttribute('aria-labelledby')).toBe(guide.querySelector('h2')?.id);
    // The first-run card does not pull focus away from the street.
    expect(document.activeElement).toBe(document.body);

    click(guide.querySelector('.journey-guide-dismiss'));
    expect(guide.hidden).toBe(true);
    expect(document.activeElement).toBe(pill(view));
    expect(browser.values.get(HUD_GUIDE_DISMISSED_KEY)).toBe('1');

    unmount();
    view = mount(<HudLayer shell={bus} storage={browser.storage} />);
    guide = view.querySelector('.journey-guide') as HTMLElement;
    expect(guide.hidden).toBe(true);

    click(pill(view));
    const help = item(view, 'help')!;
    expect(help.textContent).toBe(COPY.hud.help);
    expect(help.getAttribute('aria-controls')).toBe(guide.id);
    expect(help.getAttribute('aria-expanded')).toBe('false');
    click(help);
    expect(guide.hidden).toBe(false);
    // Choosing Help closes the menu.
    expect(menu(view).hidden).toBe(true);
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
    expect(document.activeElement).toBe(pill(view));
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
    expect(demo).toContain('class="journey-hud-pill"');
    expect(demo).toContain(COPY.guide.title);
    expect(demo).toContain(COPY.hud.help);
    // The demo has no title screen to return to.
    expect(demo).not.toContain('data-action="disconnect"');

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
          onSignOut={async () => undefined}
        />
      </WalletSessionProvider>,
    );
    expect(production).toContain('class="journey-hud"');
    expect(production).toContain('data-action="disconnect"');
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
