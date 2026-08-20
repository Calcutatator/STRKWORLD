import type {
  BuildingId,
  EventBus,
  ShellEvents,
  StationId,
  WorldEvents,
} from '@strkworld/shared';
import { PRIVACY_REGISTER, type RouteGrade } from '../privacy/register.js';
import { createStore, type Store } from '../store/store.js';
import { resolveStation, stationSnapshot, type StationCapabilities } from './station-registry.js';

export type VisitState =
  | { name: 'outside' }
  | { name: 'locked'; building: BuildingId; reason: 'coming-soon' }
  | {
      name: 'visiting';
      building: BuildingId;
      surface:
        | { name: 'room' }
        | { name: 'menu' }
        | { name: 'station'; station: StationId };
    };

export interface VisitController {
  readonly store: Store<VisitState>;
  /** Attach World listeners. The returned cleanup owns every subscription. */
  listen(world: EventBus<WorldEvents>): () => void;
  /** Ask the World to leave the active Game Mode room. World confirms exit. */
  requestExit(): void;
  openMenu(): void;
  closeSurface(): void;
  dismissLocked(): void;
  handleEscape(): void;
}

/**
 * Shell state for one local building visit.
 *
 * The controller knows modes and station admission. The World knows geometry
 * and sends semantic events. Changing surfaces never asks the World to exit;
 * only a matching `building:exited` event ends a visit (D-030–D-033).
 */
export function createVisitController(
  shell: EventBus<ShellEvents>,
  register: readonly RouteGrade[] = PRIVACY_REGISTER,
  capabilities: StationCapabilities | (() => StationCapabilities) = {},
): VisitController {
  const store = createStore<VisitState>({ name: 'outside' });

  function ownControls(building: BuildingId, owner: 'world' | 'shell'): void {
    shell.emit('world:control-owner', { building, owner });
  }

  function enter(building: BuildingId): void {
    store.setState({ name: 'visiting', building, surface: { name: 'room' } });
    shell.emit('world:stations', { building, stations: stationSnapshot(building, register, currentCapabilities()) });
  }

  function currentCapabilities(): StationCapabilities {
    return typeof capabilities === 'function' ? capabilities() : capabilities;
  }

  function activate(building: BuildingId, station: StationId): void {
    const state = store.getState();
    if (
      state.name !== 'visiting' ||
      state.building !== building ||
      state.surface.name !== 'room'
    ) {
      return;
    }

    const resolution = resolveStation(building, station, register, currentCapabilities());
    if (resolution.status === 'locked') {
      // World suspends movement before emitting station:activated. An unknown
      // or newly-disabled station must fail closed without leaving input stuck.
      ownControls(building, 'world');
      return;
    }

    // Ownership changes before the interaction window appears. React now owns
    // Escape and every text input until closeSurface hands controls back.
    ownControls(building, 'shell');
    store.setState({ name: 'visiting', building, surface: { name: 'station', station } });
  }

  return {
    store,

    listen(world): () => void {
      const stops = [
        world.on('building:entered', ({ building }) => enter(building)),
        world.on('building:locked', ({ building, reason }) => {
          const state = store.getState();
          if (state.name === 'visiting') return;
          store.setState({ name: 'locked', building, reason });
        }),
        world.on('building:exited', ({ building }) => {
          const state = store.getState();
          if (state.name === 'visiting' && state.building === building) {
            // The World owns movement after the player leaves, even if the
            // exit arrived while a station window was still mounted.
            if (state.surface.name !== 'room') ownControls(building, 'world');
            store.setState({ name: 'outside' });
          }
        }),
        world.on('station:activated', ({ building, station }) => activate(building, station)),
      ];
      return () => {
        for (const stop of stops) stop();
        // StrictMode and route changes can unmount the Shell while React owns
        // the controls. Do not leave the World permanently suspended because
        // the panel disappeared before it could emit its normal close event.
        const state = store.getState();
        if (state.name === 'visiting' && state.surface.name !== 'room') {
          ownControls(state.building, 'world');
        }
      };
    },

    requestExit(): void {
      const state = store.getState();
      if (state.name !== 'visiting') return;
      shell.emit('world:exit-building', { building: state.building });
    },

    openMenu(): void {
      const state = store.getState();
      if (state.name !== 'visiting' || state.surface.name !== 'room') return;
      ownControls(state.building, 'shell');
      store.setState({ ...state, surface: { name: 'menu' } });
    },

    closeSurface(): void {
      const state = store.getState();
      if (state.name !== 'visiting' || state.surface.name === 'room') return;
      ownControls(state.building, 'world');
      store.setState({ ...state, surface: { name: 'room' } });
    },

    dismissLocked(): void {
      if (store.getState().name === 'locked') store.setState({ name: 'outside' });
    },

    handleEscape(): void {
      if (store.getState().name === 'locked') {
        this.dismissLocked();
        return;
      }
      this.closeSurface();
    },
  };
}
