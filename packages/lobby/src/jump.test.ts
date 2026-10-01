/**
 * D-097: the jump in the registry. A `jump` message bumps the sender's own
 * byte counter, at most once per `JUMP_MIN_INTERVAL_MS`, on the street or
 * the roof; the counter rides the presence entry, so it reaches exactly the
 * observers whose view already holds that player — the same area, inside
 * the interest radius — and costs four bytes in one patch.
 */

import { describe, expect, it } from 'vitest';
import { Encoder, Metadata, StateView } from '@colyseus/schema';
import { ROOF_PRESENCE_GRID, STUDIO_PRESENCE_GRID, type GameId } from '@strkworld/shared';
import { JUMP_CLIENT_INTERVAL_MS, JUMP_MIN_INTERVAL_MS, MAX_MESSAGES_PER_SECOND, MESSAGE } from './config';
import { LobbyPresence } from './presence';
import { PresenceEntry } from './state';

const T = 32;
const roof = (x: number, y: number) => ({ x: ROOF_PRESENCE_GRID.originX + x * T + T / 2, y: ROOF_PRESENCE_GRID.originY + y * T + T / 2 });
const studio = (x: number, y: number) => ({ x: STUDIO_PRESENCE_GRID.originX + x * T + T / 2, y: STUDIO_PRESENCE_GRID.originY + y * T + T / 2 });

function join(registry: LobbyPresence, session: string, at: { x: number; y: number }): GameId {
  const outcome = registry.admit(session, at);
  if (!outcome.ok) throw new Error(`admit failed: ${outcome.reason}`);
  return outcome.gameId;
}

const jumpsOf = (registry: LobbyPresence, id: GameId) => registry.peers.get(id)?.jumps;

describe('the jump message (D-097)', () => {
  it('is one payload-free verb with a strict server floor under the client\'s', () => {
    expect(MESSAGE.jump).toBe('jump');
    expect(JUMP_MIN_INTERVAL_MS).toBe(400);
    expect(JUMP_CLIENT_INTERVAL_MS).toBeGreaterThan(JUMP_MIN_INTERVAL_MS);
    // Moves (20/s), sandbox actions (5/s), kicks (3.3/s) and jumps together
    // stay under the disconnecting ceiling.
    expect(20 + 5 + 1000 / 300 + 1000 / JUMP_CLIENT_INTERVAL_MS).toBeLessThan(MAX_MESSAGES_PER_SECOND);
  });

  it('starts every entry at 0 and declares the counter as a single byte', () => {
    const registry = new LobbyPresence();
    const id = join(registry, 'a', { x: 100, y: 100 });
    expect(jumpsOf(registry, id)).toBe(0);
    const fields = Metadata.getFields(PresenceEntry) as Record<string, unknown>;
    expect(fields['jumps']).toBe('uint8');
  });

  it('bumps only the sender\'s counter, and wraps at 256', () => {
    const registry = new LobbyPresence();
    const a = join(registry, 'a', { x: 100, y: 100 });
    const b = join(registry, 'b', { x: 140, y: 100 });
    expect(registry.jump('a', 1000)).toBe('applied');
    expect(jumpsOf(registry, a)).toBe(1);
    expect(jumpsOf(registry, b)).toBe(0);
    (registry.peers.get(a) as PresenceEntry).jumps = 255;
    expect(registry.jump('a', 2000)).toBe('applied');
    expect(jumpsOf(registry, a)).toBe(0);
  });

  it('rate-limits strictly: at most one jump per 400 ms per session, each session its own', () => {
    const registry = new LobbyPresence();
    const a = join(registry, 'a', { x: 100, y: 100 });
    join(registry, 'b', { x: 140, y: 100 });
    expect(registry.jump('a', 1000)).toBe('applied');
    expect(registry.jump('a', 1001)).toBe('throttled');
    expect(registry.jump('a', 1000 + JUMP_MIN_INTERVAL_MS - 1)).toBe('throttled');
    expect(registry.jump('b', 1001)).toBe('applied');
    expect(registry.jump('a', 1000 + JUMP_MIN_INTERVAL_MS)).toBe('applied');
    expect(jumpsOf(registry, a)).toBe(2);
    // A burst is not banked: the floor is a strict gap, not a bucket.
    expect(registry.jump('a', 10_000)).toBe('applied');
    expect(registry.jump('a', 10_001)).toBe('throttled');
    expect(registry.jump('a', Number.NaN)).toBe('throttled');
  });

  it('is refused while suspended, in the Studio, and for an unknown session', () => {
    const registry = new LobbyPresence();
    const a = join(registry, 'a', { x: 100, y: 100 });
    const d = join(registry, 'd', { x: 100, y: 100 });
    expect(registry.jump('nobody', 1000)).toBe('absent');
    registry.suspend('a');
    expect(registry.jump('a', 1000)).toBe('absent');
    expect(registry.enterArea('d', { area: 'studio', ...studio(6, 5) }, 1000)).toBe(true);
    expect(registry.jump('d', 2000)).toBe('absent');
    expect(jumpsOf(registry, d)).toBe(0);
    expect(registry.resume('a', { x: 100, y: 100, facing: 'down', sprite: 'avatar-1' }, 3000)).toBe(true);
    expect(registry.jump('a', 4000)).toBe('applied');
    expect(jumpsOf(registry, a)).toBe(1);
  });

  it('works on the roof, and a roof jump stays in views that already hold that player', () => {
    const registry = new LobbyPresence();
    const up1 = join(registry, 'up1', { x: 100, y: 100 });
    join(registry, 'up2', { x: 100, y: 100 });
    // A street player right under the deck's coordinates, and one in the Studio.
    join(registry, 'below', { x: roof(3, 3).x, y: roof(3, 3).y + 3 * T });
    join(registry, 'dresser', { x: 100, y: 100 });
    registry.suspend('up1');
    registry.suspend('up2');
    expect(registry.enterArea('up1', { area: 'roof', ...roof(3, 3) }, 1000)).toBe(true);
    expect(registry.enterArea('up2', { area: 'roof', ...roof(4, 2) }, 1000)).toBe(true);
    expect(registry.enterArea('dresser', { area: 'studio', ...studio(6, 5) }, 1000)).toBe(true);
    expect(registry.jump('up1', 2000)).toBe('applied');
    expect(jumpsOf(registry, up1)).toBe(1);
    const sees = (observer: string) => registry.visibleTo(observer).map((entry) => entry.gameId);
    expect(sees('up2')).toContain(up1);
    // The counter rides the entry, and neither of these is ever sent it.
    expect(sees('below')).not.toContain(up1);
    expect(sees('dresser')).not.toContain(up1);
  });

  it('costs an observer four bytes in one patch, and nothing for an observer who does not see the jumper', () => {
    const registry = new LobbyPresence();
    const a = join(registry, 'a', { x: 100, y: 100 });
    const b = join(registry, 'b', { x: 120, y: 100 });
    const far = join(registry, 'far', { x: 5000, y: 100 });
    const encoder = new Encoder(registry.state);
    // b's view holds a and b; far's view holds only far (out of radius).
    const near = new StateView();
    near.add(registry.peers.get(a) as PresenceEntry);
    near.add(registry.peers.get(b) as PresenceEntry);
    const distant = new StateView();
    distant.add(registry.peers.get(far) as PresenceEntry);
    const full = { offset: 0 };
    encoder.encodeAll(full);
    encoder.encodeAllView(near, full.offset, full);
    encoder.encodeAllView(distant, full.offset, full);
    encoder.discardChanges();

    const patch = (): { near: number; distant: number } => {
      const it = { offset: 0 };
      encoder.encode(it);
      const shared = it.offset;
      const nearBytes = encoder.encodeView(near, shared, it).byteLength - shared;
      const it2 = { offset: shared };
      const distantBytes = encoder.encodeView(distant, shared, it2).byteLength - shared;
      encoder.discardChanges();
      return { near: nearBytes, distant: distantBytes };
    };
    // The first patch flushes the views' own additions; the next is empty.
    patch();
    expect(patch()).toEqual({ near: 0, distant: 0 });
    registry.jump('a', 1000);
    expect(patch()).toEqual({ near: 4, distant: 0 });
    expect(patch()).toEqual({ near: 0, distant: 0 });
  });
});
