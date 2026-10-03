import {
  normalizeRoofSwing,
  type EventBus,
  type GameId,
  type RoofSwingSnapshot,
  type RoofTile,
  type Facing,
  type PresenceArea,
  type WorldEvents,
  roofTileCentre,
} from '@strkworld/shared';
import type { RoofSwingChannel } from '@strkworld/world';

/**
 * The Shell side of the Exchange roof's lookout swing (D-131).
 *
 * The same shape as the arena's controller, and for the same reason: the
 * World receives one stable `RoofSwingChannel`, and behind it the lobby is
 * the authority whenever a lobby connection is open, so everyone on the roof
 * sees the same swing. Otherwise the lobby's own rules
 * (`@strkworld/lobby/swing`, injected as `solo`) run here for solo play.
 * Switching backends never changes the channel the World holds.
 *
 * The channel only carries intents out and validated snapshots in. Nothing
 * here decides who rides: the lobby (or the solo authority, running the
 * lobby's own rules) does, and every snapshot passes `normalizeRoofSwing`
 * before anyone sees it. No money, name or address is involved anywhere.
 */

/** The subset of `LobbyClient` the swing needs. */
export interface SwingLobbyClient {
  swing(): RoofSwingSnapshot | null;
  onSwing(listener: (swing: RoofSwingSnapshot | null) => void): () => void;
  swingClaim(): boolean;
  swingLeave(): boolean;
  onStatus(listener: (event: { readonly status: string }) => void): () => void;
  readonly gameId: GameId | null;
}

/** Where the local player stands, as the solo authority looks it up. */
export interface SoloSwingStance {
  readonly x: number;
  readonly y: number;
}

/**
 * The solo authority: structurally the lobby's `SwingAuthority`
 * (`@strkworld/lobby/swing`), so solo play runs the lobby's own rules.
 */
export interface SoloSwingAuthority {
  snapshot(now: number): RoofSwingSnapshot;
  readonly active: boolean;
  claim(
    claimant: { readonly key: string; readonly gameId: GameId; readonly area: PresenceArea | null; readonly x: number; readonly y: number },
    now: number,
  ): string;
  leave(key: string, now: number): string;
  gone(key: string, reason: 'left' | 'disconnect', now: number): boolean;
  advance(now: number): ReadonlyArray<{ readonly kind: string; readonly key: string; readonly tile: RoofTile; readonly facing: Facing }>;
}

/** The channel the World and the HUD hold. */
export interface SwingShellChannel extends RoofSwingChannel {
  /** The HUD's "get off": through the World's own path when it listens, else straight to the authority. */
  press(): void;
  /** Whether the local player is on the roof (the HUD shows nothing elsewhere). */
  onRoof(): boolean;
}

export interface SwingController {
  readonly channel: SwingShellChannel;
  /** Follow the local player on the World bus: whether they are on the roof, and where. */
  listen(world: Pick<EventBus<WorldEvents>, 'on'>): () => void;
  /** Adopt each lobby client as it is created; its connection picks the backend. */
  adopt<T>(client: T): T;
  destroy(): void;
}

export interface SwingControllerOptions {
  /** Builds the solo authority (the lobby's rules). Absent: offline the swing never moves. */
  readonly solo?: () => SoloSwingAuthority;
  /** The clock, in ms. `performance.now` by default. */
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

/** The solo player's key and stand-in presence id. Never on any wire. */
const SOLO_KEY = 'local';
export const SOLO_SWING_ID = 'solo' as GameId;
/** The solo swing's clock: the ride's end and the cooldown's close, stepped this often. */
export const SOLO_SWING_TICK_MS = 100;

function isSwingClient(value: unknown): value is SwingLobbyClient {
  if (value === null || typeof value !== 'object') return false;
  const c = value as Partial<Record<keyof SwingLobbyClient, unknown>>;
  return (
    typeof c.swing === 'function' &&
    typeof c.onSwing === 'function' &&
    typeof c.swingClaim === 'function' &&
    typeof c.swingLeave === 'function' &&
    typeof c.onStatus === 'function'
  );
}

/** Two snapshots that read the same. Tiny frozen objects: a field walk is enough. */
function sameSwing(a: RoofSwingSnapshot | null, b: RoofSwingSnapshot | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return (
    a.phase === b.phase &&
    a.round === b.round &&
    a.riderId === b.riderId &&
    a.secondsLeft === b.secondsLeft &&
    a.reason === b.reason
  );
}

function validated(value: unknown): RoofSwingSnapshot | null {
  try {
    return normalizeRoofSwing(value);
  } catch {
    return null;
  }
}

export function createSwingController(options: SwingControllerOptions = {}): SwingController {
  const clock = options.now ?? (() => globalThis.performance.now());
  const setTimer = options.setTimer ?? ((callback, ms) => globalThis.setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle) => globalThis.clearTimeout(handle as never));
  const authority: SoloSwingAuthority | null = options.solo ? options.solo() : null;
  const listeners = new Set<(swing: RoofSwingSnapshot | null) => void>();
  const leaveListeners = new Set<() => void>();
  let destroyed = false;
  let onRoof = false;
  let here: SoloSwingStance | null = null;
  let published: RoofSwingSnapshot | null = null;
  /** The last value `swing()` returned. */
  let lastRead: RoofSwingSnapshot | null = null;
  let tickTimer: unknown = null;
  let lobby: { readonly client: SwingLobbyClient; stop: () => void } | null = null;
  const adopted = new Map<SwingLobbyClient, { stop: () => void; status: string }>();

  /** Hand every listener the swing when it reads differently; the first failure surfaces afterwards. */
  const publish = (next: RoofSwingSnapshot | null): void => {
    if (sameSwing(published, next)) return;
    published = next;
    if (!sameSwing(lastRead, next)) lastRead = next;
    const errors: unknown[] = [];
    for (const listener of [...listeners]) {
      try {
        listener(next);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'Swing listener failed');
  };

  // -- solo ----------------------------------------------------------------------

  const soloSwing = (): RoofSwingSnapshot | null => {
    if (authority === null || lobby !== null || !onRoof) return null;
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
      if (event.kind === 'place' && event.key === SOLO_KEY) {
        const centre = roofTileCentre(event.tile);
        here = { x: centre.x, y: centre.y };
      }
    }
  };

  const tick = (): void => {
    tickTimer = null;
    if (destroyed || authority === null || lobby !== null) return;
    try {
      advanceSolo(clock());
      publish(soloSwing());
    } finally {
      schedule();
    }
  };

  const schedule = (): void => {
    if (destroyed || authority === null || lobby !== null || tickTimer !== null) return;
    if (!authority.active) return;
    tickTimer = setTimer(tick, SOLO_SWING_TICK_MS);
  };

  const soloAct = (act: (auth: SoloSwingAuthority, now: number) => void): void => {
    if (authority === null || lobby !== null || !onRoof) return;
    const now = clock();
    act(authority, now);
    // As the lobby does after each intent: the claim's move onto the seat, at once.
    advanceSolo(now);
    publish(soloSwing());
    schedule();
  };

  // -- the lobby -------------------------------------------------------------------

  const useLobby = (client: SwingLobbyClient): void => {
    if (lobby?.client === client) return;
    lobby?.stop();
    stopTicking();
    // A solo ride in progress ends: the lobby is the authority now.
    if (authority !== null && onRoof) authority.gone(SOLO_KEY, 'disconnect', clock());
    const current: { readonly client: SwingLobbyClient; stop: () => void } = { client, stop: () => {} };
    lobby = current;
    const stop = client.onSwing((swing) => {
      if (lobby?.client !== client) return;
      publish(validated(swing));
    });
    current.stop = stop;
    if (lobby?.client === client) publish(validated(client.swing()));
  };

  const useLocal = (client: SwingLobbyClient): void => {
    if (lobby?.client !== client) return;
    const current = lobby;
    lobby = null;
    current.stop();
    publish(soloSwing());
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
    return authority !== null ? SOLO_SWING_ID : null;
  };

  const sendLeave = (): void => {
    if (destroyed) return;
    if (lobby) {
      lobby.client.swingLeave();
      return;
    }
    soloAct((auth, now) => {
      auth.leave(SOLO_KEY, now);
    });
  };

  /** The HUD's "get off": through the World's own path when it listens, else straight to the authority. */
  const pressLeave = (): void => {
    if (destroyed) return;
    if (leaveListeners.size === 0) {
      sendLeave();
      return;
    }
    for (const listener of [...leaveListeners]) {
      try {
        listener();
      } catch {
        // One failing listener does not stop the press reaching the rest.
      }
    }
  };

  const channel: SwingShellChannel = Object.freeze({
    swing(): RoofSwingSnapshot | null {
      if (destroyed) return null;
      const next = lobby ? validated(lobby.client.swing()) : soloSwing();
      // The same reading returns the same object, so React's external store stays still.
      if (!sameSwing(lastRead, next)) lastRead = next;
      return lastRead;
    },
    subscribe(listener: (swing: RoofSwingSnapshot | null) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    selfId,
    claim(): void {
      if (destroyed) return;
      if (lobby) {
        lobby.client.swingClaim();
        return;
      }
      soloAct((auth, now) => {
        if (here === null) return;
        auth.claim({ key: SOLO_KEY, gameId: SOLO_SWING_ID, area: 'roof', x: here.x, y: here.y }, now);
      });
    },
    leave: sendLeave,
    subscribeLeaves(listener: () => void): () => void {
      leaveListeners.add(listener);
      return () => {
        leaveListeners.delete(listener);
      };
    },
    press: pressLeave,
    onRoof: () => onRoof && !destroyed,
  });

  const enter = (): void => {
    onRoof = true;
    if (!lobby) publish(soloSwing());
  };
  const exit = (): void => {
    if (authority !== null && !lobby) authority.gone(SOLO_KEY, 'left', clock());
    onRoof = false;
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
        world.on('rooftop:entered', () => enter()),
        world.on('rooftop:exited', () => exit()),
        world.on('area:moved', (payload) => {
          const moved = payload as WorldEvents['area:moved'] | undefined;
          const position = moved?.position;
          if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return;
          // Only the roof's own coordinates: the arena and the Studio publish here too.
          here = { x: position.x, y: position.y };
        }),
      ];
      return () => {
        for (const stop of stops) stop();
      };
    },
    adopt<T>(client: T): T {
      if (destroyed || !isSwingClient(client) || adopted.has(client)) return client;
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
      leaveListeners.clear();
    },
  };
}
