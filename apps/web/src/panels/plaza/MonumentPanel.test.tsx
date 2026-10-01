// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ShellEvents, WorldEvents } from '@strkworld/shared';
import { createEventBus } from '../../bus/event-bus.js';
import { COPY } from '../../copy.js';
import { PlazaProvider } from '../../plaza/PlazaProvider.js';
import type { PoolStatsSnapshot, PoolStatsSource } from '../../plaza/pool-stats.js';
import { MonumentPanel, MonumentPanelView } from './MonumentPanel.js';

/**
 * The monument's window (D-076; USD value D-080): the pool's public figures,
 * "…" until they arrive or when they cannot be read, and what an anonymity
 * set is.
 */

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const STATS: PoolStatsSnapshot = {
  accounts: 2_932,
  valueUsd: 1_177_415.13,
  topHoldings: [
    { symbol: 'xSTRK', usd: 453_000 },
    { symbol: 'USDC', usd: 198_000 },
  ],
  valueAsOf: '2026-09-30T00:00:00.000Z',
  tokenCount: 40,
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

function view(status: 'idle' | 'loading' | 'ready' | 'failed', stats: PoolStatsSnapshot | null, demo = false): string {
  return renderToStaticMarkup(<MonumentPanelView view={{ status, stats, demo }} onClose={() => {}} />);
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

describe('the monument window (D-076, D-080)', () => {
  it("shows the pool's figures: accounts, the USD total once, and its top holdings", () => {
    const markup = view('ready', STATS);
    expect(markup).toContain(esc(COPY.plaza.monument.title));
    expect(markup).toContain(esc(COPY.plaza.monument.intro));
    expect(markup).toContain('data-stat="accounts">2,932<');
    // The compact total, with the exact figure on hover, and shown once (D-098).
    expect(markup).toContain(esc(COPY.plaza.monument.total));
    expect(markup).not.toMatch(/24 hours/i);
    expect(markup.match(/\$1\.18M/g)).toHaveLength(1);
    expect(markup).toContain('title="$1,177,415"');
    // The top holdings, most valuable first, compact.
    expect(markup).toMatch(/xSTRK \$453K[\s\S]*USDC \$198K/);
    expect(markup).toContain(esc(COPY.plaza.monument.topHoldings));
    expect(markup).toContain(esc(COPY.plaza.monument.source));
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
    expect(loading.match(/…/g)).toHaveLength(2);
    expect(loading).not.toContain(esc(COPY.plaza.monument.failed));
    // No top-holdings section at all while there is nothing to list.
    expect(loading).not.toContain(esc(COPY.plaza.monument.topHoldings));
    const failed = view('failed', null);
    expect(failed.match(/…/g)).toHaveLength(2);
    expect(failed).toContain(esc(COPY.plaza.monument.failed));
    // A part the backend has not counted yet is "…" on its own.
    const partial = view('ready', { ...STATS, accounts: null });
    expect(partial).toContain('data-stat="accounts">…<');
    expect(partial).toContain('>$1.18M<');
    // The USD total unknown, with no top holdings to show either.
    const noValue = view('ready', { ...STATS, valueUsd: null, topHoldings: null });
    expect(noValue).toContain('data-stat="total">…<');
    expect(noValue).not.toContain(esc(COPY.plaza.monument.topHoldings));
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
        <PlazaProvider world={world} shell={shell} source={source}>
          <MonumentPanel onClose={() => {}} />
        </PlazaProvider>,
      );
    });
    await settle();
    expect(load).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-stat="accounts"]')!.textContent).toBe('2,932');
    expect(published.at(-1)).toEqual({
      accounts: '2,932',
      valueUsd: '$1.18M',
      topHoldings: ['xSTRK · $453K', 'USDC · $198K'],
    });
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
        <PlazaProvider world={world} shell={shell} source={{ demo: false, load }}>
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
