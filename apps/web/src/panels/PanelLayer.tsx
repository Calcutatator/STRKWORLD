import { useCallback, useEffect, useState } from 'react';
import type { BuildingId, EventBus, WorldEvents } from '@strkworld/shared';
import { COPY } from '../copy.js';
import { ConnectRoom } from '../connect/ConnectRoom.js';
import { usePrivacy } from '../privacy/PrivacyProvider.js';
import { LockedRoom, UnbuiltRoom } from './LockedRoom.js';
import { PanelFrame } from './PanelFrame.js';
import { resolveRoom, type PanelRegistry } from './panel-framework.js';
import { BUILDING_PANELS, type BuildingPanelDescriptor } from './registry.js';

/**
 * The building overlay.
 *
 * Interiors are overlays over the street (D-016), so this renders above the
 * world rather than replacing it. It listens to the world's semantic events and
 * pushes an exit back; it does not mount the world, own the bus, or reach into
 * Phaser — that boundary is one-directional by design (D-010, D-027).
 *
 * The order here is the product rule in code: the privacy gate decides whether
 * a door opens, then the wallet gate decides whether the room can do anything,
 * and only then does the room render.
 */
export function PanelLayer({
  world,
  panels = BUILDING_PANELS,
}: {
  world: EventBus<WorldEvents>;
  panels?: PanelRegistry<BuildingPanelDescriptor>;
}) {
  const { connectState, shellBus } = usePrivacy();
  const [active, setActive] = useState<BuildingId | null>(null);

  useEffect(() => {
    const stopEntered = world.on('building:entered', ({ building }) => setActive(building));
    const stopExited = world.on('building:exited', () => setActive(null));
    return () => {
      stopEntered();
      stopExited();
    };
  }, [world]);

  const close = useCallback(() => {
    setActive(null);
    // Ask the world to release the player. The world owns the avatar; the shell
    // only ever asks.
    shellBus?.emit('world:exit-building', {});
  }, [shellBus]);

  if (!active) return null;

  const room = resolveRoom(active, panels);

  if (room.kind === 'locked') {
    return (
      <LockedRoom building={room.building} reason={room.reason} message={room.message} onClose={close} />
    );
  }

  if (room.kind === 'unbuilt') {
    return <UnbuiltRoom building={room.building} message={room.message} onClose={close} />;
  }

  // A graded, approved, built room still needs a wallet that can reach the
  // pool. The connect flow's own rooms explain why when it cannot.
  if (connectState.name !== 'connected') {
    return (
      <PanelFrame title={COPY.buildings[room.building]} disclosure={null} onClose={close}>
        <ConnectRoom />
      </PanelFrame>
    );
  }

  const { Component } = room.panel;
  return <Component onClose={close} />;
}
