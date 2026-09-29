import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FakePrivacyOperations } from '@strkworld/privacy';
import type { ShellEvents, WorldEvents } from '@strkworld/shared';
import { PLAZA_STATIONS } from '@strkworld/world';
import { createEventBus } from '../bus/event-bus.js';
import { ownBuildingPayload, ownPlazaNearbyPayload, ownStationPayload } from '../bus/world-event-payload.js';
import { COPY } from '../copy.js';
import { PlazaProvider } from '../plaza/PlazaProvider.js';
import { PrivacyProvider } from '../privacy/PrivacyProvider.js';
import { PRIVACY_REGISTER } from '../privacy/register.js';
import { handleVisitKeyDown, VisitLayerView } from './VisitLayer.js';
import { resolveStation, stationSnapshot } from './station-registry.js';
import { createVisitController, type VisitState } from './visit-controller.js';

/**
 * The Privacy Plaza's stations in the Shell (D-076): opened with E on the
 * street, no building entered, no route and no money, and every outcome
 * hands the World its controls back.
 */

function setup() {
  const world = createEventBus<WorldEvents>();
  const shell = createEventBus<ShellEvents>();
  const owners: Array<ShellEvents['world:control-owner']> = [];
  shell.on('world:control-owner', (payload) => owners.push(payload));
  const exits = vi.fn();
  shell.on('world:exit-building', exits);
  const controller = createVisitController(shell);
  const stop = controller.listen(world);
  return { world, shell, controller, owners, exits, stop };
}

function render(state: VisitState): string {
  const world = createEventBus<WorldEvents>();
  const shell = createEventBus<ShellEvents>();
  return renderToStaticMarkup(
    <PrivacyProvider operations={new FakePrivacyOperations()}>
      <PlazaProvider world={world} shell={shell} demo>
        <VisitLayerView
          state={state}
          connected={false}
          onOpenMenu={() => {}}
          onRequestExit={() => {}}
          onCloseSurface={() => {}}
          onDismissLocked={() => {}}
        />
      </PlazaProvider>
    </PrivacyProvider>,
  );
}

describe('the plaza stations in the station registry (D-076)', () => {
  it('opens both plaza windows with no route, and nothing of the plaza is in the privacy register', () => {
    for (const station of ['plaza:monument', 'plaza:shells'] as const) {
      const resolution = resolveStation('plaza', station, PRIVACY_REGISTER, {}, null);
      expect(resolution.status, station).toBe('available');
      expect(resolution.definition?.routes).toEqual([]);
    }
    expect(PRIVACY_REGISTER.some((entry) => entry.building === 'plaza' || entry.route.startsWith('plaza'))).toBe(false);
    // Even a register with nothing approved leaves them open: there is no money here.
    expect(resolveStation('plaza', 'plaza:shells', [], {}, null).status).toBe('available');
    // An unknown plaza id is locked like any other.
    expect(resolveStation('plaza', 'plaza:casino', PRIVACY_REGISTER, {}, null).status).toBe('locked');
  });

  it("knows exactly the World's plaza stations", () => {
    expect(stationSnapshot('plaza', PRIVACY_REGISTER, {}, null).map((entry) => entry.station)).toEqual(
      PLAZA_STATIONS.map((station) => station.station),
    );
  });

  it('reads plaza stations and the plaza-in-view signal from the bus, and no plaza "building" events', () => {
    expect(ownStationPayload({ building: 'plaza', station: 'plaza:shells' })).toEqual({ building: 'plaza', station: 'plaza:shells' });
    expect(ownStationPayload({ building: 'plaza', station: 'bank:shielding' })).toBeNull();
    expect(ownBuildingPayload({ building: 'plaza' })).toBeNull();
    expect(ownPlazaNearbyPayload({ near: true })).toEqual({ near: true });
    expect(ownPlazaNearbyPayload({ near: 'yes' })).toBeNull();
    expect(ownPlazaNearbyPayload(Object.defineProperty({}, 'near', { get: () => true }))).toBeNull();
  });
});

describe('a plaza visit (D-076)', () => {
  it('opens the window from the street and claims the controls, with no building entered', () => {
    const test = setup();
    test.world.emit('station:activated', { building: 'plaza', station: 'plaza:monument' });
    expect(test.controller.store.getState()).toEqual({ name: 'plaza', station: 'plaza:monument' });
    expect(test.owners).toEqual([{ building: 'plaza', owner: 'shell' }]);
    // Closing it goes straight back outside and hands the controls back.
    test.controller.closeSurface();
    expect(test.controller.store.getState()).toEqual({ name: 'outside' });
    expect(test.owners.at(-1)).toEqual({ building: 'plaza', owner: 'world' });
    expect(test.exits).not.toHaveBeenCalled();
  });

  it('closes on Escape', () => {
    const test = setup();
    test.world.emit('station:activated', { building: 'plaza', station: 'plaza:shells' });
    const preventDefault = vi.fn();
    handleVisitKeyDown({ key: 'Escape', preventDefault }, test.controller);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(test.controller.store.getState()).toEqual({ name: 'outside' });
    expect(test.owners.at(-1)).toEqual({ building: 'plaza', owner: 'world' });
  });

  it('hands the controls straight back for an unknown plaza station', () => {
    const test = setup();
    test.world.emit('station:activated', { building: 'plaza', station: 'plaza:casino' });
    expect(test.controller.store.getState()).toEqual({ name: 'outside' });
    expect(test.owners).toEqual([{ building: 'plaza', owner: 'world' }]);
  });

  it('ignores a door while the plaza window owns the controls, and a plaza press inside a building', () => {
    const test = setup();
    test.world.emit('station:activated', { building: 'plaza', station: 'plaza:shells' });
    test.world.emit('building:entered', { building: 'bank' });
    test.world.emit('building:locked', { building: 'vault', reason: 'coming-soon' });
    expect(test.controller.store.getState()).toEqual({ name: 'plaza', station: 'plaza:shells' });
    test.controller.closeSurface();
    test.world.emit('building:entered', { building: 'bank' });
    const before = test.owners.length;
    test.world.emit('station:activated', { building: 'plaza', station: 'plaza:shells' });
    expect(test.controller.store.getState()).toMatchObject({ name: 'visiting', building: 'bank' });
    expect(test.owners.slice(before)).toEqual([{ building: 'plaza', owner: 'world' }]);
  });

  it("replaces a locked door's notice, which sits on the street too", () => {
    const test = setup();
    test.world.emit('building:locked', { building: 'vault', reason: 'coming-soon' });
    test.world.emit('station:activated', { building: 'plaza', station: 'plaza:shells' });
    expect(test.controller.store.getState()).toEqual({ name: 'plaza', station: 'plaza:shells' });
    expect(test.owners).toEqual([{ building: 'plaza', owner: 'shell' }]);
  });

  it('returns the controls if the Shell unmounts with a plaza window open', () => {
    const test = setup();
    test.world.emit('station:activated', { building: 'plaza', station: 'plaza:monument' });
    test.stop();
    expect(test.owners.at(-1)).toEqual({ building: 'plaza', owner: 'world' });
  });

  it('shows the plaza windows without Menu Mode, Leave building or a wallet', () => {
    const monument = render({ name: 'plaza', station: 'plaza:monument' });
    expect(monument).toContain(COPY.plaza.monument.title);
    expect(monument).toContain('data-building="plaza"');
    expect(monument).not.toContain(COPY.gameMode.exit);
    expect(monument).not.toContain(COPY.gameMode.menu);
    expect(monument).not.toContain(COPY.connect.title);
    const shells = render({ name: 'plaza', station: 'plaza:shells' });
    // React escapes the apostrophe in "Where's".
    expect(shells).toContain(COPY.plaza.shells.title.replace("'", '&#x27;'));
    expect(shells).toContain(COPY.plaza.shells.start);
    expect(shells).not.toContain(COPY.gameMode.exit);
    const locked = render({ name: 'plaza', station: 'plaza:casino' as never });
    expect(locked).toContain('room-locked');
  });
});
