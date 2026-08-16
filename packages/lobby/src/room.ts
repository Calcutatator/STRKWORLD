/**
 * The Colyseus room. Wiring only — every rule lives in `presence.ts` and
 * `policy.ts`.
 *
 * The room's whole client-facing surface is three message types and a join
 * payload, and none of them has a field for anything the lobby is forbidden
 * to hold. That is the enforcement: not a filter that strips money out of
 * traffic, but a surface with nowhere to put it.
 *
 * Reconnection tokens are deliberately not used. A reconnection token would
 * be an identifier that outlives a connection, and the point of an ephemeral
 * session is that nothing does.
 */

import { Room, ServerError, type Client } from '@colyseus/core';
import { StateView } from '@colyseus/schema';
import {
  MAX_CLIENTS_PER_ROOM,
  MAX_MESSAGES_PER_SECOND,
  MESSAGE,
  PATCH_RATE_MS,
} from './config';
import {
  LobbyPresence,
  type LobbyPresenceOptions,
  type MoveRequest,
  type PlacementRequest,
  type PresenceCounters,
} from './presence';
import type { LobbyState, PresenceEntry } from './state';

/**
 * Close code used when a join is refused.
 *
 * The reason travels as a plain word — `malformed-id`, `at-capacity` — which
 * is useful to a client author and says nothing about any player.
 */
export const PRESENCE_REFUSED = 4400;

/**
 * Room options, passed at `define()` time.
 *
 * `spriteKeys` is the one the World lane will want: hand it the asset registry
 * and unknown keys stop falling back to the placeholder avatar.
 */
export interface PresenceRoomOptions extends LobbyPresenceOptions {
  capacity?: number;
}

export class PresenceRoom extends Room<{ state: LobbyState }> {
  #registry = new LobbyPresence();

  /** Aggregate counters for this room. Never per-connection. */
  get counters(): PresenceCounters {
    return this.#registry.counters();
  }

  override onCreate(options: PresenceRoomOptions = {}): void {
    this.#registry = new LobbyPresence(options);
    this.state = this.#registry.state;

    this.maxClients = options.capacity ?? MAX_CLIENTS_PER_ROOM;
    this.patchRate = PATCH_RATE_MS;
    this.autoDispose = true;

    /*
     * Two independent ceilings. The registry's throttle silently drops moves
     * that arrive too fast, because a superseded position is worthless; this
     * one disconnects a client that ignores the rate entirely. It sits well
     * above the throttle so a healthy client never meets it.
     */
    this.maxMessagesPerSecond = MAX_MESSAGES_PER_SECOND;

    this.onMessage(MESSAGE.move, (client: Client, payload: MoveRequest) => {
      const outcome = this.#registry.move(
        client.sessionId,
        payload ?? {},
        Date.now(),
      );
      if (outcome === 'applied') this.#syncViews();
    });

    this.onMessage(MESSAGE.suspend, (client: Client) => {
      if (this.#registry.suspend(client.sessionId)) this.#syncViews();
    });

    this.onMessage(MESSAGE.resume, (client: Client, payload: PlacementRequest) => {
      if (this.#registry.resume(client.sessionId, payload ?? {})) {
        this.#syncViews();
      }
    });
  }

  override onJoin(client: Client, options?: unknown): void {
    const outcome = this.#registry.admit(
      client.sessionId,
      (options ?? {}) as PlacementRequest,
    );
    if (!outcome.ok) {
      throw new ServerError(PRESENCE_REFUSED, outcome.reason);
    }
    client.view = new StateView();
    this.#syncViews();
  }

  override onLeave(client: Client): void {
    this.#registry.release(client.sessionId);
    this.#syncViews();
  }

  /**
   * Recompute every observer's interest set.
   *
   * Run after any change to the map, including an accepted move. That is
   * O(sessions²) per change, which sounds worse than it is: the room caps at
   * 48 sessions and the per-session rate floor caps moves at 20/second, so
   * the worst case is a few tens of thousands of coordinate comparisons per
   * second. Recomputing everything keeps the nearest-first cap exactly
   * correct, which an incremental update of only the mover would not.
   */
  #syncViews(): void {
    for (const client of this.clients) {
      const view = (client.view ??= new StateView());
      const wanted = new Set<PresenceEntry>(
        this.#registry.visibleTo(client.sessionId),
      );
      const own = this.#registry.entryFor(client.sessionId);
      if (own !== undefined) wanted.add(own);

      this.#registry.peers.forEach((entry) => {
        const visible = view.has(entry);
        if (wanted.has(entry)) {
          if (!visible) view.add(entry);
        } else if (visible) {
          view.remove(entry);
        }
      });
    }
  }
}
