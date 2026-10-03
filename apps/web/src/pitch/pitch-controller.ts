import { FOOTBALL_WIN_SCORE, normalizePitchMatch, type GameId, type PitchMatchSnapshot } from '@strkworld/shared';

/**
 * The Shell's side of the gated pitch's match (D-135).
 *
 * The match is the room's, and only the room's: there is no solo pitch match,
 * because a gated 2v2 needs an authority and the open pitch (D-078) is
 * already what a solo player gets. So this controller is a thin adapter —
 * it adopts each lobby client as it is created, re-publishes the client's
 * frozen snapshot to the HUD and the World, and sends gate presses back.
 * Offline, `match()` is null and the HUD draws nothing.
 *
 * Every figure the HUD shows comes from here, which means from the server:
 * the phase, the score, the seconds left and the winner. Nothing is timed or
 * counted locally, so a spectator and a player always read the same match.
 */

/** What the controller needs of a lobby client; `LobbyClient` satisfies it. */
export interface PitchLobbyClient {
  pitchMatch(): PitchMatchSnapshot | null;
  onPitchMatch(listener: (match: PitchMatchSnapshot | null) => void): () => void;
  pitchGate(): boolean;
  readonly gameId: GameId | null;
}

/** What the HUD and the World read. */
export interface PitchShellChannel {
  /** The match as the room holds it, or null: offline, away from the pitch, or off the street. */
  match(): PitchMatchSnapshot | null;
  /** Replay the current match, then every change. Returns its removal. */
  subscribe(listener: (match: PitchMatchSnapshot | null) => void): () => void;
  /** Press E at a gate. Whether the press went out. */
  gate(): boolean;
  /** This client's slot in the match, or -1: the HUD reads "am I playing?" from it. */
  selfSlot(): number;
}

export interface PitchController {
  readonly channel: PitchShellChannel;
  adopt<T>(client: T): T;
  destroy(): void;
}

function isPitchClient(value: unknown): value is PitchLobbyClient {
  if (value === null || typeof value !== 'object') return false;
  const client = value as Partial<Record<keyof PitchLobbyClient, unknown>>;
  return (
    typeof client.pitchMatch === 'function' &&
    typeof client.onPitchMatch === 'function' &&
    typeof client.pitchGate === 'function'
  );
}

export function createPitchController(): PitchController {
  const listeners = new Set<(match: PitchMatchSnapshot | null) => void>();
  let client: PitchLobbyClient | null = null;
  let unsubscribe: (() => void) | null = null;
  let current: PitchMatchSnapshot | null = null;
  let destroyed = false;

  /** Re-validate on the way through: the client already does, and this costs nothing. */
  const read = (value: PitchMatchSnapshot | null): PitchMatchSnapshot | null =>
    value === null ? null : normalizePitchMatch(value, FOOTBALL_WIN_SCORE);

  const publish = (next: PitchMatchSnapshot | null): void => {
    current = next;
    for (const listener of [...listeners]) {
      try {
        listener(next);
      } catch {
        // A throwing subscriber never stops the others.
      }
    }
  };

  const channel: PitchShellChannel = {
    match: () => current,
    subscribe(listener) {
      if (destroyed) return () => {};
      listeners.add(listener);
      try {
        listener(current);
      } catch {
        // As above: a bad first call is not fatal.
      }
      return () => {
        listeners.delete(listener);
      };
    },
    gate() {
      if (destroyed || client === null) return false;
      try {
        return client.pitchGate() === true;
      } catch {
        return false;
      }
    },
    selfSlot() {
      const self = client?.gameId ?? null;
      if (current === null || self === null) return -1;
      return current.slots.findIndex((slot) => slot.kind === 'player' && slot.gameId === self);
    },
  };

  return {
    channel,
    adopt(value) {
      if (destroyed || !isPitchClient(value)) return value;
      // One client at a time: a new connection replaces the old one's feed.
      unsubscribe?.();
      unsubscribe = null;
      client = value;
      try {
        unsubscribe = value.onPitchMatch((match) => {
          if (!destroyed) publish(read(match));
        });
      } catch {
        unsubscribe = null;
        publish(null);
      }
      return value;
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      try {
        unsubscribe?.();
      } catch {
        // Nothing left to do: the controller is going away.
      }
      unsubscribe = null;
      client = null;
      listeners.clear();
      current = null;
    },
  };
}
