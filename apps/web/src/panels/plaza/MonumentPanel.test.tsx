// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WalletRoutePolicy } from '@strkworld/privacy';
import type { ShellEvents, WorldEvents } from '@strkworld/shared';
import { createEventBus } from '../../bus/event-bus.js';
import { COPY } from '../../copy.js';
import { EXCHANGE_CATALOG } from '../exchange/catalog.js';
import { PlazaProvider } from '../../plaza/PlazaProvider.js';
import { plazaTokens, type PoolStatsSnapshot, type PoolStatsSource } from '../../plaza/pool-stats.js';
import { MonumentPanel, MonumentPanelView } from './MonumentPanel.js';

/**
 * The monument's window (D-076): the pool's public figures, "…" until they
 * arrive or when they cannot be read, and what an anonymity set is.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const [STRK, ETH, USDC] = EXCHANGE_CATALOG.map((asset) => asset.token);
const E18 = 10n ** 18n;
const STATS: PoolStatsSnapshot = {
  accounts: 2932,
  deposits24h: 23,
  held: [
    { token: STRK!, amount: 2_561_829n * E18 },
    { token: USDC!, amount: 200_355_033_845n },
    { token: ETH!, amount: 19n * E18 },
  ],
};
const RAILWAY = { enabledRoutes: ['shield'], allowedTokens: { shield: [STRK, ETH, USDC] } } as unknown as WalletRoutePolicy;

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  const owner = root;
  root = null;
  if (owner) act(() => owner.unmount());
  container?.remove();
  container = null;
});

function view(status: 'idle' | 'loading' | 'ready' | 'failed', stats: PoolStatsSnapshot | null, demo = false): string {
  return renderToStaticMarkup(
    <MonumentPanelView view={{ status, stats, demo }} tokens={plazaTokens(RAILWAY)} onClose={() => {}} />,
  );
}

/** React escapes apostrophes in markup. */
const esc = (text: string): string => text.replace(/'/g, '&#x27;');

async function settle(): Promise<void> {
  for (let round = 0; round < 3; round += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe('the monument window (D-076)', () => {
  it("shows the pool's three figures, the held tokens in this build's order", () => {
    const markup = view('ready', STATS);
    expect(markup).toContain(esc(COPY.plaza.monument.title));
    expect(markup).toContain(esc(COPY.plaza.monument.intro));
    expect(markup).toContain('data-stat="accounts">2,932<');
    expect(markup).toContain('data-stat="deposits24h">23<');
    expect(markup).toMatch(/2,561,829 STRK.*19 ETH.*200,355\.03 USDC/);
    expect(markup).not.toContain(esc(COPY.plaza.monument.failed));
    expect(markup).not.toContain(esc(COPY.plaza.monument.demo));
  });

  it('says what an anonymity set is, and that the edges are public', () => {
    const markup = view('ready', STATS);
    for (const line of COPY.plaza.monument.set) expect(markup).toContain(esc(line));
    expect(markup).toContain(esc(COPY.plaza.monument.edges));
  });

  it('shows "…" while it loads, and says so plainly when the figures cannot be read', () => {
    const loading = view('loading', null);
    expect(loading).toContain('aria-busy="true"');
    expect(loading.match(/…/g)).toHaveLength(3);
    expect(loading).not.toContain(esc(COPY.plaza.monument.failed));
    const failed = view('failed', null);
    expect(failed.match(/…/g)).toHaveLength(3);
    expect(failed).toContain(esc(COPY.plaza.monument.failed));
    // A part the backend has not counted yet is "…" on its own.
    const partial = view('ready', { ...STATS, accounts: null });
    expect(partial).toContain('data-stat="accounts">…<');
    expect(partial).toContain('data-stat="deposits24h">23<');
  });

  it('labels demo figures as demo figures', () => {
    expect(view('ready', STATS, true)).toContain(esc(COPY.plaza.monument.demo));
  });

  it('reads the figures while it is open, and hands the World the same ones', async () => {
    const world = createEventBus<WorldEvents>();
    const shell = createEventBus<ShellEvents>();
    const published: Array<ShellEvents['plaza:stats']> = [];
    shell.on('plaza:stats', (payload) => published.push(payload));
    const load = vi.fn(async () => STATS);
    const source: PoolStatsSource = { demo: false, load };
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <PlazaProvider world={world} shell={shell} source={source} policy={RAILWAY}>
          <MonumentPanel onClose={() => {}} />
        </PlazaProvider>,
      );
    });
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-stat="accounts"]')!.textContent).toBe('2,932');
    expect(published.at(-1)).toEqual({ accounts: '2,932', deposits24h: '23', held: ['2.56M STRK', '19 ETH', '200K USDC'] });
  });

  it('reads nothing until the plaza is in view, then tells the World', async () => {
    const world = createEventBus<WorldEvents>();
    const shell = createEventBus<ShellEvents>();
    const published: Array<ShellEvents['plaza:stats']> = [];
    shell.on('plaza:stats', (payload) => published.push(payload));
    const load = vi.fn(async () => STATS);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        <PlazaProvider world={world} shell={shell} source={{ demo: false, load }} policy={RAILWAY}>
          <p>city</p>
        </PlazaProvider>,
      );
    });
    await settle();
    expect(load).not.toHaveBeenCalled();
    act(() => world.emit('plaza:nearby', { near: true }));
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    expect(published.at(-1)?.accounts).toBe('2,932');
  });

  it('refuses the demo figures in a production build', () => {
    const world = createEventBus<WorldEvents>();
    const shell = createEventBus<ShellEvents>();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => renderToStaticMarkup(
      <PlazaProvider world={world} shell={shell} demo build={{ production: true }}>
        <p>city</p>
      </PlazaProvider>,
    )).toThrow(/must never ship/);
    spy.mockRestore();
  });
});
