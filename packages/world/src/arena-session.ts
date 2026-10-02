import type { ArenaChannel, ArenaSession, ArenaSessionHost } from './arena-channel.js';

/**
 * D-114: the arena's combat session (stream C fills this in).
 *
 * PR 0 ships a no-op so the world scene (stream A) can wire it now: the ring
 * is never walkable, no input is consumed and there is no frame to draw.
 * C replaces the body; the signature is the contract and does not change.
 */
export function createArenaSession(channel: ArenaChannel, host: ArenaSessionHost): ArenaSession {
  void channel;
  void host;
  return Object.freeze({
    update(_deltaMs: number): void {},
    isRingTileWalkable(_tileX: number, _tileY: number): boolean {
      return false;
    },
    onInteract(): boolean {
      return false;
    },
    onPrimary(): boolean {
      return false;
    },
    frame(): null {
      return null;
    },
    destroy(): void {},
  });
}
