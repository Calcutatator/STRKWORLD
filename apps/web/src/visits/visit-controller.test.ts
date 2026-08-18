import { describe, expect, it, vi } from 'vitest';
import type { ShellEvents, WorldEvents } from '@strkworld/shared';
import { createEventBus } from '../bus/event-bus.js';
import { PRIVACY_REGISTER, type RouteGrade } from '../privacy/register.js';
import { createVisitController } from './visit-controller.js';
import { resolveStation, stationSnapshot } from './station-registry.js';

describe('visit controller', () => {
  it('starts a Bank visit in Game Mode and publishes presentation-only stations', () => {
    const world = createEventBus<WorldEvents>();
    const shell = createEventBus<ShellEvents>();
    const stations = vi.fn();
    shell.on('world:stations', stations);
    const controller = createVisitController(shell);
    controller.listen(world);

    world.emit('building:entered', { building: 'bank' });

    expect(controller.store.getState()).toEqual({
      name: 'visiting',
      building: 'bank',
      surface: { name: 'room' },
    });
    expect(stations).toHaveBeenCalledWith({
      building: 'bank',
      stations: [
        { station: 'bank:shielding', label: 'SHIELD / UNSHIELD', status: 'available' },
      ],
    });
  });

  it('opens and closes Menu Mode without ending the visit', () => {
    const world = createEventBus<WorldEvents>();
    const shell = createEventBus<ShellEvents>();
    const owners = vi.fn();
    const exits = vi.fn();
    shell.on('world:control-owner', owners);
    shell.on('world:exit-building', exits);
    const controller = createVisitController(shell);
    controller.listen(world);
    world.emit('building:entered', { building: 'bank' });

    controller.openMenu();
    expect(controller.store.getState()).toMatchObject({
      name: 'visiting',
      building: 'bank',
      surface: { name: 'menu' },
    });
    expect(owners).toHaveBeenLastCalledWith({ building: 'bank', owner: 'shell' });

    controller.closeSurface();
    expect(controller.store.getState()).toMatchObject({
      name: 'visiting',
      building: 'bank',
      surface: { name: 'room' },
    });
    expect(owners).toHaveBeenLastCalledWith({ building: 'bank', owner: 'world' });
    expect(exits).not.toHaveBeenCalled();
  });

  it('opens the admitted shielding station and gives control back on close', () => {
    const world = createEventBus<WorldEvents>();
    const shell = createEventBus<ShellEvents>();
    const owners = vi.fn();
    shell.on('world:control-owner', owners);
    const controller = createVisitController(shell);
    controller.listen(world);
    world.emit('building:entered', { building: 'bank' });

    world.emit('station:activated', { building: 'bank', station: 'bank:shielding' });
    expect(controller.store.getState()).toEqual({
      name: 'visiting',
      building: 'bank',
      surface: { name: 'station', station: 'bank:shielding' },
    });
    expect(owners).toHaveBeenLastCalledWith({ building: 'bank', owner: 'shell' });

    controller.closeSurface();
    expect(controller.store.getState()).toMatchObject({ surface: { name: 'room' } });
    expect(owners).toHaveBeenLastCalledWith({ building: 'bank', owner: 'world' });
  });

  it('hands controls to React before exposing a station window', () => {
    const world = createEventBus<WorldEvents>();
    const shell = createEventBus<ShellEvents>();
    const controller = createVisitController(shell);
    controller.listen(world);
    world.emit('building:entered', { building: 'bank' });
    const stateAtHandoff = vi.fn();
    shell.on('world:control-owner', ({ owner }) => {
      if (owner === 'shell') stateAtHandoff(controller.store.getState());
    });

    world.emit('station:activated', { building: 'bank', station: 'bank:shielding' });

    expect(stateAtHandoff).toHaveBeenCalledWith({
      name: 'visiting',
      building: 'bank',
      surface: { name: 'room' },
    });
  });

  it('fails closed on an unknown station and releases input the World suspended', () => {
    const world = createEventBus<WorldEvents>();
    const shell = createEventBus<ShellEvents>();
    const owners = vi.fn();
    shell.on('world:control-owner', owners);
    const controller = createVisitController(shell);
    controller.listen(world);
    world.emit('building:entered', { building: 'bank' });

    world.emit('station:activated', { building: 'bank', station: 'bank:not-registered' });

    expect(controller.store.getState()).toMatchObject({ surface: { name: 'room' } });
    expect(owners).toHaveBeenLastCalledWith({ building: 'bank', owner: 'world' });
  });

  it('ignores stale-building activation and exit events', () => {
    const world = createEventBus<WorldEvents>();
    const shell = createEventBus<ShellEvents>();
    const owners = vi.fn();
    shell.on('world:control-owner', owners);
    const controller = createVisitController(shell);
    controller.listen(world);
    world.emit('building:entered', { building: 'bank' });

    world.emit('station:activated', { building: 'exchange', station: 'exchange:swap' });
    world.emit('building:exited', { building: 'exchange' });

    expect(controller.store.getState()).toMatchObject({
      name: 'visiting',
      building: 'bank',
      surface: { name: 'room' },
    });
    expect(owners).not.toHaveBeenCalled();
  });

  it('only a matching building exit tears down a visit', () => {
    const world = createEventBus<WorldEvents>();
    const shell = createEventBus<ShellEvents>();
    const controller = createVisitController(shell);
    controller.listen(world);
    world.emit('building:entered', { building: 'bank' });
    controller.openMenu();

    world.emit('building:exited', { building: 'bank' });

    expect(controller.store.getState()).toEqual({ name: 'outside' });
  });

  it('returns control to the World when an exit arrives during a station window', () => {
    const world = createEventBus<WorldEvents>();
    const shell = createEventBus<ShellEvents>();
    const owners = vi.fn();
    shell.on('world:control-owner', owners);
    const controller = createVisitController(shell);
    controller.listen(world);
    world.emit('building:entered', { building: 'bank' });
    world.emit('station:activated', { building: 'bank', station: 'bank:shielding' });

    world.emit('building:exited', { building: 'bank' });

    expect(controller.store.getState()).toEqual({ name: 'outside' });
    expect(owners).toHaveBeenLastCalledWith({ building: 'bank', owner: 'world' });
  });

  it('React-owned Escape closes the current window, not the visit', () => {
    const world = createEventBus<WorldEvents>();
    const shell = createEventBus<ShellEvents>();
    const controller = createVisitController(shell);
    controller.listen(world);
    world.emit('building:entered', { building: 'bank' });
    controller.openMenu();

    controller.handleEscape();

    expect(controller.store.getState()).toMatchObject({
      name: 'visiting',
      building: 'bank',
      surface: { name: 'room' },
    });
  });

  it('cleans up every World listener so a StrictMode remount cannot duplicate them', () => {
    const world = createEventBus<WorldEvents>();
    const shell = createEventBus<ShellEvents>();
    const stations = vi.fn();
    shell.on('world:stations', stations);
    const first = createVisitController(shell);
    const stopFirst = first.listen(world);
    stopFirst();
    const second = createVisitController(shell);
    second.listen(world);

    world.emit('building:entered', { building: 'bank' });

    expect(first.store.getState()).toEqual({ name: 'outside' });
    expect(second.store.getState()).toMatchObject({ name: 'visiting', building: 'bank' });
    expect(stations).toHaveBeenCalledTimes(1);
  });

  it('releases Shell-owned controls when listener cleanup unmounts a station window', () => {
    const world = createEventBus<WorldEvents>();
    const shell = createEventBus<ShellEvents>();
    const owners = vi.fn();
    shell.on('world:control-owner', owners);
    const controller = createVisitController(shell);
    const stop = controller.listen(world);
    world.emit('building:entered', { building: 'bank' });
    world.emit('station:activated', { building: 'bank', station: 'bank:shielding' });

    stop();

    expect(owners).toHaveBeenLastCalledWith({ building: 'bank', owner: 'world' });
  });
});

describe('station registry', () => {
  it('publishes exactly one opaque single-swap Exchange station', () => {
    expect(stationSnapshot('exchange')).toEqual([
      { station: 'exchange:swap', label: 'SWAP', status: 'available' },
    ]);
    const resolved = resolveStation('exchange', 'exchange:swap');
    expect(resolved.status).toBe('available');
    if (resolved.status !== 'available') return;
    expect(resolved.definition).toEqual({
      station: 'exchange:swap',
      building: 'exchange',
      label: 'SWAP',
      routes: ['exchange.swap'],
      view: 'exchange',
    });
    expect(resolved.definition).not.toHaveProperty('modes');
  });

  it('publishes only the approved transfer station for the Post Office', () => {
    expect(stationSnapshot('post-office')).toEqual([
      { station: 'post-office:transfer', label: 'TRANSFER', status: 'available' },
    ]);
    expect(resolveStation('post-office', 'post-office:transfer')).toMatchObject({
      status: 'available',
      definition: {
        routes: ['post-office.transfer'],
        modes: ['transfer'],
        initialMode: 'transfer',
      },
    });
  });

  it('defaults unknown stations to locked', () => {
    expect(resolveStation('bank', 'bank:unknown')).toMatchObject({ status: 'locked' });
  });

  it('locks a known station when any function in it is not approved', () => {
    const unapprovedShield: RouteGrade = {
      ...PRIVACY_REGISTER.find((entry) => entry.route === 'bank.shield')!,
      disclosure: null,
      approvedBy: null,
      approvedOn: null,
      rationale: null,
    };
    const register = [
      ...PRIVACY_REGISTER.filter((entry) => entry.route !== 'bank.shield'),
      unapprovedShield,
    ];

    expect(stationSnapshot('bank', register)).toEqual([
      { station: 'bank:shielding', label: 'SHIELD / UNSHIELD', status: 'locked' },
    ]);
    expect(resolveStation('bank', 'bank:shielding', register)).toMatchObject({ status: 'locked' });
  });
});
