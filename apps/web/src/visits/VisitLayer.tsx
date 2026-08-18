import { useEffect, useMemo, type ReactElement } from 'react';
import type { EventBus, ShellEvents, WorldEvents } from '@strkworld/shared';
import { COPY } from '../copy.js';
import { ConnectRoom } from '../connect/ConnectRoom.js';
import { BankPanel } from '../panels/bank/BankPanel.js';
import { ExchangePanel } from '../panels/exchange/ExchangePanel.js';
import { LockedRoom, UnbuiltRoom } from '../panels/LockedRoom.js';
import { PanelFrame } from '../panels/PanelFrame.js';
import { resolveRoom, type PanelRegistry } from '../panels/panel-framework.js';
import { BUILDING_PANELS, type BuildingPanelDescriptor } from '../panels/registry.js';
import { PRIVACY_REGISTER, type RouteGrade } from '../privacy/register.js';
import { usePrivacy } from '../privacy/PrivacyProvider.js';
import { useStore } from '../store/use-store.js';
import { resolveStation } from './station-registry.js';
import { createVisitController, type VisitState } from './visit-controller.js';

/**
 * React's half of one local building visit.
 *
 * The controller owns mode and control handoff; the view owns financial
 * surfaces. Neither reaches into Phaser. The effect cleanup is deliberately
 * complete so React StrictMode cannot accumulate a second set of World
 * listeners during its mount -> cleanup -> mount probe.
 */
export function VisitLayer({
  world,
  shell,
  register = PRIVACY_REGISTER,
}: {
  world: EventBus<WorldEvents>;
  shell: EventBus<ShellEvents>;
  register?: readonly RouteGrade[];
}) {
  const { connectState } = usePrivacy();
  const controller = useMemo(() => createVisitController(shell, register), [shell, register]);
  const state = useStore(controller.store);

  useEffect(() => controller.listen(world), [controller, world]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      const current = controller.store.getState();
      if (current.name !== 'visiting' || current.surface.name === 'room') return;
      event.preventDefault();
      controller.handleEscape();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [controller]);

  return (
    <VisitLayerView
      state={state}
      connected={connectState.name === 'connected'}
      register={register}
      onOpenMenu={() => controller.openMenu()}
      onCloseSurface={() => controller.closeSurface()}
      onDismissLocked={() => controller.dismissLocked()}
    />
  );
}

/** Pure render half, kept separate so every financial branch is testable in Node. */
export function VisitLayerView({
  state,
  connected,
  register = PRIVACY_REGISTER,
  panels = BUILDING_PANELS,
  onOpenMenu,
  onCloseSurface,
  onDismissLocked,
}: {
  state: VisitState;
  connected: boolean;
  register?: readonly RouteGrade[];
  panels?: PanelRegistry<BuildingPanelDescriptor>;
  onOpenMenu: () => void;
  onCloseSurface: () => void;
  onDismissLocked: () => void;
}): ReactElement | null {
  if (state.name === 'outside') return null;

  if (state.name === 'locked') {
    return (
      <LockedRoom
        building={state.building}
        reason={state.reason}
        message={COPY.locked.comingSoon}
        onClose={onDismissLocked}
      />
    );
  }

  if (state.surface.name === 'room') {
    return (
      <button type="button" className="menu-mode-button" onClick={onOpenMenu}>
        {COPY.gameMode.menu}
      </button>
    );
  }

  if (state.surface.name === 'station') {
    const station = resolveStation(state.building, state.surface.station, register);
    if (station.status === 'locked') {
      return (
        <LockedRoom
          building={state.building}
          reason={station.door.reason ?? 'unknown-route'}
          message={station.door.message}
          onClose={onCloseSurface}
        />
      );
    }

    if (!connected) return <ConnectionSurface building={state.building} onClose={onCloseSurface} />;

    if (station.definition.view === 'bank') {
      return (
        <BankPanel
          experience="station"
          building={station.definition.building}
          allowedModes={station.definition.modes}
          initialMode={station.definition.initialMode}
          title={COPY.buildings[station.definition.building]}
          onClose={onCloseSurface}
        />
      );
    }
    if (station.definition.view === 'exchange') {
      return <ExchangePanel experience="station" onClose={onCloseSurface} />;
    }
  }

  const room = resolveRoom(state.building, panels, register);
  if (room.kind === 'locked') {
    return (
      <LockedRoom
        building={room.building}
        reason={room.reason}
        message={room.message}
        onClose={onCloseSurface}
      />
    );
  }
  if (room.kind === 'unbuilt') {
    return <UnbuiltRoom building={room.building} message={room.message} onClose={onCloseSurface} />;
  }
  if (!connected) return <ConnectionSurface building={state.building} onClose={onCloseSurface} />;

  const { Component } = room.panel;
  return <Component onClose={onCloseSurface} />;
}

function ConnectionSurface({
  building,
  onClose,
}: {
  building: Extract<VisitState, { name: 'visiting' }>['building'];
  onClose: () => void;
}) {
  return (
    <PanelFrame title={COPY.buildings[building]} disclosure={null} onClose={onClose}>
      <ConnectRoom />
    </PanelFrame>
  );
}
