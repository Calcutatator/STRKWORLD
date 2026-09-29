import type {
  BuildingId,
  EventBus,
  ShellEvents,
  StationId,
  WorldEvents,
} from '@strkworld/shared';
import { debugVisit } from '../debug/debug-tap.js';
import { PRIVACY_REGISTER, type RouteGrade } from '../privacy/register.js';
import { createStore, type ReadableStore } from '../store/store.js';
import { ownBuildingPayload, ownLockedBuildingPayload, ownStationPayload } from '../bus/world-event-payload.js';
import { resolveStation, stationSnapshot, type StationCapabilities } from './station-registry.js';

export type VisitState =
  | { readonly name: 'outside' }
  | { readonly name: 'locked'; readonly building: BuildingId; readonly reason: 'coming-soon' }
  /**
   * D-076: a Privacy Plaza window, opened with E on the street. No building
   * was entered: presence, the street and the lobby are untouched, and
   * closing it goes straight back outside.
   */
  | { readonly name: 'plaza'; readonly station: StationId }
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
  /**
   * Re-publish the active room's station presentation. Capabilities can arrive
   * after entry — the production Bridge runtime loads when the player walks in —
   * and a snapshot published at the door would otherwise keep a station locked
   * for the rest of the visit. Outside a visit this does nothing.
   */
  refreshStations(): void;
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
    const before = stateStore.getState();
    const next = freezeVisitState(
      typeof update === 'function' ? (update as (previous: VisitState) => VisitState)(before) : update,
    );
    // D-069: panel opens and closes, read from this one transition point and
    // recorded before delivery, so a re-entrant update logs after this one.
    // Inert unless debug logs are on.
    debugVisit(before, next);
    stateStore.setState(next);
  };
  const store: ReadableStore<VisitState> = {
    getState: stateStore.getState,
    getServerSnapshot: stateStore.getServerSnapshot,
    subscribe: stateStore.subscribe,
  };
  let listenGeneration = 0;
  let activeListenGeneration: number | null = null;

  function ownControls(building: BuildingId, owner: 'world' | 'shell'): void {
    shell.emit('world:control-owner', { building, owner });
  }

  function enter(building: BuildingId): void {
    // DoorTrigger emits the prior room's exit before a legitimate new enter.
    // Ignore any re-entrant or stale enter while React still owns an active
    // visit; only the authoritative matching exit may reset this state. A
    // plaza window owns the controls until it closes, so nobody walks in.
    const current = store.getState().name;
    if (current === 'visiting' || current === 'plaza') return;
    setState({ name: 'visiting', building, surface: { name: 'room' } });
    publishStations(building);
  }

  function publishStations(building: BuildingId): void {
    shell.emit('world:stations', { building, stations: stationSnapshot(building, register, currentCapabilities()) });
  }

  function currentCapabilities(): StationCapabilities {
    return typeof capabilities === 'function' ? capabilities() : capabilities;
  }

  /**
   * D-076: a Privacy Plaza station, from the street. The World suspended its
   * input before it emitted the activation, so every outcome hands the
   * controls somewhere: to this window, or straight back to the World.
   */
  function activatePlaza(station: StationId): void {
    const state = store.getState();
    // Inside a building or with a plaza window already open, a press here is
    // stale or doubled. A locked door's notice is on the street, so the plaza
    // window simply replaces it.
    if (state.name === 'visiting' || state.name === 'plaza') {
      if (state.name === 'visiting') ownControls('plaza', 'world');
      return;
    }
    const resolution = resolveStation('plaza', station, register, currentCapabilities());
    if (resolution.status === 'locked') {
      ownControls('plaza', 'world');
      return;
    }
    ownControls('plaza', 'shell');
    if (store.getState() !== state) return;
    setState({ name: 'plaza', station });
  }

  function activate(building: BuildingId, station: StationId): void {
    if (building === 'plaza') {
      activatePlaza(station);
      return;
    }
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

  function closeSurface(): void {
    const state = store.getState();
    if (state.name === 'plaza') {
      ownControls('plaza', 'world');
      if (store.getState() !== state) return;
      setState({ name: 'outside' });
      return;
    }
    if (state.name !== 'visiting' || state.surface.name === 'room') return;
    ownControls(state.building, 'world');
    if (store.getState() !== state) return;
    setState({ ...state, surface: { name: 'room' } });
  }

  function dismissLocked(): void {
    if (store.getState().name === 'locked') setState({ name: 'outside' });
  }

  function handleEscape(): void {
    if (store.getState().name === 'locked') {
      dismissLocked();
      return;
    }
    closeSurface();
  }

  return Object.freeze<VisitController>({
    store,

    listen(world): () => void {
      const generation = ++listenGeneration;
      activeListenGeneration = generation;
      const ownsListen = (): boolean => activeListenGeneration === generation;
      const stops: Array<() => void> = [];
      let stopped = false;
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
          if (!ownsListen()) return;
          const owned = ownBuildingPayload(payload);
          if (!owned) return;
          enter(owned.building);
        }));
        stops.push(world.on('building:locked', (payload) => {
          if (!ownsListen()) return;
          const owned = ownLockedBuildingPayload(payload);
          if (!owned) return;
          const { building, reason } = owned;
          const state = store.getState();
          if (state.name === 'visiting' || state.name === 'plaza') return;
          setState({ name: 'locked', building, reason });
        }));
        stops.push(world.on('building:exited', (payload) => {
          if (!ownsListen()) return;
          const owned = ownBuildingPayload(payload);
          if (!owned) return;
          const { building } = owned;
          const state = store.getState();
          if (state.name === 'visiting' && state.building === building) {
            // The World owns movement after the player leaves, even if the
            // exit arrived while a station window was still mounted.
            if (state.surface.name !== 'room') ownControls(building, 'world');
            setState({ name: 'outside' });
          }
        }));
        stops.push(world.on('station:activated', (payload) => {
          if (!ownsListen()) return;
          const owned = ownStationPayload(payload);
          if (!owned) return;
          activate(owned.building, owned.station);
        }));
      } catch (error) {
        if (ownsListen()) activeListenGeneration = null;
        try {
          stopWorld();
        } catch {
          // Preserve the listener registration error; cleanup is best effort.
        }
        throw error;
      }
      return () => {
        if (stopped) return;
        stopped = true;
        const ownsCurrentListen = ownsListen();
        if (ownsCurrentListen) activeListenGeneration = null;
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
        const heldBy = state.name === 'plaza'
          ? 'plaza'
          : state.name === 'visiting' && state.surface.name !== 'room' ? state.building : null;
        if (ownsCurrentListen && heldBy) {
          try {
            ownControls(heldBy, 'world');
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

    closeSurface,
    dismissLocked,
    handleEscape,

    refreshStations(): void {
      // Presentation only, like the entry snapshot: activation still resolves
      // the station again against the live capabilities.
      const state = store.getState();
      if (state.name !== 'visiting') return;
      publishStations(state.building);
    },
  });
}
