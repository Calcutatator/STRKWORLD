/**
 * The Colyseus room. Wiring only — every rule lives in `presence.ts` and
 * `policy.ts`.
 *
 * The room's whole client-facing surface is three message types and a join
 * payload, and none of them has a field for anything the lobby is forbidden
 * to hold. That is the enforcement: not a filter that strips money out of
 * traffic, but a surface with nowhere to put it.
 *
 * ## Configuration is trusted; onCreate options are not
 *
 * Under Colyseus matchmaking, `onCreate` is called with
 * `merge({}, clientOptions, handlerOptions)` — and `clientOptions` is the join
 * payload of whichever client happened to create the room, i.e. attacker
 * input. When this room first shipped it read its config (sprite list,
 * capacity, interest radius, rate floor, world bounds) straight out of that
 * argument, so one unauthenticated `POST /matchmake/joinOrCreate` could set the
 * room's entire configuration — including a `spriteKeys`/`defaultSprite`
 * allowlist the attacker wrote, through which a hex id and a token amount
 * reached honest players' screens. That is a direct break of "the lobby never
 * sees money".
 *
 * The fix, defence in depth:
 *   1. This class reads config only from `this.roomConfig`, a field set at
 *      construction from a trusted source. Its `onCreate` argument is ignored
 *      for configuration entirely — treated as the untrusted input it is.
 *   2. `startPresenceServer` additionally passes the trusted config as
 *      define-time handler options, so even Colyseus's own merge favours it
 *      (handler options are merged last and win on key collision).
 *
 * A server operator configures the room through `definePresenceRoom(config)`
 * or `startPresenceServer({ room })`, both of which run in the trusted server
 * process. A client cannot reach either.
 *
 * Reconnection tokens are deliberately not used. A reconnection token would
 * be an identifier that outlives a connection, and the point of an ephemeral
 * session is that nothing does.
 */

import { Room, ServerError, type Client } from '@colyseus/core';
import { StateView } from '@colyseus/schema';
import type { GameId } from '@strkworld/shared';
import {
  DEFAULT_ROOM_CONFIG,
  MESSAGE,
  SERVER_MESSAGE,
  type PresenceRoomConfig,
} from './config';
import {
  LobbyPresence,
  type MoveRequest,
  type PlacementRequest,
  type PresenceCounters,
} from './presence';
import type { LobbyState, PresenceEntry } from './state';

/**
 * Close code used when a join is refused.
 *
 * The reason travels as a plain word — `at-capacity`, `bad-placement` — which
 * is useful to a client author and says nothing about any player.
 */
export const PRESENCE_REFUSED = 4400;

export class PresenceRoom extends Room<{ state: LobbyState }> {
  /**
   * The room's trusted configuration.
   *
   * A field, not an `onCreate` argument, so its value comes from the server
   * process at construction and never from a client's join payload. The base
   * class ships the frozen defaults; `definePresenceRoom` returns a subclass
   * that overrides this with an operator-resolved config.
   */
  protected roomConfig: PresenceRoomConfig = DEFAULT_ROOM_CONFIG;

  #registry = new LobbyPresence();

  /** Aggregate counters for this room. Never per-connection. */
  get counters(): PresenceCounters {
    return this.#registry.counters();
  }

  /**
   * @param _untrustedOptions — Colyseus passes `merge({}, clientOptions,
   * handlerOptions)` here. It is deliberately ignored: configuration comes from
   * `this.roomConfig`, and reading it from this argument is the exact bug the
   * class comment describes. The parameter is named to make an accidental read
   * of it stand out in review.
   */
  override onCreate(_untrustedOptions?: unknown): void {
    const config = this.roomConfig;
    this.#registry = new LobbyPresence(config);
    this.state = this.#registry.state;

    this.maxClients = config.capacity;
    this.patchRate = config.patchRateMs;
    this.autoDispose = true;

    /*
     * Two independent ceilings. The registry's throttle silently drops moves
     * that arrive too fast, because a superseded position is worthless; this
     * one disconnects a client that ignores the rate entirely. The client
     * wrapper floors its own send interval so it cannot reach this ceiling.
     */
    this.maxMessagesPerSecond = config.maxMessagesPerSecond;

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
      if (this.#registry.resume(client.sessionId, payload ?? {}, Date.now())) {
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
    // Tell the client the identifier the server minted for it, so it can find
    // its own avatar in the shared state. Nothing about any other player.
    client.send(SERVER_MESSAGE.welcome, { gameId: outcome.gameId satisfies GameId });
    this.#syncViews();
  }

  override onLeave(client: Client): void {
    // Colyseus also routes a failed onJoin through onLeave, so this must be
    // safe for a session the registry never admitted. release() is a no-op on
    // an unknown session, so it is.
    this.#registry.release(client.sessionId);
    this.#syncViews();
  }

  /**
   * Recompute every observer's interest set.
   *
   * Run after any change to the map, including an accepted move. That is
   * O(sessions²) per change, which sounds worse than it is: the room caps at
   * a few dozen sessions and the per-session rate floor caps moves at 20/second,
   * so the worst case is a few tens of thousands of coordinate comparisons per
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

/**
 * Build a room class bound to a trusted configuration.
 *
 * Returns a subclass whose `roomConfig` field is the given config, captured in
 * the class definition rather than passed through matchmaking. `server.define`
 * takes a class, so this is how the trusted server process hands a room its
 * configuration without any of it travelling as client-reachable options.
 */
export function definePresenceRoom(
  config: PresenceRoomConfig,
): typeof PresenceRoom {
  return class ConfiguredPresenceRoom extends PresenceRoom {
    protected override roomConfig = config;
  };
}
