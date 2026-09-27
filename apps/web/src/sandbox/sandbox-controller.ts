import type { EventBus, SandboxSnapshot, SandboxTile, WorldEvents } from '@strkworld/shared';
import type { SandboxChannel } from '@strkworld/world';
import {
  SANDBOX_FAST_SPAWN_LIMIT,
  SANDBOX_SLOW_SPAWN_INTERVAL_MS,
  SANDBOX_SPAWN_INTERVAL_MS,
  createSandboxAuthority,
  type SandboxAuthority,
  type SandboxPlayer,
} from '@strkworld/lobby/sandbox';

/**
 * The Shell side of the block sandbox (D-060).
 *
 * The World receives one stable `SandboxChannel`. Behind it, the lobby is the
 * authority whenever a lobby connection is open, so every player sees the same
 * blocks; otherwise the same pure rules run here for solo play. Switching
 * backends never changes the channel object the World holds.
 */

/** The subset of `LobbyClient` the sandbox needs. */
export interface SandboxLobbyClient {
  sandbox(): SandboxSnapshot;
  onSandbox(listener: (snapshot: SandboxSnapshot) => void): () => void;
  onSandboxDrop(listener: (tile: SandboxTile) => void): () => void;
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
  let snapshot: SandboxSnapshot = authority.snapshotFor(LOCAL_PLAYER);
  let player: SandboxPlayer | null = null;
  let away = false;
  let destroyed = false;
  let spawnTimer: unknown = null;

  /** The lobby client currently acting as authority, if any. */
  let lobby: { readonly client: SandboxLobbyClient; readonly stop: () => void } | null = null;
  const adopted = new Map<SandboxLobbyClient, () => void>();

  const publish = (next: SandboxSnapshot): void => {
    snapshot = next;
    for (const listener of [...listeners]) listener(next);
  };
  const emitDrop = (tile: SandboxTile): void => {
    for (const listener of [...dropListeners]) listener(tile);
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
      // Like the lobby room, only rain blocks while a player is out on the street.
      if (player && !away) {
        const tile = authority.spawn([player]);
        if (tile) {
          // The hint must precede the state that contains the block, or the
          // renderer settles it from a short drop instead of the sky.
          emitDrop(tile);
          publish(authority.snapshotFor(LOCAL_PLAYER));
        }
      }
      scheduleSpawn();
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
    const stopState = client.onSandbox((next) => {
      if (lobby?.client === client) publish(next);
    });
    const stopDrops = client.onSandboxDrop((tile) => {
      if (lobby?.client === client) emitDrop(tile);
    });
    lobby = {
      client,
      stop: () => {
        stopState();
        stopDrops();
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
      if (player && !away && authority.place(player, tile, [])) {
        publish(authority.snapshotFor(LOCAL_PLAYER));
      }
    },
  });

  const leaveStreet = (): void => {
    away = true;
    // The lobby discards a carried block on suspend; mirror that when solo.
    if (!lobby && authority.carrying(LOCAL_PLAYER) !== null) {
      authority.release(LOCAL_PLAYER);
      publish(authority.snapshotFor(LOCAL_PLAYER));
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
      const stopStatus = client.onStatus((event) => {
        if (destroyed) return;
        if (event.status === 'connected' || event.status === 'suspended') useLobby(client);
        else if (event.status === 'closed') useLocal(client);
      });
      adopted.set(client, stopStatus);
      return client;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stopSpawning();
      lobby?.stop();
      lobby = null;
      for (const stop of adopted.values()) stop();
      adopted.clear();
      listeners.clear();
      dropListeners.clear();
    },
  };
}
