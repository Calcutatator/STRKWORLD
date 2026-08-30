// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FakePrivacyOperations } from '@strkworld/privacy';
import type { BuildingId, ShellEvents, WorldEvents } from '@strkworld/shared';
import { COPY } from '../copy.js';
import { PrivacyProvider } from '../privacy/PrivacyProvider.js';
import { createEventBus } from '../bus/event-bus.js';
import { ActiveRoomView, nextActiveRoom, PanelLayer, type ActiveRoom } from './PanelLayer.js';
import { BUILDING_PANELS } from './registry.js';

const entered = (building: BuildingId) =>
  ({ name: 'building:entered', payload: { building } }) as const;
const locked = (building: BuildingId) =>
  ({ name: 'building:locked', payload: { building, reason: 'coming-soon' } }) as const;
const exited = (building: BuildingId) =>
  ({ name: 'building:exited', payload: { building } }) as const;

describe('nextActiveRoom', () => {
  it('ignores non-record World payloads without escaping the reducer boundary', () => {
    const current: ActiveRoom = { source: 'entered', building: 'bank' };
    const malformed = [
      { name: 'building:entered', payload: null },
      { name: 'building:locked', payload: null },
      { name: 'building:exited', payload: null },
    ] as Array<{ name: string; payload: null }>;

    for (const event of malformed) {
      expect(() => nextActiveRoom(current, event as never)).not.toThrow();
      expect(nextActiveRoom(current, event as never)).toBe(current);
    }
  });

  it('opens the entered building', () => {
    expect(nextActiveRoom(null, entered('bank'))).toEqual({ source: 'entered', building: 'bank' });
  });

  it('opens the locked surface for a locked door, carrying the reason', () => {
    expect(nextActiveRoom(null, locked('vault'))).toEqual({
      source: 'locked',
      building: 'vault',
      reason: 'coming-soon',
    });
  });

  it('closes on exiting the building the player is actually in', () => {
    const current: ActiveRoom = { source: 'entered', building: 'bank' };
    expect(nextActiveRoom(current, exited('bank'))).toBeNull();
  });

  it('ignores an exit for a building the player is not in', () => {
    // The world emits exit only for the entered door, but a stale one must not
    // tear down the room now on screen.
    const current: ActiveRoom = { source: 'entered', building: 'bank' };
    expect(nextActiveRoom(current, exited('exchange'))).toBe(current);
  });

  it('replaces one door with the next', () => {
    const atBank: ActiveRoom = { source: 'entered', building: 'bank' };
    expect(nextActiveRoom(atBank, locked('vault'))).toEqual({
      source: 'locked',
      building: 'vault',
      reason: 'coming-soon',
    });
  });

  it('an exit with nothing open stays closed', () => {
    expect(nextActiveRoom(null, exited('bank'))).toBeNull();
  });
});

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(<PrivacyProvider operations={new FakePrivacyOperations()}>{node}</PrivacyProvider>);
}

describe('ActiveRoomView', () => {
  it('renders the locked surface for a world-locked door', () => {
    const markup = renderToStaticMarkup(
      <ActiveRoomView
        active={{ source: 'locked', building: 'vault', reason: 'coming-soon' }}
        panels={BUILDING_PANELS}
        connected
        onClose={() => {}}
      />,
    );
    expect(markup).toContain(COPY.buildings.vault);
    expect(markup).toContain(COPY.locked.comingSoon);
    expect(markup).toContain('data-lock-reason="coming-soon"');
  });

  it('locks the Vault even when the world reports it as entered', () => {
    // Defence in depth: the world saying a door opened does not overrule the
    // register saying the building has no graded route (D-020).
    const markup = renderToStaticMarkup(
      <ActiveRoomView
        active={{ source: 'entered', building: 'vault' }}
        panels={BUILDING_PANELS}
        connected
        onClose={() => {}}
      />,
    );
    expect(markup).toContain(COPY.locked.comingSoon);
  });

  it('renders the built Exchange surface for an approved building', () => {
    const markup = render(
      <ActiveRoomView
        active={{ source: 'entered', building: 'exchange' }}
        panels={BUILDING_PANELS}
        connected
        onClose={() => {}}
      />,
    );
    expect(markup).toContain(COPY.buildings.exchange);
    expect(markup).toContain(COPY.balance.unrequested);
  });

  it('gates a functional room behind the connect flow when the wallet is not connected', () => {
    const markup = render(
      <ActiveRoomView
        active={{ source: 'entered', building: 'bank' }}
        panels={BUILDING_PANELS}
        connected={false}
        onClose={() => {}}
      />,
    );
    expect(markup).toContain(COPY.connect.title);
    expect(markup).toContain(COPY.connect.action);
  });

  it('renders the Bank once the wallet is connected', () => {
    const markup = render(
      <ActiveRoomView
        active={{ source: 'entered', building: 'bank' }}
        panels={BUILDING_PANELS}
        connected
        onClose={() => {}}
      />,
    );
    expect(markup).toContain(COPY.bank.title);
    // The connect screen is gone — this is the room itself.
    expect(markup).not.toContain(COPY.connect.action);
  });

  it('renders nothing chain-touching in the locked or unbuilt surfaces', () => {
    // These branches never construct a panel, so they must not need the seam —
    // they render for a player who has not connected anything.
    const spy = vi.fn();
    expect(() =>
      renderToStaticMarkup(
        <ActiveRoomView
          active={{ source: 'locked', building: 'vault', reason: 'coming-soon' }}
          panels={BUILDING_PANELS}
          connected={false}
          onClose={spy}
        />,
      ),
    ).not.toThrow();
  });
});

describe('PanelLayer lifecycle', () => {
  it('does not let a late callback from a replaced World bus reopen a stale room', () => {
    const firstWorld = createEventBus<WorldEvents>();
    const secondWorld = createEventBus<WorldEvents>();
    let staleEntered!: (payload: WorldEvents['building:entered']) => void;
    const originalOn = firstWorld.on;
    firstWorld.on = (<K extends keyof WorldEvents>(event: K, handler: (payload: WorldEvents[K]) => void) => {
      if (event === 'building:entered') staleEntered = handler as (payload: WorldEvents['building:entered']) => void;
      return originalOn(event, handler);
    }) as typeof firstWorld.on;
    const shell = createEventBus<ShellEvents>();
    const panels = {
      bank: { building: 'bank' as const, title: 'Bank', Component: () => <p data-room="bank">bank</p> },
      exchange: { building: 'exchange' as const, title: 'Exchange', Component: () => <p data-room="exchange">exchange</p> },
    };
    const container = document.createElement('div');
    const root = createRoot(container);
    const renderLayer = (world: typeof firstWorld) => (
      <PrivacyProvider
        operations={new FakePrivacyOperations()}
        initialConnectState={{ name: 'connected', capability: { supportsStrk20: true, walletApiVersion: '1', registration: 'registered' }, registrationConfirmed: true }}
        shellBus={shell}
      >
        <PanelLayer world={world} panels={panels} />
      </PrivacyProvider>
    );

    act(() => root.render(renderLayer(firstWorld)));
    act(() => firstWorld.emit('building:entered', { building: 'bank' }));
    act(() => root.render(renderLayer(secondWorld)));
    act(() => secondWorld.emit('building:entered', { building: 'exchange' }));
    expect(container.querySelector('[data-room="exchange"]')).not.toBeNull();

    // This represents an already-queued callback from the retired world. The
    // event bus unsubscribe prevents future delivery, but cannot retract a
    // callback the old world has already captured.
    act(() => staleEntered({ building: 'bank' }));
    expect(container.querySelector('[data-room="exchange"]')).not.toBeNull();
    expect(container.querySelector('[data-room="bank"]')).toBeNull();
    root.unmount();
  });

  it('ignores a stale panel close callback after the world replaces the active room', () => {
    const world = createEventBus<WorldEvents>();
    const shell = createEventBus<ShellEvents>();
    const exits: Array<{ building: BuildingId }> = [];
    shell.on('world:exit-building', (payload) => exits.push(payload));
    let staleClose!: () => void;
    const panels = {
      ...BUILDING_PANELS,
      bank: { ...BUILDING_PANELS.bank!, Component: ({ onClose }: { onClose: () => void }) => { staleClose = onClose; return <p>bank test</p>; } },
    };
    const container = document.createElement('div');
    const root = createRoot(container);

    act(() => {
      root.render(
        <PrivacyProvider operations={new FakePrivacyOperations()} initialConnectState={{ name: 'connected', capability: { supportsStrk20: true, walletApiVersion: '1', registration: 'registered' }, registrationConfirmed: true }} shellBus={shell}>
          <PanelLayer world={world} panels={panels} />
        </PrivacyProvider>,
      );
    });
    act(() => {
      world.emit('building:entered', { building: 'bank' });
    });
    expect(staleClose).toBeTypeOf('function');

    act(() => world.emit('building:entered', { building: 'exchange' }));
    act(() => staleClose());

    expect(exits).toEqual([]);
    expect(container.innerHTML).toContain('Exchange');
    root.unmount();
  });

  it('rolls back world listeners when a later effect registration fails', () => {
    const world = createEventBus<WorldEvents>();
    const originalOn = world.on;
    const stopCalls: Array<ReturnType<typeof vi.fn>> = [];
    let registrations = 0;
    const failure = new Error('world listener registration failed');
    world.on = ((event, handler) => {
      registrations += 1;
      if (registrations === 3) throw failure;
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
    const container = document.createElement('div');
    const root = createRoot(container);

    expect(() => act(() => {
      root.render(
        <PrivacyProvider operations={new FakePrivacyOperations()}>
          <PanelLayer world={world} />
        </PrivacyProvider>,
      );
    })).toThrow(failure);
    expect(stopCalls).toHaveLength(2);
    expect(stopCalls.every((stop) => stop.mock.calls.length === 1)).toBe(true);
    root.unmount();
  });
});
