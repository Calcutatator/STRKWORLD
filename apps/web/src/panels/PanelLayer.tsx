import { useEffect, useRef, useState, type ReactElement } from 'react';
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
 * The glue here is deliberately thin. The two things worth testing — how a
 * world event moves the active room (`nextActiveRoom`) and what each active
 * room renders (`ActiveRoomView`) — are pulled out as a pure reducer and a
 * pure view, so both are covered without a DOM. What is left in the component
 * is a subscription with cleanup and a piece of `useState`.
 */

/**
 * Which door the player is standing at, and how the world described it.
 *
 * The **source** is kept, not collapsed to a building id, because the two
 * sources are not interchangeable. `entered` still runs the privacy gate —
 * the world saying a door opened does not overrule the register saying its
 * route is locked. `locked` is the world's own verdict that the door is shut,
 * and it is honoured directly. A lock from either side is a locked door; a
 * panel opens only when both sides agree.
 */
export type ActiveRoom =
  | { source: 'entered'; building: BuildingId }
  | { source: 'locked'; building: BuildingId; reason: 'coming-soon' };

/** One world event applied to the current active room. Pure. */
export function nextActiveRoom(
  current: ActiveRoom | null,
  event:
    | { name: 'building:entered'; payload: WorldEvents['building:entered'] }
    | { name: 'building:locked'; payload: WorldEvents['building:locked'] }
    | { name: 'building:exited'; payload: WorldEvents['building:exited'] },
): ActiveRoom | null {
  if (!event.payload || typeof event.payload !== 'object') return current;
  switch (event.name) {
    case 'building:entered':
      return { source: 'entered', building: event.payload.building };
    case 'building:locked':
      return { source: 'locked', building: event.payload.building, reason: event.payload.reason };
    case 'building:exited':
      // The world emits this only for a door that was actually entered, so a
      // stale exit for some other building should not tear down the room the
      // player is now looking at. A locked door emits no exit at all — walking
      // away from it is closed with the Close control instead (see the PR note).
      if (current?.building === event.payload.building) return null;
      return current;
  }
}

export function PanelLayer({
  world,
  panels = BUILDING_PANELS,
}: {
  world: EventBus<WorldEvents>;
  panels?: PanelRegistry<BuildingPanelDescriptor>;
}) {
  const { connectState, shellBus } = usePrivacy();
  const [active, setActive] = useState<ActiveRoom | null>(null);
  const activeRef = useRef<ActiveRoom | null>(null);
  const listenGeneration = useRef(0);
  const publishActive = (next: ActiveRoom | null): void => {
    // Keep the owner current before React schedules the render. A stale panel
    // callback can otherwise close the replacement room during that window.
    activeRef.current = next;
    setActive(next);
  };

  useEffect(() => {
    // One effect, one cleanup. Under StrictMode this runs mount → cleanup →
    // mount; each `on` hands back its own unsubscribe and the cleanup calls
    // every one, so no subscription outlives the effect that made it and the
    // bus never accumulates a second copy of these handlers.
    const stops: Array<() => void> = [];
    const generation = ++listenGeneration.current;
    const ownsListeners = (): boolean => listenGeneration.current === generation;
    const stopWorld = () => {
      let cleanupFailure: unknown;
      for (const stop of stops.splice(0)) {
        try {
          stop();
        } catch (error) {
          cleanupFailure ??= error;
        }
      }
      if (cleanupFailure) throw cleanupFailure;
    };
    try {
      stops.push(world.on('building:entered', (payload) => {
        if (!ownsListeners()) return;
        publishActive(nextActiveRoom(activeRef.current, { name: 'building:entered', payload }));
      }));
      stops.push(world.on('building:locked', (payload) => {
        if (!ownsListeners()) return;
        publishActive(nextActiveRoom(activeRef.current, { name: 'building:locked', payload }));
      }));
      stops.push(world.on('building:exited', (payload) => {
        if (!ownsListeners()) return;
        publishActive(nextActiveRoom(activeRef.current, { name: 'building:exited', payload }));
      }));
      return () => {
        // Unsubscribe stops future bus delivery, but cannot retract a callback
        // the old World already captured. Retire this generation first so a
        // late completion cannot reopen a room owned by a replacement bus.
        if (ownsListeners()) listenGeneration.current += 1;
        stopWorld();
      };
    } catch (error) {
      if (ownsListeners()) listenGeneration.current += 1;
      try {
        stopWorld();
      } catch {
        // Preserve the listener registration error; cleanup is best effort.
      }
      throw error;
    }
  }, [world]);

  if (!active) return null;

  const close = (): void => {
    if (activeRef.current !== active) return;
    activeRef.current = null;
    setActive(null);
    // Ask the world to release the player. The world owns the avatar; the shell
    // only ever asks (D-010). `world:exit-building` is part of the frozen bus.
    shellBus?.emit('world:exit-building', { building: active.building });
  };

  return (
    <ActiveRoomView
      active={active}
      panels={panels}
      connected={connectState.name === 'connected'}
      onClose={close}
    />
  );
}

/**
 * What a given active room renders. Pure in its inputs, so every branch is a
 * static-render test rather than an event-driven one.
 *
 * Order is the product rule in code: the world's own lock first, then the
 * privacy gate, then the wallet gate, and only then a functional room.
 */
export function ActiveRoomView({
  active,
  panels,
  connected,
  onClose,
}: {
  active: ActiveRoom;
  panels: PanelRegistry<BuildingPanelDescriptor>;
  connected: boolean;
  onClose: () => void;
}): ReactElement {
  if (active.source === 'locked') {
    return (
      <LockedRoom
        building={active.building}
        reason={active.reason}
        message={COPY.locked.comingSoon}
        onClose={onClose}
      />
    );
  }

  const room = resolveRoom(active.building, panels);

  if (room.kind === 'locked') {
    return (
      <LockedRoom building={room.building} reason={room.reason} message={room.message} onClose={onClose} />
    );
  }

  if (room.kind === 'unbuilt') {
    return <UnbuiltRoom building={room.building} message={room.message} onClose={onClose} />;
  }

  // A graded, approved, built room still needs a wallet that can reach the
  // pool. The connect flow's own rooms explain why when it cannot.
  if (!connected) {
    return (
      <PanelFrame title={COPY.buildings[room.building]} disclosure={null} onClose={onClose}>
        <ConnectRoom />
      </PanelFrame>
    );
  }

  const { Component } = room.panel;
  return <Component onClose={onClose} />;
}
