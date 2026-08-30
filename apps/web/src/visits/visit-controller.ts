import type {
  BuildingId,
  EventBus,
  ShellEvents,
  StationId,
  WorldEvents,
} from '@strkworld/shared';
import { PRIVACY_REGISTER, type RouteGrade } from '../privacy/register.js';
import { createStore, type ReadableStore } from '../store/store.js';
import { resolveStation, stationSnapshot, type StationCapabilities } from './station-registry.js';

export type VisitState =
  | { readonly name: 'outside' }
  | { readonly name: 'locked'; readonly building: BuildingId; readonly reason: 'coming-soon' }
  | {
      readonly name: 'visiting';
      readonly building: BuildingId;
      readonly surface:
        | { readonly name: 'room' }
        | { readonly name: 'menu' }
        | { readonly name: 'station'; readonly station: StationId };
    };

export interface VisitController {
  /** Read-only view; controller methods own every state transition. */
  readonly store: ReadableStore<VisitState>;
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
  function freezeVisitState(state: VisitState): VisitState {
    if (state.name === 'visiting') Object.freeze(state.surface);
    return Object.freeze(state);
  }

  const stateStore = createStore<VisitState>(freezeVisitState({ name: 'outside' }));
  const setState = (update: VisitState | ((previous: VisitState) => VisitState)): void => {
    stateStore.setState(
      typeof update === 'function'
        ? (previous) => freezeVisitState((update as (previous: VisitState) => VisitState)(previous))
        : freezeVisitState(update),
    );
  };
  const store: ReadableStore<VisitState> = {
    getState: stateStore.getState,
    getServerSnapshot: stateStore.getServerSnapshot,
    subscribe: stateStore.subscribe,
  };

  function ownControls(building: BuildingId, owner: 'world' | 'shell'): void {
    shell.emit('world:control-owner', { building, owner });
  }

  function enter(building: BuildingId): void {
    // DoorTrigger emits the prior room's exit before a legitimate new enter.
    // Ignore any re-entrant or stale enter while React still owns an active
    // visit; only the authoritative matching exit may reset this state.
    if (store.getState().name === 'visiting') return;
    setState({ name: 'visiting', building, surface: { name: 'room' } });
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
    // Shell delivery is synchronous. A World callback can report the room's
    // exit during that handoff, so do not publish a station for a visit that
    // no longer owns this transition.
    if (store.getState() !== state) return;
    setState({ name: 'visiting', building, surface: { name: 'station', station } });
  }

  return {
    store,

    listen(world): () => void {
      const stops: Array<() => void> = [];
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
        stops.push(world.on('building:entered', ({ building }) => enter(building)));
        stops.push(world.on('building:locked', ({ building, reason }) => {
          const state = store.getState();
          if (state.name === 'visiting') return;
          setState({ name: 'locked', building, reason });
        }));
        stops.push(world.on('building:exited', ({ building }) => {
          const state = store.getState();
          if (state.name === 'visiting' && state.building === building) {
            // The World owns movement after the player leaves, even if the
            // exit arrived while a station window was still mounted.
            if (state.surface.name !== 'room') ownControls(building, 'world');
            setState({ name: 'outside' });
          }
        }));
        stops.push(world.on('station:activated', ({ building, station }) => activate(building, station)));
      } catch (error) {
        try {
          stopWorld();
        } catch {
          // Preserve the listener registration error; cleanup is best effort.
        }
        throw error;
      }
      return () => {
        let cleanupFailure: unknown;
        try {
          stopWorld();
        } catch (error) {
          cleanupFailure = error;
        }
        // StrictMode and route changes can unmount the Shell while React owns
        // the controls. Do not leave the World permanently suspended because
        // the panel disappeared before it could emit its normal close event.
        const state = store.getState();
        if (state.name === 'visiting' && state.surface.name !== 'room') {
          try {
            ownControls(state.building, 'world');
          } catch (error) {
            cleanupFailure ??= error;
          }
        }
        if (cleanupFailure) throw cleanupFailure;
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
      if (store.getState() !== state) return;
      setState({ ...state, surface: { name: 'menu' } });
    },

    closeSurface(): void {
      const state = store.getState();
      if (state.name !== 'visiting' || state.surface.name === 'room') return;
      ownControls(state.building, 'world');
      if (store.getState() !== state) return;
      setState({ ...state, surface: { name: 'room' } });
    },

    dismissLocked(): void {
      if (store.getState().name === 'locked') setState({ name: 'outside' });
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
