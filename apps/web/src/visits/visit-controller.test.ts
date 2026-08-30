import { describe, expect, it, vi } from 'vitest';
import type { ShellEvents, WorldEvents } from '@strkworld/shared';
import { createEventBus } from '../bus/event-bus.js';
import { PRIVACY_REGISTER, type RouteGrade } from '../privacy/register.js';
import { createVisitController } from './visit-controller.js';
import { resolveStation, stationSnapshot } from './station-registry.js';

describe('visit controller', () => {
  it('keeps the public visit store read-only and immutable', () => {
    const world = createEventBus<WorldEvents>();
    const shell = createEventBus<ShellEvents>();
    const controller = createVisitController(shell);

    expect('setState' in controller.store).toBe(false);
    expect(Object.isFrozen(controller.store.getState())).toBe(true);

    controller.listen(world);
    world.emit('building:entered', { building: 'bank' });
    const state = controller.store.getState();
    if (state.name !== 'visiting') throw new Error('expected an active visit');
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.surface)).toBe(true);
    expect(Reflect.set(state, 'building', 'exchange')).toBe(false);
    expect(Reflect.set(state.surface, 'name', 'menu')).toBe(false);
    expect(controller.store.getState()).toMatchObject({
      building: 'bank',
      surface: { name: 'room' },
    });
  });

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

  it('keeps Avatar Studio events outside the financial visit lifecycle', () => {
    const world = createEventBus<WorldEvents>();
    const shell = createEventBus<ShellEvents>();
    const stations = vi.fn();
    const owners = vi.fn();
    shell.on('world:stations', stations);
    shell.on('world:control-owner', owners);
    const controller = createVisitController(shell);
    controller.listen(world);
    const emitStudioVisit = () => {
      world.emit('avatar-studio:entered', {});
      world.emit('avatar:selected', { sprite: 'avatar-12' });
      world.emit('avatar-studio:exited', {});
    };

    const outside = controller.store.getState();
    emitStudioVisit();
    expect(controller.store.getState()).toBe(outside);
    expect(stations).not.toHaveBeenCalled();
    expect(owners).not.toHaveBeenCalled();

    world.emit('building:entered', { building: 'bank' });
    world.emit('station:activated', { building: 'bank', station: 'bank:shielding' });
    const financialVisit = controller.store.getState();
    const stationCalls = stations.mock.calls.length;
    const ownerCalls = owners.mock.calls.length;

    emitStudioVisit();
    expect(controller.store.getState()).toBe(financialVisit);
    expect(stations).toHaveBeenCalledTimes(stationCalls);
    expect(owners).toHaveBeenCalledTimes(ownerCalls);
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

  it('requests the active room exit and waits for the matching World acknowledgement', () => {
    const world = createEventBus<WorldEvents>();
    const shell = createEventBus<ShellEvents>();
    const exits = vi.fn();
    shell.on('world:exit-building', exits);
    const controller = createVisitController(shell);
    controller.listen(world);
    world.emit('building:entered', { building: 'bank' });

    controller.requestExit();

    expect(exits).toHaveBeenCalledOnce();
    expect(exits).toHaveBeenCalledWith({ building: 'bank' });
    expect(controller.store.getState()).toEqual({
      name: 'visiting',
      building: 'bank',
      surface: { name: 'room' },
    });

    world.emit('building:exited', { building: 'exchange' });
    expect(controller.store.getState()).toMatchObject({ name: 'visiting', building: 'bank' });

    world.emit('building:exited', { building: 'bank' });
    expect(controller.store.getState()).toEqual({ name: 'outside' });

    controller.requestExit();
    world.emit('building:exited', { building: 'bank' });
    expect(exits).toHaveBeenCalledOnce();
    expect(controller.store.getState()).toEqual({ name: 'outside' });
  });

  it('keeps a station visit and Shell control until the matching requested exit completes', () => {
    const world = createEventBus<WorldEvents>();
    const shell = createEventBus<ShellEvents>();
    const exits = vi.fn();
    const owners = vi.fn();
    shell.on('world:exit-building', exits);
    shell.on('world:control-owner', owners);
    const controller = createVisitController(shell);
    controller.listen(world);
    world.emit('building:entered', { building: 'bank' });
    world.emit('station:activated', { building: 'bank', station: 'bank:shielding' });
    const ownerCallsBeforeExit = owners.mock.calls.length;

    controller.requestExit();

    expect(exits).toHaveBeenCalledOnce();
    expect(exits).toHaveBeenCalledWith({ building: 'bank' });
    expect(controller.store.getState()).toEqual({
      name: 'visiting',
      building: 'bank',
      surface: { name: 'station', station: 'bank:shielding' },
    });
    expect(owners).toHaveBeenCalledTimes(ownerCallsBeforeExit);

    world.emit('building:exited', { building: 'exchange' });
    expect(controller.store.getState()).toMatchObject({
      name: 'visiting',
      building: 'bank',
      surface: { name: 'station' },
    });
    expect(owners).toHaveBeenCalledTimes(ownerCallsBeforeExit);

    world.emit('building:exited', { building: 'bank' });
    expect(controller.store.getState()).toEqual({ name: 'outside' });
    expect(owners).toHaveBeenCalledTimes(ownerCallsBeforeExit + 1);
    expect(owners).toHaveBeenLastCalledWith({ building: 'bank', owner: 'world' });

    world.emit('building:exited', { building: 'bank' });
    expect(owners).toHaveBeenCalledTimes(ownerCallsBeforeExit + 1);
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

  it('ignores duplicate or conflicting building-entered events during an active visit', () => {
    const world = createEventBus<WorldEvents>();
    const shell = createEventBus<ShellEvents>();
    const stations = vi.fn();
    shell.on('world:stations', stations);
    const controller = createVisitController(shell);
    controller.listen(world);
    world.emit('building:entered', { building: 'bank' });
    world.emit('station:activated', { building: 'bank', station: 'bank:shielding' });
    const activeVisit = controller.store.getState();

    // DoorTrigger emits exit before enter for a real room transition. An enter
    // delivered while already visiting is therefore stale/re-entrant and must
    // not replace the active station visit or publish a second room snapshot.
    world.emit('building:entered', { building: 'bank' });
    world.emit('building:entered', { building: 'exchange' });

    expect(controller.store.getState()).toBe(activeVisit);
    expect(stations).toHaveBeenCalledOnce();

    // A real room transition still works once World has acknowledged the exit.
    world.emit('building:exited', { building: 'bank' });
    world.emit('building:entered', { building: 'exchange' });
    expect(controller.store.getState()).toEqual({
      name: 'visiting',
      building: 'exchange',
      surface: { name: 'room' },
    });
    expect(stations).toHaveBeenCalledTimes(2);
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

  it('React-owned Escape dismisses a locked door without sending World commands', () => {
    const world = createEventBus<WorldEvents>();
    const shell = createEventBus<ShellEvents>();
    const exits = vi.fn();
    const owners = vi.fn();
    shell.on('world:exit-building', exits);
    shell.on('world:control-owner', owners);
    const controller = createVisitController(shell);
    controller.listen(world);
    world.emit('building:locked', { building: 'vault', reason: 'coming-soon' });

    controller.handleEscape();

    expect(controller.store.getState()).toEqual({ name: 'outside' });
    expect(exits).not.toHaveBeenCalled();
    expect(owners).not.toHaveBeenCalled();
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

  it('rolls back World listeners when a later listener registration fails', () => {
    const world = createEventBus<WorldEvents>();
    const originalOn = world.on;
    const stopCalls: Array<ReturnType<typeof vi.fn>> = [];
    let registrations = 0;
    const failure = new Error('world listener registration failed');
    world.on = ((event, handler) => {
      registrations += 1;
      if (registrations === 4) throw failure;
      const stop = originalOn(event, handler);
      const trackedStop = vi.fn(stop);
      if (stopCalls.length === 0) {
        trackedStop.mockImplementation(() => {
          stop();
          throw new Error('listener cleanup failed');
        });
      }
      stopCalls.push(trackedStop);
      return trackedStop;
    }) as typeof world.on;

    const controller = createVisitController(createEventBus<ShellEvents>());

    expect(() => controller.listen(world)).toThrow(failure);
    expect(stopCalls).toHaveLength(3);
    expect(stopCalls.every((stop) => stop.mock.calls.length === 1)).toBe(true);
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

  it('keeps resolved station definitions and their authority arrays immutable', () => {
    const resolved = resolveStation('post-office', 'post-office:transfer');
    expect(resolved.status).toBe('available');
    if (resolved.status !== 'available') return;
    expect(Object.isFrozen(resolved.definition)).toBe(true);
    expect(Object.isFrozen(resolved.definition.routes)).toBe(true);
    expect('modes' in resolved.definition && Object.isFrozen(resolved.definition.modes)).toBe(true);
    expect(Reflect.set(resolved.definition, 'view', 'exchange')).toBe(false);
    expect(Reflect.set(resolved.definition.routes, 0, 'exchange.swap')).toBe(false);
    expect(resolveStation('post-office', 'post-office:transfer')).toMatchObject({
      status: 'available',
      definition: { view: 'bank', routes: ['post-office.transfer'] },
    });
  });

  it('keeps published station snapshots immutable at the public seam', () => {
    const snapshot = stationSnapshot('bank');
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0])).toBe(true);
    expect(Reflect.set(snapshot[0]!, 'status', 'locked')).toBe(false);
    expect(Reflect.set(snapshot, 0, { ...snapshot[0]!, status: 'locked' })).toBe(false);
    expect(stationSnapshot('bank')[0]?.status).toBe('available');
  });

  it('publishes the Bridge station and fails closed without both runtime capabilities', () => {
    expect(stationSnapshot('bridge')).toEqual([
      { station: 'bridge:deposit', label: 'DEPOSIT', status: 'locked' },
    ]);
    expect(stationSnapshot('bridge', undefined, {
      bridgeAccountAvailable: true,
      bridgePlannerAvailable: true,
    })).toEqual([
      { station: 'bridge:deposit', label: 'DEPOSIT', status: 'available' },
    ]);
  });

  it('rechecks Bridge capability at activation instead of trusting the snapshot', () => {
    const world = createEventBus<WorldEvents>();
    const shell = createEventBus<ShellEvents>();
    const caps = { bridgeAccountAvailable: false, bridgePlannerAvailable: false };
    const controller = createVisitController(shell, undefined, () => caps);
    const stop = controller.listen(world);
    world.emit('building:entered', { building: 'bridge' });
    caps.bridgeAccountAvailable = true;
    caps.bridgePlannerAvailable = true;
    world.emit('station:activated', { building: 'bridge', station: 'bridge:deposit' });
    expect(controller.store.getState()).toMatchObject({ surface: { name: 'station', station: 'bridge:deposit' } });
    stop();
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
