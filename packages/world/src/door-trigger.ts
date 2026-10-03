/**
 * Door triggers: turning tile movement into semantic building events.
 *
 * The state machine is deliberately Phaser-free and pushed out of the scene so
 * the part that matters — which event fires, with which building id, on which
 * transition — is unit-tested headlessly against a fake bus, with no browser,
 * no canvas and no game loop. The scene is only glue: on a tile change it calls
 * `update(tile)`.
 *
 * Transitions, from the door the player currently occupies to the one they do:
 *
 *  - step into an UNLOCKED door zone  -> emit `building:entered`
 *  - step out of an entered door zone -> emit `building:exited`
 *  - step into a LOCKED door zone     -> emit `building:locked` (coming-soon)
 *
 * Re-entry hold (D-114, amended 2026-10-02): leaving a room resets the
 * trigger with a hold. For `holdMs` of session time (`advance`) no door
 * fires, and a door the player reaches meanwhile stays shut until they step
 * off it, even once the hold has run out. Standing still where a room put
 * them never fires a door, and a key held through the handoff cannot bounce
 * them straight back in. Walking back onto the door afterwards enters as
 * usual. A swallowed door emits nothing, so there is nothing to roll back.
 *
 * The Vault's door is the locked one, D-007's facade, until the Shell opens it
 * on shadow accounts (D-077); the map says which, this module only reads it.
 * A locked door never "opens", so it emits only on entry and nothing on exit —
 * there is no interior to leave. Moving within a multi-tile door does not
 * re-emit; only a change of occupied building does. The lobby is never told any
 * of this: entering a building leaves lobby presence (D-019), but that is the
 * shell's job — the world emits the semantic event and no building id ever
 * reaches lobby traffic from here.
 *
 * No network I/O, no wallet, no money. This module cannot import any of that.
 */

import type { EventBus, WorldEvents, BuildingId } from '@strkworld/shared';
import { doorAt, type DistrictMap, type DoorZone } from './map/street.js';

/** The scene reports a tile; the trigger decides what, if anything, to emit. */
export interface DoorTrigger {
  /** Call when the player's tile changes. Idempotent within one door zone. */
  update(tile: { x: number; y: number }): void;
  /**
   * Clear local occupancy without emitting an exit (room transitions use
   * this). With `holdMs`, a room exit: the re-entry hold (above) starts.
   */
  reset(options?: { readonly holdMs?: number }): void;
  /** Advance the re-entry hold by a frame's time, ms. */
  advance(deltaMs: number): void;
  /**
   * The building whose interior the player is currently inside, or null. A
   * locked door is never "inside" — the door read as closed. For assertions.
   */
  readonly inside: BuildingId | null;
}

/** How long after a room exit no door fires (session time, ms). */
export const DOOR_REENTRY_HOLD_MS = 250;

/**
 * The re-entry hold on its own, so a trigger that is not a door zone can take
 * the same rule. The Avatar Studio's hidden entrance is the other one (D-125):
 * its exit now returns the player to the street tile touching it, so a held
 * key would otherwise walk them straight back in.
 */
export interface ReentryHold<T> {
  /** Start the hold: for `holdMs` of advanced time, no trigger fires. */
  start(holdMs: number): void;
  /** Forget the swallowed trigger and the time left. */
  clear(): void;
  /** Advance the hold by a frame's time, ms. */
  advance(deltaMs: number): void;
  /**
   * Should the trigger at the player's new tile be swallowed? `next` is the
   * trigger there, or null for none; `inside` says the player is already
   * within one, in which case nothing is held (they are leaving, not entering).
   * Call this on every tile change: it is what releases a held trigger once
   * the player steps off it.
   */
  swallows(next: T | null, inside: boolean): boolean;
}

export function createReentryHold<T>(
  same: (a: T, b: T) => boolean = Object.is,
): ReentryHold<T> {
  let msLeft = 0;
  let held: T | null = null;
  return {
    start(holdMs) {
      held = null;
      if (Number.isFinite(holdMs) && holdMs > 0) msLeft = holdMs;
    },
    clear() {
      held = null;
    },
    advance(deltaMs) {
      if (msLeft <= 0 || !Number.isFinite(deltaMs) || deltaMs <= 0) return;
      msLeft = Math.max(0, msLeft - deltaMs);
    },
    swallows(next, inside) {
      if (held !== null) {
        // Still on the trigger the hold swallowed: it stays shut until
        // stepped off, even once the time has run out.
        if (next !== null && same(held, next)) return true;
        held = null;
      }
      if (next !== null && !inside && msLeft > 0) {
        held = next;
        return true;
      }
      return false;
    },
  };
}

/** The minimal emit surface this needs — the world's outbound bus. */
type WorldEmit = Pick<EventBus<WorldEvents>, 'emit'>;

export function createDoorTrigger(map: DistrictMap, out: WorldEmit): DoorTrigger {
  // The door zone the player currently occupies, or null. Identity is the
  // building id: this map has exactly one door per building and no overlaps.
  let active: DoorZone | null = null;
  let transition = 0;
  const hold = createReentryHold<DoorZone>((a, b) => a.building === b.building);

  function sameZone(a: DoorZone | null, b: DoorZone | null): boolean {
    if (a === null || b === null) return a === b;
    return a.building === b.building;
  }

  return {
    update(tile) {
      const next = doorAt(map, tile.x, tile.y);
      if (hold.swallows(next, active !== null)) return;
      if (sameZone(active, next)) return;

      const ownTransition = ++transition;
      const previous = active;
      const emit = (callback: () => void): void => {
        try {
          callback();
        } catch (error) {
          // Event delivery is an external lifecycle boundary. If it fails
          // without a newer nested transition taking ownership, restore the
          // prior occupancy so the caller can retry the transition.
          if (transition === ownTransition) active = previous;
          throw error;
        }
      };
      // Commit the new occupancy before synchronous event delivery. A listener
      // may immediately report another tile or reset the trigger; the version
      // check below prevents this transition from overwriting that newer state.
      active = next;

      // Leaving a door the player had actually entered. A locked door was never
      // entered, so there is nothing to exit.
      if (previous && !previous.locked) {
        emit(() => out.emit('building:exited', { building: previous.building }));
        if (transition !== ownTransition) return;
      }

      if (next) {
        if (next.locked) {
          emit(() => out.emit(
            'building:locked',
            { building: next.building, reason: 'coming-soon' },
          ));
        } else {
          emit(() => out.emit('building:entered', { building: next.building }));
        }
        if (transition !== ownTransition) return;
      }
    },

    reset(options) {
      transition += 1;
      active = null;
      hold.clear();
      const holdMs = options?.holdMs;
      if (typeof holdMs === 'number') hold.start(holdMs);
    },

    advance(deltaMs) {
      hold.advance(deltaMs);
    },

    get inside() {
      return active && !active.locked ? active.building : null;
    },
  };
}
