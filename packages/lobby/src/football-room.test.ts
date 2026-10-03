/**
 * D-078 end to end: a real Colyseus server, real websocket clients and the
 * real room class, whose ball starts at rest two tiles in front of the east
 * goal. A client beside it kicks; the room steps the ball into the goal and
 * tells everyone.
 *
 * A file of its own because it needs its own room definition, and the
 * matchmaker is a process-global (see the AGENTS.md finding).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Server, matchMaker } from '@colyseus/core';
import { WebSocketTransport } from '@colyseus/ws-transport';
import { Client as ColyseusClient, type Room as ColyseusRoom } from '@colyseus/sdk';
import {
  PITCH_FIELD,
  PITCH_GATES,
  pitchTileCentre,
  type FootballGoal,
  type FootballSnapshot,
} from '@strkworld/shared';
import { DEFAULT_ROOM_NAME, MESSAGE, SERVER_MESSAGE, resolveRoomConfig, type PresenceRoomConfig } from './config';
import { LobbyClient } from './client';
import { FOOTBALL_TILE_SIZE, type BallState } from './football-rules';
import { PresenceRoom } from './room';
import type { LobbyPresenceOptions } from './presence';
import type { LobbyState } from './state';
import vocabulary from './testing/forbidden-vocabulary.json';

const T = FOOTBALL_TILE_SIZE;
const MID = (PITCH_FIELD.y + PITCH_FIELD.height / 2) * T;
const X1 = (PITCH_FIELD.x + PITCH_FIELD.width) * T;
/** The ball, at rest two tiles in front of the east goal's mouth. */
const BALL: BallState = Object.freeze({ x: X1 - 2 * T, y: MID, vx: 0, vy: 0 });
/** Where the kicker stands: just west of the ball, so a kick sends it east, into the goal. */
const KICKER = { x: BALL.x - 24, y: BALL.y };
/**
 * D-135: the pitch is fenced, so the kicker joins on the north gate's
 * approach, presses E to take a slot, and is then walked to `KICKER`.
 */
const GATE_APPROACH = pitchTileCentre({ x: PITCH_GATES[0]!.approach.x, y: PITCH_GATES[0]!.approach.y });
/** Well clear of the ball, outside the fence in sight of it, so the ball runs while they watch. */
const WATCHER = { x: 8 * T + 16, y: 5 * T + 16 };

/** The production room, with a trusted config whose ball starts in front of the east goal. */
class ShootingRoom extends PresenceRoom {
  protected override roomConfig: PresenceRoomConfig & Pick<LobbyPresenceOptions, 'footballBall'> = {
    // D-135: the dummies are off, so the match stays open and one client can
    // walk in and kick freely, which is what this end-to-end test is about.
    ...resolveRoomConfig({ minUpdateIntervalMs: 10, pitchDummyFill: false }),
    footballBall: BALL,
  };
}

let server: Server;
let endpoint = '';

beforeAll(async () => {
  for (let attempt = 0; ; attempt += 1) {
    const port = 56_000 + Math.floor(Math.random() * 3_000);
    const candidate = new Server({ transport: new WebSocketTransport(), greet: false, gracefullyShutdown: false });
    candidate.define(DEFAULT_ROOM_NAME, ShootingRoom);
    try {
      await candidate.listen(port, '127.0.0.1');
      server = candidate;
      endpoint = `ws://127.0.0.1:${port}`;
      return;
    } catch (error) {
      await candidate.gracefullyShutdown(false).catch(() => undefined);
      if (attempt >= 20) throw error;
    }
  }
});

afterAll(async () => {
  await Promise.all(matchMaker.disconnectAll());
  await server?.gracefullyShutdown(false);
});

async function waitFor<V>(read: () => V, ready: (value: V) => boolean, label: string, timeoutMs = 8000): Promise<V> {
  const limit = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (ready(value)) return value;
    if (Date.now() > limit) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('the ball in a real room (D-078)', () => {
  it('kicks from where the room says the kicker stands, shows everyone the ball in state, and broadcasts the goal by its side alone', async () => {
    // A bare SDK client sees the raw state and the raw goal payload.
    const sdk = new ColyseusClient(endpoint);
    const raw: ColyseusRoom<unknown, LobbyState> = await sdk.joinOrCreate<LobbyState>(DEFAULT_ROOM_NAME, {
      ...WATCHER,
      facing: 'up',
      sprite: 'avatar-1',
    });
    raw.reconnection.enabled = false;
    const starksScore = (): number => (raw.state as unknown as { football?: { starks?: number } }).football?.starks ?? -1;
    const heard: Array<{ payload: unknown; scoreThen: number }> = [];
    raw.onMessage(SERVER_MESSAGE.goal, (payload: unknown) => {
      heard.push({ payload, scoreThen: starksScore() });
    });
    // The kicker uses the client wrapper the Shell uses.
    const kicker = new LobbyClient({ endpoint, start: { ...GATE_APPROACH, facing: 'down' } });
    const goals: FootballGoal[] = [];
    const balls: Array<FootballSnapshot | null> = [];
    kicker.onGoal((goal) => goals.push(goal));
    kicker.onFootball((snapshot) => balls.push(snapshot));

    try {
      await kicker.connect();
      // D-135: in by the north gate, then across to the ball.
      expect(kicker.pitchGate()).toBe(true);
      await waitFor(
        () => kicker.pitchMatch(),
        (match) => (match?.slots.filter((slot) => slot.kind === 'player').length ?? 0) === 1,
        'the slot taken',
      );
      kicker.updatePosition(KICKER.x, KICKER.y, 'right');
      const standsAt = (): { x?: number; y?: number } | undefined =>
        (raw.state as unknown as { peers: { get(key: string): { position?: { x: number; y: number } } | undefined } })
          .peers.get(kicker.gameId as string)?.position;
      await waitFor(standsAt, (at) => at?.x === KICKER.x && at?.y === KICKER.y, 'the walk to the ball');
      // Everyone gets the ball at rest where the room put it.
      const still = await waitFor(() => kicker.football(), (ball) => ball !== null, 'the ball');
      expect(still).toMatchObject({ x: BALL.x, y: BALL.y, vx: 0, vy: 0, starks: 0, snarks: 0, phase: 'live' });
      expect(Object.isFrozen(still)).toBe(true);

      // The kick carries nothing; a hostile payload on the same verb is never read.
      raw.send(MESSAGE.kick, { x: 0, y: 0, vx: 99999, side: 'snarks', gameId: '0123456789abcdef' });
      expect(kicker.kick()).toBe(true);
      const moving = await waitFor(() => kicker.football(), (ball) => (ball?.vx ?? 0) > 0, 'the kicked ball');
      expect(moving!.vy).toBeCloseTo(0, 3);
      expect(moving!.tick).toBeGreaterThan(still!.tick);

      // Into the goal: the Starks', told at once, before the patch that raises the score.
      await waitFor(() => heard.length, (count) => count >= 1, 'the goal');
      expect(heard[0]).toEqual({ payload: { side: 'starks' }, scoreThen: 0 });
      await waitFor(() => goals.length, (count) => count >= 1, 'the wrapped goal');
      expect(goals).toEqual([{ side: 'starks' }]);
      expect(Object.isFrozen(goals[0])).toBe(true);
      const scored = await waitFor(() => kicker.football(), (ball) => ball?.starks === 1, 'the score');
      expect(scored).toMatchObject({ starks: 1, snarks: 0, phase: 'goal' });
      expect(starksScore()).toBe(1);

      // A kick during the celebration is refused: the ball stays dead in the net.
      const dead = kicker.football()!;
      await new Promise((resolve) => setTimeout(resolve, 350));
      kicker.kick();
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(kicker.football()!.phase).toBe('goal');
      expect(Math.abs(kicker.football()!.vx)).toBeLessThanOrEqual(Math.abs(dead.vx) + 1e-3);

      // Nothing on the wire names anyone: no identifier, no financial word.
      const surface = JSON.stringify([heard.map((entry) => entry.payload), goals, balls]);
      expect(surface).not.toContain(kicker.gameId as string);
      expect(surface).not.toContain('0123456789abcdef');
      const lowered = surface.toLowerCase();
      for (const word of vocabulary.substrings) expect(lowered).not.toContain(word);
    } finally {
      await kicker.disconnect().catch(() => undefined);
      await raw.leave(true).catch(() => undefined);
    }
  }, 20_000);

  it('drops a kick inside the client\'s own floor, and sends nothing while not connected', async () => {
    const idle = new LobbyClient({ endpoint, start: { ...GATE_APPROACH, facing: 'down' } });
    expect(idle.kick()).toBe(false);
    expect(idle.football()).toBeNull();
    const client = new LobbyClient({ endpoint, start: { ...WATCHER, facing: 'right' } });
    try {
      await client.connect();
      expect(client.kick()).toBe(true);
      expect(client.kick()).toBe(false);
      await new Promise((resolve) => setTimeout(resolve, 320));
      expect(client.kick()).toBe(true);
      client.suspend();
      expect(client.kick()).toBe(false);
    } finally {
      await client.disconnect().catch(() => undefined);
    }
    expect(client.kick()).toBe(false);
    expect(client.football()).toBeNull();
  }, 20_000);
});
