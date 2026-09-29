// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { FakePrivacyOperations } from '@strkworld/privacy';
import type { ShellEvents, WorldEvents } from '@strkworld/shared';
import { createEventBus } from '../bus/event-bus.js';
import { COPY } from '../copy.js';
import { PlazaProvider } from '../plaza/PlazaProvider.js';
import { PrivacyProvider } from '../privacy/PrivacyProvider.js';
import { VisitLayer } from './VisitLayer.js';

/**
 * The Privacy Plaza through the real visit layer (D-076): the World's E press
 * opens the window, the Shell owns the controls while it is open, the demo's
 * sample figures load and say so, and Escape hands everything back.
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

/**
 * Wait, inside act, until `check` holds: the demo figures arrive through a
 * dynamic import, which a loaded full run can hold up for a while.
 */
async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('The demo figures never arrived.');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
}

function harness() {
  const world = createEventBus<WorldEvents>();
  const shell = createEventBus<ShellEvents>();
  const owners: Array<ShellEvents['world:control-owner']> = [];
  const stats: Array<ShellEvents['plaza:stats']> = [];
  shell.on('world:control-owner', (payload) => owners.push(payload));
  shell.on('plaza:stats', (payload) => stats.push(payload));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <PrivacyProvider operations={new FakePrivacyOperations()}>
        <PlazaProvider world={world} shell={shell} demo policy={null}>
          <VisitLayer world={world} shell={shell} />
        </PlazaProvider>
      </PrivacyProvider>,
    );
  });
  return { world, owners, stats };
}

describe('a Privacy Plaza visit, through the visit layer (D-076)', () => {
  it('opens the monument on E, shows labelled demo figures, and closes on Escape', async () => {
    const { world, owners, stats } = harness();
    expect(container!.querySelector('.panel')).toBeNull();
    await act(async () => world.emit('station:activated', { building: 'plaza', station: 'plaza:monument' }));
    await until(() => container!.querySelector('[data-stat="accounts"]')?.textContent === '1,248');
    expect(owners).toEqual([{ building: 'plaza', owner: 'shell' }]);
    expect(container!.querySelector('.panel')?.getAttribute('data-building')).toBe('plaza');
    expect(container!.textContent).toContain(COPY.plaza.monument.title);
    expect(container!.textContent).toContain(COPY.plaza.monument.demo);
    expect(container!.querySelector('[data-stat="accounts"]')?.textContent).toBe('1,248');
    // No building controls on the street, and no wallet was asked for anything.
    expect(container!.textContent).not.toContain(COPY.gameMode.exit);
    // The monument in the World got the same figures.
    expect(stats.at(-1)?.accounts).toBe('1,248');

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(container!.querySelector('.panel')).toBeNull();
    expect(owners.at(-1)).toEqual({ building: 'plaza', owner: 'world' });
  });

  it('opens the shell game at the table', async () => {
    const { world } = harness();
    await act(async () => world.emit('station:activated', { building: 'plaza', station: 'plaza:shells' }));
    expect(container!.textContent).toContain(COPY.plaza.shells.start);
    expect(container!.textContent).toContain(COPY.plaza.shells.pool);
    expect(container!.querySelectorAll('.shell-pick')).toHaveLength(3);
  });
});
