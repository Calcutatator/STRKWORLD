// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakePrivacyOperations, type PublicShieldPlanner } from '@strkworld/privacy';
import type { BuildingId, ShellEvents, WorldEvents } from '@strkworld/shared';
import { createEventBus } from '../bus/event-bus.js';
import { BridgeProvider, type BridgeRuntimeLoader, type BridgeRuntimeSource } from '../bridge/BridgeProvider.js';
import { PrivacyProvider } from '../privacy/PrivacyProvider.js';
import { VisitLayer } from './VisitLayer.js';

/**
 * The production Bridge runtime loads when the player walks into the Bridge.
 *
 * Composed as `ProductionRoot` composes it: a dormant loader, the connected
 * account and the D-061 planner, and no service until the loader answers.
 * Before this, only BridgePanel's mount started the load, so the Game Mode
 * deposit station stayed locked until the player had opened Menu Mode once.
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

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function harness(loadRuntime: BridgeRuntimeLoader) {
  const world = createEventBus<WorldEvents>();
  const shell = createEventBus<ShellEvents>();
  const snapshots: ShellEvents['world:stations'][] = [];
  shell.on('world:stations', (payload) => snapshots.push(payload));
  const planner: PublicShieldPlanner = { planMax: async () => { throw new Error('not planned in this test'); } };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <PrivacyProvider operations={new FakePrivacyOperations()}>
        <BridgeProvider loadRuntime={loadRuntime} account="0xabc" readAccount={() => '0xabc'} planner={planner}>
          <VisitLayer world={world} shell={shell} />
        </BridgeProvider>
      </PrivacyProvider>,
    );
  });
  const stationsOf = (building: BuildingId) => snapshots
    .filter((snapshot) => snapshot.building === building)
    .map((snapshot) => snapshot.stations.map(({ station, status }) => `${station}:${status}`));
  return { world, bridgeStations: () => stationsOf('bridge'), bankStations: () => stationsOf('bank') };
}

describe('entering the Bridge loads its runtime', () => {
  it('loads on Bridge entry, not before, and re-publishes the deposit station as available', async () => {
    const loadRuntime = vi.fn(async () => ({ service: {} as never, loadSources: async () => [] }));
    const { world, bridgeStations } = harness(loadRuntime);
    await settle();
    expect(loadRuntime).not.toHaveBeenCalled();

    // Another building leaves the optional runtime dormant.
    await act(async () => world.emit('building:entered', { building: 'bank' }));
    await settle();
    expect(loadRuntime).not.toHaveBeenCalled();
    await act(async () => world.emit('building:exited', { building: 'bank' }));

    await act(async () => world.emit('building:entered', { building: 'bridge' }));
    await settle();
    expect(loadRuntime).toHaveBeenCalledOnce();
    // The door snapshot predates the runtime; the next one follows its arrival,
    // so the World admits the station in this same visit, with no Menu Mode.
    expect(bridgeStations()).toEqual([['bridge:deposit:locked'], ['bridge:deposit:available']]);

    // Coming back later needs no second load, and the door already knows.
    await act(async () => world.emit('building:exited', { building: 'bridge' }));
    await act(async () => world.emit('building:entered', { building: 'bridge' }));
    await settle();
    expect(loadRuntime).toHaveBeenCalledOnce();
    expect(bridgeStations().at(-1)).toEqual(['bridge:deposit:available']);
  });

  it('republishes no room when a load started at the Bridge lands after the player walked on to the Bank', async () => {
    let land = (): void => undefined;
    const loadRuntime = vi.fn(() => new Promise<BridgeRuntimeSource>((resolve) => {
      land = () => resolve({ service: {} as never, loadSources: async () => [] });
    }));
    const { world, bridgeStations, bankStations } = harness(loadRuntime);

    await act(async () => world.emit('building:entered', { building: 'bridge' }));
    await settle();
    expect(loadRuntime).toHaveBeenCalledOnce();
    await act(async () => world.emit('building:exited', { building: 'bridge' }));
    await act(async () => world.emit('building:entered', { building: 'bank' }));
    await act(async () => land());
    await settle();

    // No Bank station reads a Bridge capability, so its door snapshot stands.
    expect(bankStations()).toEqual([['bank:shielding:available', 'bank:unshielding:available', 'bank:staking:available', 'bank:unstaking:available']]);
    expect(bridgeStations()).toEqual([['bridge:deposit:locked']]);

    // The Bridge's next door snapshot reads the runtime that landed.
    await act(async () => world.emit('building:exited', { building: 'bank' }));
    await act(async () => world.emit('building:entered', { building: 'bridge' }));
    expect(bridgeStations()).toEqual([['bridge:deposit:locked'], ['bridge:deposit:available']]);
  });

  it('keeps the station locked when the optional runtime cannot load', async () => {
    const loadRuntime = vi.fn(async () => null);
    const { world, bridgeStations } = harness(loadRuntime);

    await act(async () => world.emit('building:entered', { building: 'bridge' }));
    await settle();
    expect(loadRuntime).toHaveBeenCalledOnce();
    expect(bridgeStations()).toEqual([['bridge:deposit:locked']]);
  });
});
