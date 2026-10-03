import {
  normalizeArenaRing,
  type ArenaRingSnapshot,
  type ArenaTile,
  type EventBus,
  type Facing,
  type GameId,
  type PresenceArea,
  type WorldEvents,
  arenaTileCentre,
} from '@strkworld/shared';
import type { ArenaChannel } from '@strkworld/world';

/**
 * The Shell side of the gladiator pit's ring (D-114).
 *
 * The World receives one stable `ArenaChannel`. Behind it the lobby is the
 * authority whenever a lobby connection is open, so everyone in the arena
 * sees the same ring; otherwise the same rules (`@strkworld/lobby/arena`'s
 * authority, injected as `solo`) run here for solo play while the player is
 * in the arena. Switching backends never changes the channel the World holds.
 *
 * The channel only carries intents out and validated snapshots in. Nothing
 * here decides a hit: the lobby (or the solo authority, running the lobby's
 * own rules) does, and every snapshot passes `normalizeArenaRing` before
 * anyone sees it. No money, name or address is involved anywhere.
 *
 * The HUD reads the same channel, plus `strike()` (its STRIKE button, which
 * the World's session takes through its own click path when it is
 * listening), D-128's `guard(down)` (its BLOCK button, the same way through
 * the World's own Q path) and `inArena()`.
 */

/** The subset of `LobbyClient` the arena needs (B's client API, D-114 §7.3). */
export interface ArenaLobbyClient {
  arena(): ArenaRingSnapshot | null;
  onArena(listener: (ring: ArenaRingSnapshot | null) => void): () => void;
  arenaClaim(): boolean;
  arenaAttack(): boolean;
  arenaLeave(): boolean;
  /** D-128: raise or lower the guard, and the champion's press at the box. */
  arenaBlock(down: boolean): boolean;
  arenaSit(): boolean;
  onStatus(listener: (event: { readonly status: string }) => void): () => void;
  readonly gameId: GameId | null;
}

/** Where the local player stands and faces, as the solo authority looks it up. */
export interface SoloArenaStance {
  readonly x: number;
  readonly y: number;
  readonly facing: Facing;
}

/**
 * The solo authority: structurally the lobby's `ArenaAuthority`
 * (`@strkworld/lobby/arena`), so solo play runs the lobby's own rules.
 */
export interface SoloArenaAuthority {
  snapshot(now: number): ArenaRingSnapshot;
  readonly active: boolean;
  claim(
    claimant: { readonly key: string; readonly gameId: GameId; readonly area: PresenceArea | null; readonly x: number; readonly y: number },
    now: number,
  ): string;
  attack(key: string, now: number, locate: (key: string) => SoloArenaStance | null): string;
  /** D-128: the solo player's guard, and their press at the emperor's box. */
  block(key: string, down: boolean, now: number): string;
  seat(
    claimant: { readonly key: string; readonly gameId: GameId; readonly area: PresenceArea | null; readonly x: number; readonly y: number },
    now: number,
  ): string;
  leave(key: string, now: number): string;
  gone(key: string, reason: 'left' | 'disconnect', now: number): boolean;
  advance(now: number): ReadonlyArray<{ readonly kind: string; readonly key: string; readonly tile: ArenaTile; readonly facing: Facing }>;
}

/** The channel the World and the HUD hold. */
export interface ArenaShellChannel extends ArenaChannel {
  /** The HUD's STRIKE: through the World's click path when it listens, else straight to the authority. */
  strike(): void;
  /**
   * D-128: the HUD's touch BLOCK, the same way — through the World's own Q
   * path when it listens, else straight to the authority.
   */
  guard(down: boolean): void;
  /** Whether the local player is in the arena (the HUD shows nothing elsewhere). */
  inArena(): boolean;
}

export interface ArenaController {
  readonly channel: ArenaShellChannel;
  /** Follow the local player on the World bus: whether they are in the arena, and where. */
  listen(world: Pick<EventBus<WorldEvents>, 'on'>): () => void;
  /** Adopt each lobby client as it is created; its connection picks the backend. */
  adopt<T>(client: T): T;
  destroy(): void;
}

export interface ArenaControllerOptions {
  /** Builds the solo authority (the lobby's rules). Absent: no solo ring, so offline the arena is a room to walk. */
  readonly solo?: () => SoloArenaAuthority;
  /** The clock, in ms. `performance.now` by default. */
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

/** The solo player's key and stand-in presence id. Never on any wire. */
const SOLO_KEY = 'local';
export const SOLO_ARENA_ID = 'solo' as GameId;
/** The solo ring's clock: deadlines and the seconds left, stepped this often while a fight runs. */
export const SOLO_ARENA_TICK_MS = 100;

function isArenaClient(value: unknown): value is ArenaLobbyClient {
  if (value === null || typeof value !== 'object') return false;
  const c = value as Partial<Record<keyof ArenaLobbyClient, unknown>>;
  return (
    typeof c.arena === 'function' &&
    typeof c.onArena === 'function' &&
    typeof c.arenaClaim === 'function' &&
    typeof c.arenaAttack === 'function' &&
    typeof c.arenaLeave === 'function' &&
    // D-128: a client without the block and the box is not one the arena can adopt.
    typeof c.arenaBlock === 'function' &&
    typeof c.arenaSit === 'function' &&
    typeof c.onStatus === 'function'
  );
}

/** Two snapshots that read the same. Tiny frozen objects: a field walk is enough. */
function sameRing(a: ArenaRingSnapshot | null, b: ArenaRingSnapshot | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  const slot = (x: ArenaRingSnapshot['challenger'], y: ArenaRingSnapshot['challenger']) =>
    x.kind === y.kind && x.gameId === y.gameId && x.hp === y.hp && x.swings === y.swings && x.hits === y.hits &&
    x.guarding === y.guarding && x.blocks === y.blocks;
  return (
    a.phase === b.phase && a.round === b.round && a.secondsLeft === b.secondsLeft &&
    a.champion === b.champion && a.seated === b.seated &&
    slot(a.challenger, b.challenger) && slot(a.opponent, b.opponent) &&
    (a.outcome?.reason ?? null) === (b.outcome?.reason ?? null) &&
    (a.outcome?.winner ?? null) === (b.outcome?.winner ?? null)
  );
}

function validated(value: unknown): ArenaRingSnapshot | null {
  try {
    return normalizeArenaRing(value);
  } catch {
    return null;
  }
}

export function createArenaController(options: ArenaControllerOptions = {}): ArenaController {
  const clock = options.now ?? (() => globalThis.performance.now());
  const setTimer = options.setTimer ?? ((callback, ms) => globalThis.setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle) => globalThis.clearTimeout(handle as never));
  const authority: SoloArenaAuthority | null = options.solo ? options.solo() : null;
  const listeners = new Set<(ring: ArenaRingSnapshot | null) => void>();
  const strikeListeners = new Set<() => void>();
  /** D-128: the World's listeners for the HUD's touch BLOCK. */
  const blockListeners = new Set<(down: boolean) => void>();
  let destroyed = false;
  let inArena = false;
  let here: SoloArenaStance | null = null;
  let published: ArenaRingSnapshot | null = null;
  /** The last value `ring()` returned. */
  let lastRead: ArenaRingSnapshot | null = null;
  let tickTimer: unknown = null;
  let lobby: { readonly client: ArenaLobbyClient; stop: () => void } | null = null;
  const adopted = new Map<ArenaLobbyClient, { stop: () => void; status: string }>();

  /** Hand every listener the ring when it reads differently; the first failure surfaces afterwards. */
  const publish = (next: ArenaRingSnapshot | null): void => {
    if (sameRing(published, next)) return;
    published = next;
    if (!sameRing(lastRead, next)) lastRead = next;
    const errors: unknown[] = [];
    for (const listener of [...listeners]) {
      try {
        listener(next);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'Arena listener failed');
  };

  // -- solo ----------------------------------------------------------------------

  const soloRing = (): ArenaRingSnapshot | null => {
    if (authority === null || lobby !== null || !inArena) return null;
    return validated(authority.snapshot(clock()));
  };

  const stopTicking = (): void => {
    if (tickTimer === null) return;
    clearTimer(tickTimer);
    tickTimer = null;
  };

  /** Run the solo deadlines up to now and apply its `place` events (the solo player's own moves). */
  const advanceSolo = (now: number): void => {
    if (authority === null) return;
    for (const event of authority.advance(now)) {
      // The solo authority moves its own player; the World snaps itself from the ring.
      if (event.kind === 'place' && event.key === SOLO_KEY) {
        const centre = arenaTileCentre(event.tile);
        here = { x: centre.x, y: centre.y, facing: event.facing };
      }
    }
  };

  const tick = (): void => {
    tickTimer = null;
    if (destroyed || authority === null || lobby !== null) return;
    try {
      advanceSolo(clock());
      publish(soloRing());
    } finally {
      schedule();
    }
  };

  const schedule = (): void => {
    if (destroyed || authority === null || lobby !== null || tickTimer !== null) return;
    if (!authority.active) return;
    tickTimer = setTimer(tick, SOLO_ARENA_TICK_MS);
  };

  const soloAct = (act: (auth: SoloArenaAuthority, now: number) => void): void => {
    if (authority === null || lobby !== null || !inArena) return;
    const now = clock();
    act(authority, now);
    // As the lobby does after each intent: the claim's move into the ring, at once.
    advanceSolo(now);
    publish(soloRing());
    schedule();
  };

  // -- the lobby -------------------------------------------------------------------

  const useLobby = (client: ArenaLobbyClient): void => {
    if (lobby?.client === client) return;
    lobby?.stop();
    stopTicking();
    // A solo fight in progress ends: the lobby is the authority now.
    if (authority !== null && inArena) authority.gone(SOLO_KEY, 'disconnect', clock());
    const current: { readonly client: ArenaLobbyClient; stop: () => void } = { client, stop: () => {} };
    lobby = current;
    const stop = client.onArena((ring) => {
      if (lobby?.client !== client) return;
      publish(validated(ring));
    });
    current.stop = stop;
    if (lobby?.client === client) publish(validated(client.arena()));
  };

  const useLocal = (client: ArenaLobbyClient): void => {
    if (lobby?.client !== client) return;
    const current = lobby;
    lobby = null;
    current.stop();
    publish(soloRing());
    schedule();
  };

  const selfId = (): GameId | null => {
    if (lobby) {
      try {
        return lobby.client.gameId ?? null;
      } catch {
        return null;
      }
    }
    return authority !== null ? SOLO_ARENA_ID : null;
  };

  const attack = (): void => {
    if (destroyed) return;
    if (lobby) {
      lobby.client.arenaAttack();
      return;
    }
    soloAct((auth, now) => {
      auth.attack(SOLO_KEY, now, (key) => (key === SOLO_KEY ? here : null));
    });
  };

  /** D-128: the block, to the lobby when it is the authority and to the solo ring otherwise. */
  const block = (down: boolean): void => {
    if (destroyed) return;
    if (lobby) {
      lobby.client.arenaBlock(down === true);
      return;
    }
    soloAct((auth, now) => {
      auth.block(SOLO_KEY, down === true, now);
    });
  };

  const channel: ArenaShellChannel = Object.freeze({
    ring(): ArenaRingSnapshot | null {
      if (destroyed) return null;
      const next = lobby ? validated(lobby.client.arena()) : soloRing();
      // The same reading returns the same object, so React's external store stays still.
      if (!sameRing(lastRead, next)) lastRead = next;
      return lastRead;
    },
    subscribe(listener: (ring: ArenaRingSnapshot | null) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    selfId,
    claim(): void {
      if (destroyed) return;
      if (lobby) {
        lobby.client.arenaClaim();
        return;
      }
      soloAct((auth, now) => {
        if (here === null) return;
        auth.claim({ key: SOLO_KEY, gameId: SOLO_ARENA_ID, area: 'arena', x: here.x, y: here.y }, now);
      });
    },
    attack,
    leave(): void {
      if (destroyed) return;
      if (lobby) {
        lobby.client.arenaLeave();
        return;
      }
      soloAct((auth, now) => {
        auth.leave(SOLO_KEY, now);
      });
    },
    block,
    sit(): void {
      if (destroyed) return;
      if (lobby) {
        lobby.client.arenaSit();
        return;
      }
      soloAct((auth, now) => {
        if (here === null) return;
        auth.seat({ key: SOLO_KEY, gameId: SOLO_ARENA_ID, area: 'arena', x: here.x, y: here.y }, now);
      });
    },
    subscribeStrikes(listener: () => void): () => void {
      strikeListeners.add(listener);
      return () => {
        strikeListeners.delete(listener);
      };
    },
    subscribeBlocks(listener: (down: boolean) => void): () => void {
      blockListeners.add(listener);
      return () => {
        blockListeners.delete(listener);
      };
    },
    strike(): void {
      if (destroyed) return;
      if (strikeListeners.size === 0) {
        attack();
        return;
      }
      for (const listener of [...strikeListeners]) {
        try {
          listener();
        } catch {
          // One failing listener does not stop the strike reaching the rest.
        }
      }
    },
    guard(down: boolean): void {
      if (destroyed) return;
      if (blockListeners.size === 0) {
        block(down === true);
        return;
      }
      for (const listener of [...blockListeners]) {
        try {
          listener(down === true);
        } catch {
          // As with STRIKE: one failing listener does not stop the rest.
        }
      }
    },
    inArena: () => inArena && !destroyed,
  });

  const enter = (building: unknown): void => {
    if (building !== 'arena') return;
    inArena = true;
    if (!lobby) publish(soloRing());
  };
  const exit = (building: unknown): void => {
    if (building !== 'arena') return;
    if (authority !== null && !lobby) authority.gone(SOLO_KEY, 'left', clock());
    inArena = false;
    here = null;
    if (!lobby) {
      stopTicking();
      publish(null);
    }
  };

  return {
    channel,
    listen(world) {
      const stops = [
        world.on('building:entered', (payload) => enter((payload as WorldEvents['building:entered'] | undefined)?.building)),
        world.on('building:exited', (payload) => exit((payload as WorldEvents['building:exited'] | undefined)?.building)),
        world.on('area:moved', (payload) => {
          const moved = payload as WorldEvents['area:moved'] | undefined;
          const position = moved?.position;
          if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return;
          const facing: Facing = moved?.facing === 'up' || moved?.facing === 'left' || moved?.facing === 'right' ? moved.facing : 'down';
          // Only the arena's own coordinates: the roof and the Studio publish here too.
          here = { x: position.x, y: position.y, facing };
        }),
      ];
      return () => {
        for (const stop of stops) stop();
      };
    },
    adopt<T>(client: T): T {
      if (destroyed || !isArenaClient(client) || adopted.has(client)) return client;
      // Presence replaces its client on reconnects; forget closed ones.
      for (const [previous, entry] of adopted) {
        if (entry.status !== 'closed' || lobby?.client === previous) continue;
        adopted.delete(previous);
        entry.stop();
      }
      const entry: { stop: () => void; status: string } = { stop: () => {}, status: 'idle' };
      adopted.set(client, entry);
      entry.stop = client.onStatus((event) => {
        if (destroyed) return;
        entry.status = event.status;
        if (event.status === 'connected' || event.status === 'suspended') useLobby(client);
        else if (event.status === 'closed') useLocal(client);
      });
      return client;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stopTicking();
      lobby?.stop();
      lobby = null;
      for (const entry of adopted.values()) entry.stop();
      adopted.clear();
      listeners.clear();
      strikeListeners.clear();
      blockListeners.clear();
    },
  };
}
