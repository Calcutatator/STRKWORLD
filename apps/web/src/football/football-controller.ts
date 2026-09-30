import {
  FOOTBALL_TICK_MS,
  type EventBus,
  type Facing,
  type FootballGoal,
  type FootballSide,
  type FootballSnapshot,
  type WorldEvents,
} from '@strkworld/shared';
import type { FootballChannel, FootballFrame, FootballMoment } from '@strkworld/world';
import {
  FOOTBALL_PLAYER_MAX_SPEED,
  FOOTBALL_PLAYER_WINDOW_MS,
  createFootballAuthority,
  isNearPitch,
  type FootballAuthority,
  type FootballEvent,
  type FootballPlayer,
} from '@strkworld/lobby/football';
import { debugFootball } from '../debug/debug-tap.js';
import { createBallPresenter, type BallPresenter, type LocalPlayer } from './ball-presenter.js';

/**
 * The Shell side of the football (D-078).
 *
 * The World receives one stable `FootballChannel`. Behind it, the lobby is
 * the authority whenever a lobby connection is open, so every player sees
 * the same ball; otherwise the same rules (`@strkworld/lobby/football`) run
 * here for solo play, stepped on the same 40 ms tick while the player is on
 * or near the pitch. Either way the ball the World draws comes out of one
 * presenter, which carries the authority's latest state on to the present
 * and answers the local player's own touches at once. Switching backends
 * never changes the channel object the World holds.
 *
 * Goals and full time reach the World as moments; debug builds (D-069) log
 * `football.kick`, `football.goal` and `football.full-time` by side at most.
 */

/** The subset of `LobbyClient` the football needs. */
export interface FootballLobbyClient {
  football(): FootballSnapshot | null;
  onFootball(listener: (snapshot: FootballSnapshot | null) => void): () => void;
  onGoal(listener: (goal: FootballGoal) => void): () => void;
  kick(): boolean;
  onStatus(listener: (event: { readonly status: string }) => void): () => void;
}

export interface FootballController {
  readonly channel: FootballChannel;
  /** Follow the local player on the World bus: solo play and the local touches need where they are. */
  listen(world: Pick<EventBus<WorldEvents>, 'on'>): () => void;
  /** Adopt each lobby client as it is created; its connection picks the backend. */
  adopt<T>(client: T): T;
  /**
   * The authority's latest ball, as the drawn ball carries on from: the
   * lobby's while connected, the solo one otherwise; null while there is none.
   */
  snapshot(): FootballSnapshot | null;
  destroy(): void;
}

export interface FootballControllerOptions {
  /** The clock, in ms. `performance.now` by default. */
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

const LOCAL_PLAYER = 'local';

function isFootballClient(value: unknown): value is FootballLobbyClient {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<Record<keyof FootballLobbyClient, unknown>>;
  return (
    typeof candidate.football === 'function' &&
    typeof candidate.onFootball === 'function' &&
    typeof candidate.onGoal === 'function' &&
    typeof candidate.kick === 'function' &&
    typeof candidate.onStatus === 'function'
  );
}

/** The side ahead, which at full time is the winner. */
function leader(snapshot: FootballSnapshot): FootballSide {
  return snapshot.west > snapshot.east ? 'west' : 'east';
}

export function createFootballController(options: FootballControllerOptions = {}): FootballController {
  const clock = options.now ?? (() => globalThis.performance.now());
  const setTimer = options.setTimer ?? ((callback, ms) => globalThis.setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle) => globalThis.clearTimeout(handle as never));
  const authority: FootballAuthority = createFootballAuthority();
  const presenter: BallPresenter = createBallPresenter();
  const momentListeners = new Set<(moment: FootballMoment) => void>();
  let destroyed = false;
  let away = false;
  let stepTimer: unknown = null;
  /** The last solo snapshot handed to the presenter, so an unchanged one is not handed twice. */
  let pushed: FootballSnapshot | null = null;
  /** The last snapshot from the lobby, while it is the authority. */
  let lobbyLatest: FootballSnapshot | null = null;

  /** The local player: where they stand, since when, and how they move. */
  let here: { x: number; y: number; facing: Facing; at: number } | null = null;
  let motion = { vx: 0, vy: 0 };

  /** The lobby client currently acting as authority, if any. */
  let lobby: { readonly client: FootballLobbyClient; stop: () => void } | null = null;
  const adopted = new Map<FootballLobbyClient, { stop: () => void; status: string }>();

  /** Every listener hears every moment; the first failure surfaces afterwards. */
  const emit = (moment: FootballMoment): void => {
    const errors: unknown[] = [];
    for (const listener of [...momentListeners]) {
      try {
        listener(moment);
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'Football listener failed');
  };
  const goal = (side: FootballSide): void => {
    debugFootball({ event: 'goal', side });
    emit(Object.freeze({ kind: 'goal', side }));
  };
  const fullTime = (snapshot: FootballSnapshot): void => {
    const winner = leader(snapshot);
    debugFootball({ event: 'full-time', winner });
    emit(Object.freeze({ kind: 'full-time', winner, west: snapshot.west, east: snapshot.east }));
  };

  const localPlayer = (now: number): LocalPlayer | null => {
    if (here === null || away) return null;
    // Standing still for a moment is standing still, whatever the last step was.
    const moving = now - here.at <= FOOTBALL_PLAYER_WINDOW_MS;
    return { x: here.x, y: here.y, facing: here.facing, vx: moving ? motion.vx : 0, vy: moving ? motion.vy : 0 };
  };
  const soloPlayer = (): FootballPlayer | null =>
    here === null || away ? null : { key: LOCAL_PLAYER, x: here.x, y: here.y, at: here.at };

  // -- solo authority ---------------------------------------------------------

  const publishSolo = (now: number): void => {
    const snapshot = authority.snapshot();
    if (snapshot === pushed) return;
    pushed = snapshot;
    presenter.push(snapshot, now);
  };

  const stopStepping = (): void => {
    if (stepTimer === null) return;
    clearTimer(stepTimer);
    stepTimer = null;
  };

  /** Keep the solo ball stepping while the player is on or near the pitch, and at rest otherwise. */
  const scheduleStep = (): void => {
    if (destroyed || lobby || stepTimer !== null) return;
    const player = soloPlayer();
    const now = clock();
    if (player === null || !isNearPitch(player.x, player.y)) {
      authority.pause();
      publishSolo(now);
      return;
    }
    authority.resume(now);
    stepTimer = setTimer(step, FOOTBALL_TICK_MS);
  };

  const step = (): void => {
    stepTimer = null;
    if (destroyed || lobby) return;
    try {
      const player = soloPlayer();
      if (player !== null && isNearPitch(player.x, player.y)) {
        const now = clock();
        const events: FootballEvent[] = authority.advance(now, [player]);
        // Same order as the lobby: the state the event concerns, then the event.
        publishSolo(now);
        for (const event of events) {
          if (event.kind === 'goal') goal(event.side);
          else if (event.kind === 'full-time') fullTime(authority.snapshot());
        }
      }
    } finally {
      // A throwing listener must not end play for the rest of the session.
      scheduleStep();
    }
  };

  // -- lobby authority ----------------------------------------------------------

  const useLobby = (client: FootballLobbyClient): void => {
    if (lobby?.client === client) return;
    lobby?.stop();
    stopStepping();
    presenter.reset();
    pushed = null;
    lobbyLatest = null;
    // The authority before subscribing: `onFootball` replays the current ball at once.
    const current: { readonly client: FootballLobbyClient; stop: () => void } = { client, stop: () => {} };
    lobby = current;
    let phase: FootballSnapshot['phase'] | null = null;
    const stopState = client.onFootball((snapshot) => {
      if (lobby?.client !== client) return;
      lobbyLatest = snapshot;
      if (snapshot === null) {
        presenter.reset();
        phase = null;
        return;
      }
      const before = phase;
      phase = snapshot.phase;
      presenter.push(snapshot, clock());
      // Full time is in state: a moment when play reaches it, not on joining during one.
      if (snapshot.phase === 'full-time' && before !== null && before !== 'full-time') fullTime(snapshot);
    });
    const stopGoals = client.onGoal((cue) => {
      if (lobby?.client !== client) return;
      if (cue?.side === 'west' || cue?.side === 'east') goal(cue.side);
    });
    current.stop = () => {
      stopState();
      stopGoals();
    };
  };

  const useLocal = (client: FootballLobbyClient): void => {
    if (lobby?.client !== client) return;
    const current = lobby;
    lobby = null;
    lobbyLatest = null;
    current.stop();
    // A dropped connection falls back to this player's own solo ball.
    presenter.reset();
    pushed = null;
    publishSolo(clock());
    scheduleStep();
  };

  const channel: FootballChannel = Object.freeze({
    frame(): FootballFrame | null {
      if (destroyed) return null;
      const now = clock();
      return presenter.frame(now, localPlayer(now));
    },
    subscribeMoments(listener: (moment: FootballMoment) => void): () => void {
      momentListeners.add(listener);
      return () => {
        momentListeners.delete(listener);
      };
    },
    kick(): void {
      if (destroyed) return;
      const now = clock();
      const player = localPlayer(now);
      if (player === null) return;
      if (lobby) {
        // The lobby decides; the kick is shown at once all the same.
        if (!lobby.client.kick()) return;
        presenter.kick(now, player);
        debugFootball({ event: 'kick' });
        return;
      }
      if (!isNearPitch(player.x, player.y)) return;
      authority.resume(now);
      if (!authority.kick(player, player.facing)) return;
      debugFootball({ event: 'kick' });
      publishSolo(now);
      scheduleStep();
    },
  });

  const leaveStreet = (): void => {
    away = true;
  };
  const backOnStreet = (): void => {
    away = false;
  };

  // The solo ball starts at rest on the centre spot, drawn from the start.
  publishSolo(clock());

  return {
    channel,
    listen(world) {
      const stops = [
        world.on('player:moved', (payload) => {
          const moved = payload as WorldEvents['player:moved'] | undefined;
          const position = moved?.position;
          if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return;
          const facing: Facing = moved?.facing === 'up' || moved?.facing === 'left' || moved?.facing === 'right' ? moved.facing : 'down';
          const now = clock();
          if (here === null || here.x !== position.x || here.y !== position.y) {
            if (here !== null) {
              const dt = (now - here.at) / 1000;
              if (dt > 0 && dt * 1000 <= FOOTBALL_PLAYER_WINDOW_MS) {
                let vx = (position.x - here.x) / dt;
                let vy = (position.y - here.y) / dt;
                const speed = Math.hypot(vx, vy);
                if (speed > FOOTBALL_PLAYER_MAX_SPEED) {
                  vx *= FOOTBALL_PLAYER_MAX_SPEED / speed;
                  vy *= FOOTBALL_PLAYER_MAX_SPEED / speed;
                }
                motion = { vx, vy };
              } else {
                motion = { vx: 0, vy: 0 };
              }
            }
            here = { x: position.x, y: position.y, facing, at: now };
          } else {
            here = { ...here, facing };
          }
          // Walking onto the pitch starts the solo ball.
          if (!lobby && stepTimer === null) scheduleStep();
        }),
        world.on('building:entered', leaveStreet),
        world.on('avatar-studio:entered', leaveStreet),
        world.on('building:exited', backOnStreet),
        world.on('avatar-studio:exited', backOnStreet),
      ];
      return () => {
        for (const stop of stops) stop();
      };
    },
    adopt<T>(client: T): T {
      if (destroyed || !isFootballClient(client) || adopted.has(client)) return client;
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
    snapshot() {
      if (destroyed) return null;
      return lobby ? lobbyLatest : authority.snapshot();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stopStepping();
      lobby?.stop();
      lobby = null;
      for (const entry of adopted.values()) entry.stop();
      adopted.clear();
      momentListeners.clear();
      presenter.reset();
    },
  };
}
