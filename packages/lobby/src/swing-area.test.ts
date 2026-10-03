/**
 * D-132: the lookout swing through the registry — the half the rules module
 * cannot see. The server's own teleports onto the seat and back, the seat
 * being ledge to everyone but its rider, every way a ride ends through a
 * session's life (suspend, area change, disconnect), and the roof-membership
 * test the room's view filter asks.
 */

import { describe, expect, it } from 'vitest';
import {
  ROOF_PRESENCE_GRID,
  SWING_COOLDOWN_MS,
  SWING_INTENT_MIN_INTERVAL_MS,
  SWING_RIDE_MS,
  roofTileCentre,
  type GameId,
} from '@strkworld/shared';
import { isAreaWalkable } from './areas';
import { LobbyPresence } from './presence';

const APPROACH = roofTileCentre({ x: 3, y: 4 });
const SEAT = roofTileCentre({ x: 3, y: 5 });
const AWAY = roofTileCentre({ x: 1, y: 1 });

/** A session admitted and live on the roof, standing at `at`. */
function onRoof(registry: LobbyPresence, key: string, at = APPROACH, now = 0): GameId {
  const outcome = registry.admit(key, { x: 100, y: 100 });
  if (!outcome.ok) throw new Error(outcome.reason);
  expect(registry.enterArea(key, { area: 'roof', x: at.x, y: at.y, facing: 'down', sprite: 'avatar-2' }, now)).toBe(true);
  return outcome.gameId;
}

function positionOf(registry: LobbyPresence, key: string) {
  const entry = registry.entryFor(key);
  if (entry === undefined) return null;
  return { x: entry.position.x, y: entry.position.y, facing: entry.facing };
}

/** A registry with 'a' riding from `now`. */
function riding(now = 1000): { registry: LobbyPresence; a: GameId } {
  const registry = new LobbyPresence();
  const a = onRoof(registry, 'a', APPROACH, now);
  expect(registry.swingClaim('a', now)).toBe('applied');
  return { registry, a };
}

const later = (t: number) => t + SWING_INTENT_MIN_INTERVAL_MS;

describe('the roof swing through the registry (D-132)', () => {
  it('stands the rider on the seat itself: the claim message carries no position', () => {
    const { registry } = riding();
    expect(positionOf(registry, 'a')).toEqual({ x: SEAT.x, y: SEAT.y, facing: 'down' });
  });

  it('judges the claim from the position the registry holds, not one a client sent', () => {
    const registry = new LobbyPresence();
    onRoof(registry, 'a', AWAY);
    // Standing away from the frame, the claim is refused however it was sent.
    expect(registry.swingClaim('a', 1000)).toBe('rejected');
    expect(positionOf(registry, 'a')).toMatchObject({ x: AWAY.x, y: AWAY.y });
  });

  it('refuses a claim from a session that is not on the roof at all', () => {
    const registry = new LobbyPresence();
    const outcome = registry.admit('a', { x: 100, y: 100 });
    expect(outcome.ok).toBe(true);
    // Still on the street: there is no swing to claim.
    expect(registry.swingClaim('a', 1000)).toBe('rejected');
    expect(registry.swingSnapshot(1000).phase).toBe('idle');
  });

  it('refuses a claim from a suspended session', () => {
    const registry = new LobbyPresence();
    onRoof(registry, 'a');
    registry.suspend('a', 500);
    expect(registry.swingClaim('a', 1000)).toBe('rejected');
  });

  it('keeps the seat ledge to everyone else, so only its rider stands there', () => {
    // The seat tile is not walkable roof for a player who is not riding.
    const grid = ROOF_PRESENCE_GRID;
    expect(isAreaWalkable('roof', SEAT.x, SEAT.y)).toBe(false);
    // The approach in front of it is ordinary deck.
    expect(isAreaWalkable('roof', APPROACH.x, APPROACH.y)).toBe(true);
    expect(grid.tileSize).toBeGreaterThan(0);
  });

  it('stands the rider back on the step-off tile when the cooldown closes', () => {
    const { registry } = riding();
    const over = 1000 + SWING_RIDE_MS;
    expect(registry.swingTick(over)).toBe(false); // the ride ends; nobody moves yet
    expect(positionOf(registry, 'a')).toMatchObject({ x: SEAT.x, y: SEAT.y });
    // The cooldown's close is what puts them down, facing back onto the deck.
    expect(registry.swingTick(over + SWING_COOLDOWN_MS)).toBe(true);
    expect(positionOf(registry, 'a')).toEqual({ x: APPROACH.x, y: APPROACH.y, facing: 'up' });
    expect(registry.swingSnapshot(over + SWING_COOLDOWN_MS).phase).toBe('idle');
  });

  it('ends the ride when the rider leaves the roof, and leaves them where they went', () => {
    const { registry } = riding();
    const at = later(1000);
    expect(registry.enterArea('a', { area: 'street', x: 100, y: 100, facing: 'down', sprite: 'avatar-2' }, at)).toBe(true);
    expect(registry.swingSnapshot(at)).toMatchObject({ phase: 'cooldown', reason: 'left', riderId: null });
    // The cooldown closes without dragging them back onto the roof.
    registry.swingTick(at + SWING_COOLDOWN_MS);
    expect(positionOf(registry, 'a')).toMatchObject({ x: 100, y: 100 });
  });

  it('ends the ride when the rider suspends', () => {
    const { registry } = riding();
    const at = later(1000);
    registry.suspend('a', at);
    expect(registry.swingSnapshot(at)).toMatchObject({ phase: 'cooldown', reason: 'left' });
  });

  it('ends the ride when the rider disconnects, and frees the swing', () => {
    const { registry } = riding();
    const at = later(1000);
    registry.release('a', at);
    expect(registry.swingSnapshot(at)).toMatchObject({ phase: 'cooldown', reason: 'disconnect', riderId: null });
    // Nothing is placed at the close: they have gone.
    expect(registry.swingTick(at + SWING_COOLDOWN_MS)).toBe(false);
    expect(registry.swingSnapshot(at + SWING_COOLDOWN_MS).phase).toBe('idle');
  });

  it('lets the next player claim once the swing is free, and only then', () => {
    const { registry } = riding();
    onRoof(registry, 'b', APPROACH, 1000);
    // First claim wins: 'b' finds it busy for the whole ride and cooldown.
    expect(registry.swingClaim('b', later(1000))).toBe('busy');
    const free = 1000 + SWING_RIDE_MS + SWING_COOLDOWN_MS;
    registry.swingTick(free);
    expect(registry.swingClaim('b', free)).toBe('applied');
    expect(positionOf(registry, 'b')).toMatchObject({ x: SEAT.x, y: SEAT.y });
  });

  it('gets the rider off early on a leave, and puts them down after the cooldown', () => {
    const { registry } = riding();
    const at = later(1000);
    expect(registry.swingLeave('a', at)).toBe('applied');
    expect(registry.swingSnapshot(at)).toMatchObject({ phase: 'cooldown', reason: 'left' });
    registry.swingTick(at + SWING_COOLDOWN_MS);
    expect(positionOf(registry, 'a')).toEqual({ x: APPROACH.x, y: APPROACH.y, facing: 'up' });
  });

  it('ignores a leave from a player who is not the rider', () => {
    const { registry } = riding();
    onRoof(registry, 'b', APPROACH, 1000);
    expect(registry.swingLeave('b', later(1000))).toBe('absent');
    expect(registry.swingSnapshot(1000).phase).toBe('riding');
  });

  it('keeps a mid-ride look change from knocking the rider off the seat', () => {
    const { registry } = riding();
    const at = later(1000);
    // The seat is ledge, so this request would fail the walkable check; the
    // refresh rule takes the sprite and leaves the position alone.
    registry.enterArea('a', { area: 'roof', x: SEAT.x, y: SEAT.y, facing: 'down', sprite: 'avatar-4' }, at);
    expect(registry.swingSnapshot(at).phase).toBe('riding');
    expect(positionOf(registry, 'a')).toMatchObject({ x: SEAT.x, y: SEAT.y });
  });

  // -- what reaches whom -----------------------------------------------------

  it('calls exactly the roof\'s live sessions roof members, which is the view filter\'s question', () => {
    const registry = new LobbyPresence();
    onRoof(registry, 'a');
    registry.admit('b', { x: 100, y: 100 });
    expect(registry.isRoofMember('a')).toBe(true);
    // On the street, so never sent the swing.
    expect(registry.isRoofMember('b')).toBe(false);
    // Nor an unknown connection.
    expect(registry.isRoofMember('nobody')).toBe(false);
    // Leaving the roof drops the membership with it.
    registry.enterArea('a', { area: 'street', x: 100, y: 100, facing: 'down', sprite: 'avatar-2' }, 2000);
    expect(registry.isRoofMember('a')).toBe(false);
  });

  it('runs the swing clock only while a ride or its cooldown is on', () => {
    const registry = new LobbyPresence();
    onRoof(registry, 'a');
    expect(registry.swingActive).toBe(false);
    registry.swingClaim('a', 1000);
    expect(registry.swingActive).toBe(true);
    registry.swingTick(1000 + SWING_RIDE_MS + SWING_COOLDOWN_MS);
    expect(registry.swingActive).toBe(false);
  });

  it('puts no address, balance or name in the swing: only the ephemeral presence id', () => {
    const { registry, a } = riding();
    const snapshot = registry.swingSnapshot(1000);
    expect(snapshot.riderId).toBe(a);
    // The connection key never leaves the server.
    expect(JSON.stringify(snapshot)).not.toContain('"a"');
    expect(Object.keys(snapshot).sort()).toEqual(['phase', 'reason', 'riderId', 'round', 'secondsLeft']);
  });
});
