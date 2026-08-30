import { useEffect, useMemo, useRef, type ReactElement } from 'react';
import type { EventBus, ShellEvents, WorldEvents } from '@strkworld/shared';
import { COPY } from '../copy.js';
import { ConnectRoom } from '../connect/ConnectRoom.js';
import { BankPanel } from '../panels/bank/BankPanel.js';
import { ExchangePanel } from '../panels/exchange/ExchangePanel.js';
import { BridgePanel } from '../panels/bridge/BridgePanel.js';
import { LockedRoom, UnbuiltRoom } from '../panels/LockedRoom.js';
import { PanelFrame } from '../panels/PanelFrame.js';
import { resolveRoom, type PanelRegistry } from '../panels/panel-framework.js';
import { BUILDING_PANELS, type BuildingPanelDescriptor } from '../panels/registry.js';
import { PRIVACY_REGISTER, type RouteGrade } from '../privacy/register.js';
import { usePrivacy } from '../privacy/PrivacyProvider.js';
import { useBridge } from '../bridge/BridgeProvider.js';
import { useStore } from '../store/use-store.js';
import { resolveStation } from './station-registry.js';
import {
  createVisitController,
  type VisitController,
  type VisitState,
} from './visit-controller.js';

/** Production wiring shared with the public view regression. */
export function visitLayerActions(
  controller: Pick<
    VisitController,
    'openMenu' | 'requestExit' | 'closeSurface' | 'dismissLocked'
  >,
) {
  return Object.freeze({
    onOpenMenu: () => controller.openMenu(),
    onRequestExit: () => controller.requestExit(),
    onCloseSurface: () => controller.closeSurface(),
    onDismissLocked: () => controller.dismissLocked(),
  });
}

/** Production keyboard filter shared with the public lifecycle regression. */
export function handleVisitKeyDown(
  event: Pick<KeyboardEvent, 'key' | 'preventDefault'>,
  controller: Pick<VisitController, 'store' | 'handleEscape'>,
): void {
  if (event.key !== 'Escape') return;
  const current = controller.store.getState();
  if (
    current.name === 'outside' ||
    (current.name === 'visiting' && current.surface.name === 'room')
  ) {
    return;
  }
  event.preventDefault();
  controller.handleEscape();
}

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
  const bridge = useBridge();
  const bridgeRef = useRef(bridge);
  bridgeRef.current = bridge;
  const controller = useMemo(() => createVisitController(shell, register, {
    get bridgeAccountAvailable() { return bridgeRef.current.account !== null; },
    get bridgePlannerAvailable() { return Boolean(bridgeRef.current.planner); },
  }), [shell, register]);
  const state = useStore(controller.store);

  useEffect(() => controller.listen(world), [controller, world]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => handleVisitKeyDown(event, controller);
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [controller]);

  return (
    <VisitLayerView
      state={state}
      connected={connectState.name === 'connected'}
      bridgeCapabilities={{
        bridgeAccountAvailable: bridge.account !== null,
        bridgePlannerAvailable: Boolean(bridge.planner),
      }}
      register={register}
      {...visitLayerActions(controller)}
    />
  );
}

/** Pure render half, kept separate so every financial branch is testable in Node. */
export function VisitLayerView({
  state,
  connected,
  bridgeCapabilities,
  register = PRIVACY_REGISTER,
  panels = BUILDING_PANELS,
  onOpenMenu,
  onRequestExit,
  onCloseSurface,
  onDismissLocked,
}: {
  state: VisitState;
  connected: boolean;
  bridgeCapabilities?: import('./station-registry.js').StationCapabilities;
  register?: readonly RouteGrade[];
  panels?: PanelRegistry<BuildingPanelDescriptor>;
  onOpenMenu: () => void;
  onRequestExit: () => void;
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

  const withControls = (surface: ReactElement | null, showMenu = false): ReactElement => (
    <>
      <div className="game-mode-controls">
        {showMenu ? (
          <button type="button" className="menu-mode-button" onClick={onOpenMenu}>
            {COPY.gameMode.menu}
          </button>
        ) : null}
        <button type="button" className="exit-building-button" onClick={onRequestExit}>
          {COPY.gameMode.exit}
        </button>
      </div>
      {surface}
    </>
  );

  if (state.surface.name === 'room') {
    return withControls(null, true);
  }

  if (state.surface.name === 'station') {
    const station = resolveStation(state.building, state.surface.station, register, bridgeCapabilities);
    if (station.status === 'locked') {
      return withControls(
        <LockedRoom
          building={state.building}
          reason={station.door.reason ?? 'unknown-route'}
          message={station.door.message}
          onClose={onCloseSurface}
        />,
      );
    }

    if (!connected && station.definition.view !== 'bridge') {
      return withControls(
        <ConnectionSurface building={state.building} onClose={onCloseSurface} />,
      );
    }

    if (station.definition.view === 'bank') {
      return withControls(
        <BankPanel
          experience="station"
          building={station.definition.building}
          allowedModes={station.definition.modes}
          initialMode={station.definition.initialMode}
          register={register}
          title={COPY.buildings[station.definition.building]}
          onClose={onCloseSurface}
        />,
      );
    }
    if (station.definition.view === 'exchange') {
      return withControls(<ExchangePanel experience="station" onClose={onCloseSurface} />);
    }
    if (station.definition.view === 'bridge') {
      return withControls(<BridgePanel experience="station" register={register} onClose={onCloseSurface} />);
    }
  }

  const room = resolveRoom(state.building, panels, register);
  if (room.kind === 'locked') {
    return withControls(
      <LockedRoom
        building={room.building}
        reason={room.reason}
        message={room.message}
        onClose={onCloseSurface}
      />,
    );
  }
  if (room.kind === 'unbuilt') {
    return withControls(
      <UnbuiltRoom building={room.building} message={room.message} onClose={onCloseSurface} />,
    );
  }
  if (state.building === 'bridge') {
    return withControls(<BridgePanel experience="menu" register={register} onClose={onCloseSurface} />);
  }
  if (!connected) {
    return withControls(
      <ConnectionSurface building={state.building} onClose={onCloseSurface} />,
    );
  }

  const { Component } = room.panel;
  return withControls(<Component onClose={onCloseSurface} register={register} />);
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
