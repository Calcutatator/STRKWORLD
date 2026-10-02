import type { EventBus, Position, SandboxSnapshot, SandboxTile, WorldEvents } from '@strkworld/shared';
import type { SandboxChannel } from '@strkworld/world';
import {
  SANDBOX_FAST_SPAWN_LIMIT,
  SANDBOX_SLOW_SPAWN_INTERVAL_MS,
  SANDBOX_SPAWN_INTERVAL_MS,
  createSandboxAuthority,
  isSandboxBurst,
  type SandboxAuthority,
  type SandboxLanding,
  type SandboxPlayer,
} from '@strkworld/lobby/sandbox';
import { debugSandboxBurst } from '../debug/debug-tap.js';

/**
 * The Shell side of the block sandbox (D-060).
 *
 * The World receives one stable `SandboxChannel`. Behind it, the lobby is the
 * authority whenever a lobby connection is open, so every player sees the same
 * blocks; otherwise the same pure rules run here for solo play. Switching
 * backends never changes the channel object the World holds.
 *
 * A pillar taller than `SANDBOX_BURST_HEIGHT` bursts the sandbox (D-071).
 * Either backend announces the burst before the state that empties the board,
 * so the World can throw the blocks it still draws.
 */

/** The subset of `LobbyClient` the sandbox needs. */
export interface SandboxLobbyClient {
  sandbox(): SandboxSnapshot;
  onSandbox(listener: (snapshot: SandboxSnapshot) => void): () => void;
  onSandboxDrop(listener: (tile: SandboxTile) => void): () => void;
  /** D-071 bursts. Optional: without it a burst's blocks just pop out with the state. */
  onSandboxBurst?(listener: (tile: SandboxTile) => void): () => void;
  /** D-106 resyncs after a refused climb. Optional: without it the World is never corrected. */
  onResync?(listener: (position: Position) => void): () => void;
  pickBlock(tile: SandboxTile): void;
  placeBlock(tile: SandboxTile): void;
  onStatus(listener: (event: { readonly status: string }) => void): () => void;
}

export interface SandboxController {
  readonly channel: SandboxChannel;
  /** Follow the local player on the World bus; solo validation needs positions. */
  listen(world: Pick<EventBus<WorldEvents>, 'on'>): () => void;
  /** Adopt each lobby client as it is created; its connection picks the backend. */
  adopt<T>(client: T): T;
  destroy(): void;
}

export interface SandboxControllerOptions {
  readonly random?: () => number;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

const LOCAL_PLAYER = 'local';

function isSandboxClient(value: unknown): value is SandboxLobbyClient {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<Record<keyof SandboxLobbyClient, unknown>>;
  return (
    typeof candidate.sandbox === 'function' &&
    typeof candidate.onSandbox === 'function' &&
    typeof candidate.onSandboxDrop === 'function' &&
    typeof candidate.pickBlock === 'function' &&
    typeof candidate.placeBlock === 'function' &&
    typeof candidate.onStatus === 'function'
  );
}

export function createSandboxController(options: SandboxControllerOptions = {}): SandboxController {
  const setTimer = options.setTimer ?? ((callback, ms) => globalThis.setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle) => globalThis.clearTimeout(handle as never));
  const authority: SandboxAuthority = createSandboxAuthority({ random: options.random });
  const listeners = new Set<(snapshot: SandboxSnapshot) => void>();
  const dropListeners = new Set<(tile: SandboxTile) => void>();
  const burstListeners = new Set<(tile: SandboxTile) => void>();
  const resyncListeners = new Set<(position: Position) => void>();
  let snapshot: SandboxSnapshot = authority.snapshotFor(LOCAL_PLAYER);
  let player: SandboxPlayer | null = null;
  let away = false;
  let destroyed = false;
  let spawnTimer: unknown = null;

  /** The lobby client currently acting as authority, if any. */
  let lobby: { readonly client: SandboxLobbyClient; readonly stop: () => void } | null = null;
  const adopted = new Map<SandboxLobbyClient, { stop: () => void; status: string }>();

  /** Every listener hears every change; the first failure surfaces afterwards. */
  const notify = <T>(targets: ReadonlySet<(value: T) => void>, value: T): void => {
    const errors: unknown[] = [];
    for (const listener of [...targets]) {
      try {
        listener(value);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'Sandbox listener failed');
  };
  const publish = (next: SandboxSnapshot): void => {
    snapshot = next;
    notify(listeners, next);
  };
  const emitDrop = (tile: SandboxTile): void => {
    notify(dropListeners, tile);
  };
  const emitBurst = (tile: SandboxTile): void => {
    debugSandboxBurst(tile);
    notify(burstListeners, tile);
  };

  /**
   * Publish a block that joined a column in solo play, in the lobby's order: a
   * sky drop's hint follows the state that holds it, and a burst is announced
   * before the state that empties the board — which still goes out if a burst
   * listener throws.
   */
  const settle = (landing: SandboxLanding, fell: boolean): void => {
    if (isSandboxBurst(landing)) {
      try {
        emitBurst(landing.burst);
      } finally {
        publish(authority.snapshotFor(LOCAL_PLAYER));
      }
      return;
    }
    publish(authority.snapshotFor(LOCAL_PLAYER));
    if (fell) emitDrop(landing);
  };

  // -- solo authority ---------------------------------------------------------

  const scheduleSpawn = (): void => {
    if (destroyed || lobby || spawnTimer !== null) return;
    const interval = authority.totalBlocks < SANDBOX_FAST_SPAWN_LIMIT
      ? SANDBOX_SPAWN_INTERVAL_MS
      : SANDBOX_SLOW_SPAWN_INTERVAL_MS;
    spawnTimer = setTimer(() => {
      spawnTimer = null;
      if (destroyed || lobby) return;
      try {
        // Like the lobby room, only rain blocks while a player is out on the street.
        if (player && !away) {
          const landing = authority.spawn([player]);
          // Same order as the lobby: the state first, then the sky-drop hint,
          // which the renderer applies to the block now arriving.
          if (landing) settle(landing, true);
        }
      } finally {
        // A throwing listener must not end the rain for the rest of the session.
        scheduleSpawn();
      }
    }, interval);
  };

  const stopSpawning = (): void => {
    if (spawnTimer === null) return;
    clearTimer(spawnTimer);
    spawnTimer = null;
  };

  // -- lobby authority ----------------------------------------------------------

  const useLobby = (client: SandboxLobbyClient): void => {
    if (lobby?.client === client) return;
    lobby?.stop();
    stopSpawning();
    // A block carried in solo play does not travel into the shared room, and
    // must not reappear if the connection later drops back to solo.
    if (authority.carrying(LOCAL_PLAYER) !== null) authority.release(LOCAL_PLAYER);
    const stopState = client.onSandbox((next) => {
      if (lobby?.client === client) publish(next);
    });
    const stopDrops = client.onSandboxDrop((tile) => {
      if (lobby?.client === client) emitDrop(tile);
    });
    const stopBursts = typeof client.onSandboxBurst === 'function'
      ? client.onSandboxBurst((tile) => {
        if (lobby?.client === client) emitBurst(tile);
      })
      : () => undefined;
    // D-106: only the lobby refuses a climb; solo play predicts the same rule.
    const stopResync = typeof client.onResync === 'function'
      ? client.onResync((position) => {
        if (lobby?.client === client) notify(resyncListeners, position);
      })
      : () => undefined;
    lobby = {
      client,
      stop: () => {
        stopState();
        stopDrops();
        stopBursts();
        stopResync();
      },
    };
    publish(client.sandbox());
  };

  const useLocal = (client: SandboxLobbyClient): void => {
    if (lobby?.client !== client) return;
    const current = lobby;
    lobby = null;
    current.stop();
    // A dropped connection falls back to this player's own solo sandbox.
    publish(authority.snapshotFor(LOCAL_PLAYER));
    scheduleSpawn();
  };

  const channel: SandboxChannel = Object.freeze({
    subscribe(listener: (snapshot: SandboxSnapshot) => void): () => void {
      listeners.add(listener);
      listener(snapshot);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeDrops(listener: (tile: SandboxTile) => void): () => void {
      dropListeners.add(listener);
      return () => {
        dropListeners.delete(listener);
      };
    },
    subscribeBursts(listener: (tile: SandboxTile) => void): () => void {
      burstListeners.add(listener);
      return () => {
        burstListeners.delete(listener);
      };
    },
    subscribeResync(listener: (position: Position) => void): () => void {
      resyncListeners.add(listener);
      return () => {
        resyncListeners.delete(listener);
      };
    },
    pick(tile: SandboxTile): void {
      if (destroyed) return;
      if (lobby) {
        lobby.client.pickBlock(tile);
        return;
      }
      if (player && !away && authority.pick(player, tile, [])) {
        publish(authority.snapshotFor(LOCAL_PLAYER));
      }
    },
    place(tile: SandboxTile): void {
      if (destroyed) return;
      if (lobby) {
        lobby.client.placeBlock(tile);
        return;
      }
      if (!player || away) return;
      const landing = authority.place(player, tile, []);
      if (landing) settle(landing, false);
    },
  });

  const leaveStreet = (): void => {
    away = true;
    // Blocks are conserved (D-060): like the lobby on suspend, a carried block
    // falls back onto the board, away from where the player stood.
    if (!lobby && authority.carrying(LOCAL_PLAYER) !== null) {
      const landing = player ? authority.returnCarried(LOCAL_PLAYER, [player]) : null;
      if (!player) authority.release(LOCAL_PLAYER);
      if (landing) settle(landing, true);
      else publish(authority.snapshotFor(LOCAL_PLAYER));
    }
  };

  scheduleSpawn();

  return {
    channel,
    listen(world) {
      const stops = [
        world.on('player:moved', (payload) => {
          const position = (payload as WorldEvents['player:moved'] | undefined)?.position;
          if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return;
          player = Object.freeze({ key: LOCAL_PLAYER, x: position.x, y: position.y });
        }),
        world.on('building:entered', leaveStreet),
        world.on('avatar-studio:entered', leaveStreet),
        world.on('building:exited', () => {
          away = false;
        }),
        world.on('avatar-studio:exited', () => {
          away = false;
        }),
      ];
      return () => {
        for (const stop of stops) stop();
      };
    },
    adopt<T>(client: T): T {
      if (destroyed || !isSandboxClient(client) || adopted.has(client)) return client;
      // Presence replaces its client on reconnects; forget replaced clients
      // that have already closed, so the adopted set cannot grow forever.
      for (const [previous, entry] of adopted) {
        if (entry.status !== 'closed' || lobby?.client === previous) continue;
        adopted.delete(previous);
        entry.stop();
      }
      const entry: { stop: () => void; status: string } = { stop: () => {}, status: 'idle' };
      adopted.set(client, entry);
      const stopStatus = client.onStatus((event) => {
        if (destroyed) return;
        entry.status = event.status;
        if (event.status === 'connected' || event.status === 'suspended') useLobby(client);
        else if (event.status === 'closed') useLocal(client);
      });
      entry.stop = stopStatus;
      return client;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stopSpawning();
      lobby?.stop();
      lobby = null;
      for (const entry of adopted.values()) entry.stop();
      adopted.clear();
      listeners.clear();
      dropListeners.clear();
      burstListeners.clear();
      resyncListeners.clear();
    },
  };
}
