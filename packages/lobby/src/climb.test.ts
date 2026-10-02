/**
 * D-106: jump to climb, in the registry. Walking never steps up onto a higher
 * sandbox stack; a step up of one block is accepted only within
 * `CLIMB_WINDOW_MS` of an accepted jump, once per jump. A refused step up
 * leaves the position where it was, and the room may resync the client.
 */

import { describe, expect, it } from 'vitest';
import {
  CLIMB_FROM_PHASE,
  CLIMB_WINDOW_MS,
  PLAYER_BODY_SIZE,
  SANDBOX_AREA,
  SANDBOX_COLOURS,
  type GameId,
  type SandboxTile,
} from '@strkworld/shared';
import { JUMP_MIN_INTERVAL_MS, RESYNC_MIN_INTERVAL_MS, SERVER_MESSAGE } from './config';
import { LobbyPresence } from './presence';
import { SANDBOX_TILE_SIZE, bodyLevelAt, isEntranceTile, sandboxTileKey } from './sandbox-rules';

const T = SANDBOX_TILE_SIZE;
const HALF = PLAYER_BODY_SIZE / 2;
/** The World's air time (`JUMP_AIR_MS` in packages/world): every avatar's, reduced motion's too. */
const AIR_MS = 500;
/** The client's move floor: a climb can wait this long to leave. */
const MOVE_FLOOR_MS = 50;
const X = SANDBOX_AREA.x + 6;
const Y = 14;

const centre = (tileX: number, tileY: number) => ({ x: tileX * T + T / 2, y: tileY * T + T / 2 });
/** Body flush against the west edge of `tileX`, not yet over it. */
const against = (tileX: number, tileY: number) => ({ x: tileX * T - HALF, y: tileY * T + T / 2 });

/** A registry with `stacks` dropped exactly (before anyone joins) and one player at `at`. */
function world(stacks: ReadonlyArray<{ tile: SandboxTile; height: number }>, at: { x: number; y: number }) {
  const draws: number[] = [];
  const registry = new LobbyPresence({ capacity: 8, sandboxRandom: () => (draws.length > 0 ? (draws.shift() as number) : 0.5) });
  const open: SandboxTile[] = [];
  for (let y = SANDBOX_AREA.y; y < SANDBOX_AREA.y + SANDBOX_AREA.height; y += 1) {
    for (let x = SANDBOX_AREA.x; x < SANDBOX_AREA.x + SANDBOX_AREA.width; x += 1) {
      if (!isEntranceTile(x, y)) open.push({ x, y });
    }
  }
  for (const { tile, height } of stacks) {
    const index = open.findIndex((candidate) => sandboxTileKey(candidate.x, candidate.y) === sandboxTileKey(tile.x, tile.y));
    for (let block = 0; block < height; block += 1) {
      draws.push((index + 0.5) / open.length, 0.5 / SANDBOX_COLOURS);
      expect(registry.spawnBlock()).toEqual(tile);
    }
  }
  const outcome = registry.admit('p', at);
  if (!outcome.ok) throw new Error(outcome.reason);
  const id: GameId = outcome.gameId;
  const position = () => {
    const entry = registry.peers.get(id)!;
    return { x: entry.position.x, y: entry.position.y };
  };
  return { registry, position };
}

const ONE = [{ tile: { x: X + 1, y: Y }, height: 1 }];

describe('walking never steps up (D-106)', () => {
  it('refuses a step onto a stack one block higher without a jump, and holds the player', () => {
    const { registry, position } = world(ONE, against(X + 1, Y));
    expect(registry.move('p', centre(X + 1, Y), 1000)).toBe('refused');
    expect(position()).toEqual(against(X + 1, Y));
    expect(registry.counters().rejected).toBe(1);
  });

  it('measures the step with the body, as the World does: an edge over the stack is already a climb', () => {
    const { registry } = world(ONE, against(X + 1, Y));
    const edgeOver = { x: against(X + 1, Y).x + 3, y: centre(X, Y).y };
    expect(Math.floor(edgeOver.x / T)).toBe(X);
    expect(registry.move('p', edgeOver, 1000)).toBe('refused');
    // Flush is not over: the body touches the stack without standing on it.
    expect(registry.move('p', { x: against(X + 1, Y).x - 2, y: centre(X, Y).y }, 1100)).toBe('applied');
  });

  it('leaves level ground, the street and stepping down alone', () => {
    const { registry, position } = world([{ tile: { x: X, y: Y }, height: 3 }], centre(X, Y));
    // Off a three-block stack in one step, no jump.
    expect(registry.move('p', centre(X + 1, Y), 1000)).toBe('applied');
    expect(position()).toEqual(centre(X + 1, Y));
    expect(registry.move('p', centre(X + 2, Y), 1100)).toBe('applied');
    // The street outside the sandbox keeps its clamp-only rule.
    expect(registry.move('p', centre(10, 12), 1200)).toBe('applied');
  });

  it('walks across stacks of its own height without a jump', () => {
    const { registry } = world([{ tile: { x: X, y: Y }, height: 2 }, { tile: { x: X + 1, y: Y }, height: 2 }], centre(X, Y));
    expect(registry.move('p', centre(X + 1, Y), 1000)).toBe('applied');
  });
});

describe('jump to climb (D-106)', () => {
  it('accepts a step up anywhere in the World\'s climb window, after the move floor and jitter, for every jump', () => {
    // Every avatar jumps for AIR_MS (reduced motion only lowers the hop), so
    // the World climbs between CLIMB_FROM_PHASE and landing; the move leaves
    // up to one floor later and may arrive 0-100 ms later than the jump did.
    const opens = Math.ceil(CLIMB_FROM_PHASE * AIR_MS);
    for (let climbAt = opens; climbAt < AIR_MS; climbAt += 25) {
      for (const delay of [0, MOVE_FLOOR_MS]) {
        for (const jitter of [-40, 0, 40, 100 - MOVE_FLOOR_MS]) {
          const arrives = Math.max(0, climbAt + delay + jitter);
          if (arrives > AIR_MS + MOVE_FLOOR_MS + 100) continue;
          const { registry, position } = world(ONE, against(X + 1, Y));
          expect(registry.jump('p', 1000)).toBe('applied');
          expect(registry.move('p', centre(X + 1, Y), 1000 + arrives), `climb at ${climbAt} + ${delay} + ${jitter}`).toBe('applied');
          expect(position()).toEqual(centre(X + 1, Y));
        }
      }
    }
  });

  it('tolerates latency up to CLIMB_WINDOW_MS after the jump arrived, and not a millisecond more', () => {
    expect(CLIMB_WINDOW_MS).toBeGreaterThanOrEqual(600);
    const edge = world(ONE, against(X + 1, Y));
    edge.registry.jump('p', 1000);
    expect(edge.registry.move('p', centre(X + 1, Y), 1000 + CLIMB_WINDOW_MS)).toBe('applied');
    const late = world(ONE, against(X + 1, Y));
    late.registry.jump('p', 1000);
    expect(late.registry.move('p', centre(X + 1, Y), 1001 + CLIMB_WINDOW_MS)).toBe('refused');
    expect(late.position()).toEqual(against(X + 1, Y));
    // A jump stamped after the move (a clock running backwards) opens nothing.
    const early = world(ONE, against(X + 1, Y));
    early.registry.jump('p', 1000);
    expect(early.registry.move('p', centre(X + 1, Y), 999)).toBe('refused');
  });

  it('climbs once per jump: a second step up in the same jump is refused, the next jump climbs again', () => {
    const stairs = [{ tile: { x: X + 1, y: Y }, height: 1 }, { tile: { x: X + 2, y: Y }, height: 2 }];
    const { registry, position } = world(stairs, against(X + 1, Y));
    registry.jump('p', 1000);
    expect(registry.move('p', centre(X + 1, Y), 1250)).toBe('applied');
    expect(registry.move('p', centre(X + 2, Y), 1350)).toBe('refused');
    expect(position()).toEqual(centre(X + 1, Y));
    expect(registry.jump('p', 1000 + JUMP_MIN_INTERVAL_MS + 250)).toBe('applied');
    expect(registry.move('p', centre(X + 2, Y), 1000 + JUMP_MIN_INTERVAL_MS + 450)).toBe('applied');
    const heightAt = (tileX: number, tileY: number) => (tileY !== Y ? 0 : tileX === X + 2 ? 2 : tileX === X + 1 ? 1 : 0);
    expect(bodyLevelAt(heightAt, position().x, position().y)).toBe(2);
  });

  it('never steps up two blocks at once, jump or not, but climbs the second from the first', () => {
    const tower = [{ tile: { x: X + 1, y: Y }, height: 2 }];
    const ground = world(tower, against(X + 1, Y));
    ground.registry.jump('p', 1000);
    expect(ground.registry.move('p', centre(X + 1, Y), 1250)).toBe('refused');
    // The refused climb did not spend the jump: a one-block step still could.
    const fromOne = world([{ tile: { x: X, y: Y }, height: 1 }, ...tower], centre(X, Y));
    fromOne.registry.jump('p', 1000);
    expect(fromOne.registry.move('p', centre(X + 1, Y), 1250)).toBe('applied');
  });

  it('spends the climb only when the move is written: a throttled climb is resent and lands', () => {
    const { registry, position } = world(ONE, against(X + 1, Y));
    // Drain the move bucket (three deep) inside the window.
    registry.jump('p', 1000);
    for (const at of [1200, 1201, 1202]) expect(registry.move('p', against(X + 1, Y), at)).toBe('applied');
    expect(registry.move('p', centre(X + 1, Y), 1203)).toBe('throttled');
    expect(registry.move('p', centre(X + 1, Y), 1260)).toBe('applied');
    expect(position()).toEqual(centre(X + 1, Y));
  });

  it('opens no window for a throttled jump, and drops the window on suspend', () => {
    const throttled = world(ONE, against(X + 1, Y));
    expect(throttled.registry.jump('p', 1000)).toBe('applied');
    expect(throttled.registry.move('p', centre(X + 1, Y), 1200)).toBe('applied');
    expect(throttled.registry.move('p', against(X + 1, Y), 1300)).toBe('applied');
    // Inside the jump floor: no new jump, so no second climb.
    expect(throttled.registry.jump('p', 1100 + JUMP_MIN_INTERVAL_MS - 200)).toBe('throttled');
    expect(throttled.registry.move('p', centre(X + 1, Y), 1400)).toBe('refused');

    const suspended = world(ONE, against(X + 1, Y));
    suspended.registry.jump('p', 1000);
    suspended.registry.suspend('p');
    expect(suspended.registry.resume('p', against(X + 1, Y), 1100)).toBe(true);
    expect(suspended.registry.move('p', centre(X + 1, Y), 1200)).toBe('refused');
  });
});

describe('the resync after a refused climb (D-106)', () => {
  it('is the held position, sent to its own session at most once per RESYNC_MIN_INTERVAL_MS', () => {
    expect(SERVER_MESSAGE.resync).toBe('resync');
    const { registry } = world(ONE, against(X + 1, Y));
    expect(registry.move('p', centre(X + 1, Y), 1000)).toBe('refused');
    expect(registry.resyncFor('p', 1000)).toEqual(against(X + 1, Y));
    expect(registry.resyncFor('p', 1000 + RESYNC_MIN_INTERVAL_MS - 1)).toBeNull();
    expect(registry.resyncFor('p', 1000 + RESYNC_MIN_INTERVAL_MS)).toEqual(against(X + 1, Y));
    expect(registry.resyncFor('nobody', 2000)).toBeNull();
    registry.suspend('p');
    expect(registry.resyncFor('p', 5000)).toBeNull();
  });
});
