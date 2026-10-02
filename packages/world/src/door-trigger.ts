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

/** The minimal emit surface this needs — the world's outbound bus. */
type WorldEmit = Pick<EventBus<WorldEvents>, 'emit'>;

export function createDoorTrigger(map: DistrictMap, out: WorldEmit): DoorTrigger {
  // The door zone the player currently occupies, or null. Identity is the
  // building id: this map has exactly one door per building and no overlaps.
  let active: DoorZone | null = null;
  let transition = 0;
  // The re-entry hold: time left, and the door swallowed while it ran.
  let holdMs = 0;
  let held: DoorZone | null = null;

  function sameZone(a: DoorZone | null, b: DoorZone | null): boolean {
    if (a === null || b === null) return a === b;
    return a.building === b.building;
  }

  return {
    update(tile) {
      const next = doorAt(map, tile.x, tile.y);
      if (held !== null) {
        // Still on the door the hold swallowed: it stays shut until stepped off.
        if (sameZone(held, next)) return;
        held = null;
      }
      if (next !== null && active === null && holdMs > 0) {
        held = next;
        return;
      }
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
      held = null;
      const hold = options?.holdMs;
      if (typeof hold === 'number' && Number.isFinite(hold) && hold > 0) holdMs = hold;
    },

    advance(deltaMs) {
      if (holdMs <= 0 || !Number.isFinite(deltaMs) || deltaMs <= 0) return;
      holdMs = Math.max(0, holdMs - deltaMs);
    },

    get inside() {
      return active && !active.locked ? active.building : null;
    },
  };
}
