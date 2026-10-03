import { describe, expect, it } from 'vitest';
import { NO_SEAT, STREET_SEATS, STUDIO_PRESENCE_GRID, type GameId } from '@strkworld/shared';
import { MIN_UPDATE_INTERVAL_MS, MOVE_BURST } from './config';
import { LobbyPresence } from './presence';

/**
 * D-127: the bench seat on the wire, and the four rules the room applies to a
 * claim. Nothing a client says about sitting is taken on trust: a seat has to
 * exist, be where the room already holds that player, be nobody else's, and be
 * on the street.
 */

const T = MIN_UPDATE_INTERVAL_MS + 1;

function join(registry: LobbyPresence, session: string, x = 0, y = 0): GameId {
  const outcome = registry.admit(session, { x, y });
  if (!outcome.ok) throw new Error(`admit failed: ${outcome.reason}`);
  return outcome.gameId;
}

const seatOf = (registry: LobbyPresence, id: GameId): number | undefined => registry.peers.get(id)?.seat;

describe('bench seats on the wire (D-127)', () => {
  it('starts everyone standing', () => {
    const registry = new LobbyPresence();
    const id = join(registry, 's1', 100, 100);
    expect(seatOf(registry, id)).toBe(NO_SEAT);
  });

  it('accepts a real seat claimed at its own spot, and gives it up on the next move', () => {
    const registry = new LobbyPresence();
    const id = join(registry, 's1', 100, 100);
    const spot = STREET_SEATS[5]!;

    expect(registry.move('s1', { x: spot.x, y: spot.y, facing: spot.facing, seat: 5 }, T)).toBe('applied');
    expect(seatOf(registry, id)).toBe(5);

    // Standing up is just a move that mentions no seat.
    expect(registry.move('s1', { x: spot.x, y: spot.y + 32, facing: 'down' }, T * 2)).toBe('applied');
    expect(seatOf(registry, id)).toBe(NO_SEAT);
  });

  it('refuses a bogus seat: the move still applies, the player simply stands', () => {
    const registry = new LobbyPresence();
    const id = join(registry, 's1', 100, 100);
    const spot = STREET_SEATS[2]!;
    let now = T;
    const claim = (seat: unknown, at: { readonly x: number; readonly y: number } = spot): void => {
      now += T;
      expect(registry.move('s1', { x: at.x, y: at.y, facing: 'down', seat }, now)).toBe('applied');
      expect(seatOf(registry, id)).toBe(NO_SEAT);
    };
    // Off the end of the table, negative, fractional, and not a number at all.
    claim(STREET_SEATS.length);
    claim(-2);
    claim(1.5);
    claim('2');
    claim(Number.NaN);
    claim({ valueOf: () => 2 });
    // A real index, but the player is not at that seat's spot.
    claim(2, { x: spot.x + 1, y: spot.y });
    claim(2, { x: 10, y: 10 });
    // A real spot, but the wrong index for it.
    claim(3, spot);
  });

  it('never reads a seat through an accessor or a prototype', () => {
    const registry = new LobbyPresence();
    const id = join(registry, 's1', 100, 100);
    const spot = STREET_SEATS[0]!;
    const hostile = { x: spot.x, y: spot.y, facing: 'down' };
    Object.defineProperty(hostile, 'seat', { get: () => 0, enumerable: true, configurable: true });
    expect(registry.move('s1', hostile, T)).toBe('applied');
    expect(seatOf(registry, id)).toBe(NO_SEAT);

    const inherited = Object.assign(Object.create({ seat: 0 }) as object, { x: spot.x, y: spot.y, facing: 'down' });
    expect(registry.move('s1', inherited, T * 2)).toBe('applied');
    expect(seatOf(registry, id)).toBe(NO_SEAT);
  });

  it('gives one seat to one player: a second claim on it is refused', () => {
    const registry = new LobbyPresence();
    const first = join(registry, 's1', 100, 100);
    const second = join(registry, 's2', 120, 100);
    const spot = STREET_SEATS[8]!;

    expect(registry.move('s1', { x: spot.x, y: spot.y, facing: spot.facing, seat: 8 }, T)).toBe('applied');
    expect(seatOf(registry, first)).toBe(8);

    registry.move('s2', { x: spot.x, y: spot.y, facing: spot.facing, seat: 8 }, T);
    expect(seatOf(registry, second)).toBe(NO_SEAT);

    // The holder stands up; now the seat is free for the other.
    registry.move('s1', { x: spot.x, y: spot.y + 32, facing: 'down' }, T * 2);
    registry.move('s2', { x: spot.x, y: spot.y, facing: spot.facing, seat: 8 }, T * 2);
    expect(seatOf(registry, second)).toBe(8);
  });

  it('frees the seat when its holder suspends, leaves or changes area', () => {
    const spot = STREET_SEATS[1]!;
    const sit = (registry: LobbyPresence, key: string): void => {
      registry.move(key, { x: spot.x, y: spot.y, facing: spot.facing, seat: 1 }, T);
    };

    // A suspend erases the entry outright.
    const suspending = new LobbyPresence();
    const suspended = join(suspending, 's1', 100, 100);
    sit(suspending, 's1');
    suspending.suspend('s1', T * 2);
    expect(suspending.peers.get(suspended)).toBeUndefined();

    // Leaving the street for a shared room gives the seat up.
    const switching = new LobbyPresence();
    const switcher = join(switching, 's1', 100, 100);
    sit(switching, 's1');
    expect(seatOf(switching, switcher)).toBe(1);
    const studio = {
      area: 'studio',
      x: STUDIO_PRESENCE_GRID.originX + STUDIO_PRESENCE_GRID.tileSize * 2,
      y: STUDIO_PRESENCE_GRID.originY + STUDIO_PRESENCE_GRID.tileSize * 2,
      facing: 'down',
    };
    expect(switching.enterArea('s1', studio, T * 2)).toBe(true);
    expect(seatOf(switching, switcher)).toBe(NO_SEAT);

    // And a release forgets the whole session.
    const leaving = new LobbyPresence();
    const leaver = join(leaving, 's1', 100, 100);
    sit(leaving, 's1');
    leaving.release('s1', T * 2);
    expect(leaving.peers.get(leaver)).toBeUndefined();
  });

  it('refuses a seat claimed from a shared room, whatever its coordinates say', () => {
    const registry = new LobbyPresence();
    const id = join(registry, 's1', 100, 100);
    const inStudio = {
      x: STUDIO_PRESENCE_GRID.originX + STUDIO_PRESENCE_GRID.tileSize * 2,
      y: STUDIO_PRESENCE_GRID.originY + STUDIO_PRESENCE_GRID.tileSize * 2,
    };
    expect(registry.enterArea('s1', { area: 'studio', ...inStudio, facing: 'down' }, T)).toBe(true);
    // A seat's own street spot sent as a Studio move: a shared room has no benches.
    const spot = STREET_SEATS[0]!;
    registry.move('s1', { x: spot.x, y: spot.y, facing: 'down', seat: 0 }, T * 2);
    expect(seatOf(registry, id)).toBe(NO_SEAT);
  });

  it('writes no seat for a throttled or rejected move', () => {
    const registry = new LobbyPresence();
    const id = join(registry, 's1', 100, 100);
    const spot = STREET_SEATS[4]!;
    // Inside the rate floor, once the move burst (D-086) is spent: nothing is
    // written at all, so a seat claim inside it changes nothing either.
    for (let burst = 0; burst < MOVE_BURST; burst += 1) {
      expect(registry.move('s1', { x: 101 + burst, y: 100, facing: 'down' }, T)).toBe('applied');
    }
    expect(registry.move('s1', { x: spot.x, y: spot.y, facing: spot.facing, seat: 4 }, T)).toBe('throttled');
    expect(seatOf(registry, id)).toBe(NO_SEAT);
    // A malformed position is refused before the seat is ever looked at.
    expect(registry.move('s1', { x: Number.NaN, y: spot.y, seat: 4 }, T * 4)).toBe('rejected');
    expect(seatOf(registry, id)).toBe(NO_SEAT);
  });
});
