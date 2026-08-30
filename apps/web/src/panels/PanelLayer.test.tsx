// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FakePrivacyOperations } from '@strkworld/privacy';
import type { BuildingId, WorldEvents } from '@strkworld/shared';
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
