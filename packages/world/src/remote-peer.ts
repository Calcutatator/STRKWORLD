import type { AvatarSpriteKey, Facing } from '@strkworld/shared';
import {
  AVATAR_SPRITE_KEYS,
  DEFAULT_AVATAR_SPRITE,
  validateAvatarSprite,
} from './avatar-state.js';

/**
 * The complete World-side shape for one nearby avatar.
 *
 * `id` is opaque to this package. It is deliberately not called `gameId` so
 * the World does not grow a dependency on the lobby's identity vocabulary.
 * There are no timestamps, revisions, map IDs or connection metadata here.
 */
export interface RemotePeerSnapshot {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly facing: Facing;
  readonly sprite: string;
}

export type RemotePeerListener = (snapshot: readonly RemotePeerSnapshot[]) => void;

/** The only operation the Shell needs from the World-owned source. */
export interface RemotePeerSource {
  /** Replay the latest immutable full snapshot synchronously. */
  subscribe(listener: RemotePeerListener): () => void;
}

/** Publisher half kept by the Shell; only `source` crosses the World seam. */
export interface RemotePeerSourceController {
  readonly source: RemotePeerSource;
  publish(snapshot: readonly RemotePeerSnapshot[]): void;
  clear(): void;
}

/** Lobby/world coordinates are public, but remain bounded to prevent junk data. */
export const REMOTE_WORLD_LIMIT = 8192;

/** Cosmetic key used when an adapter sends an unknown sprite. */
export const DEFAULT_REMOTE_SPRITE = DEFAULT_AVATAR_SPRITE;

/** The current approved lobby cosmetic key registry. */
export const REMOTE_SPRITE_KEYS: readonly AvatarSpriteKey[] = AVATAR_SPRITE_KEYS;

const FACINGS: readonly Facing[] = ['up', 'down', 'left', 'right'];
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Validate one untrusted snapshot entry. Invalid identity/position/pose data
 * is rejected; cosmetic data fails closed to the local procedural texture.
 */
export function validateRemotePeer(value: unknown): RemotePeerSnapshot | null {
  if (!isRecord(value)) return null;

  const id = ownDataField(value, 'id');
  const x = ownDataField(value, 'x');
  const y = ownDataField(value, 'y');
  const facing = ownDataField(value, 'facing');

  if (typeof id !== 'string' || !OPAQUE_ID.test(id)) return null;
  if (typeof x !== 'number' || !Number.isFinite(x) || Math.abs(x) > REMOTE_WORLD_LIMIT) {
    return null;
  }
  if (typeof y !== 'number' || !Number.isFinite(y) || Math.abs(y) > REMOTE_WORLD_LIMIT) {
    return null;
  }
  if (!FACINGS.includes(facing as Facing)) return null;

  const sprite = ownDataField(value, 'sprite');
  return Object.freeze({
    id,
    x,
    y,
    facing: facing as Facing,
    sprite: validateAvatarSprite(sprite),
  });
}

function ownDataField(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

/**
 * Reconcile one complete authoritative snapshot.
 *
 * The optional previous map is accepted to make call sites explicit about
 * replacement semantics, but is intentionally not consulted: omitted IDs
 * disappear and an empty snapshot clears the map. If malformed input repeats
 * an ID, the last valid occurrence wins in arrival order.
 */
export function reconcileRemotePeers(
  snapshot: readonly unknown[],
  _previous?: ReadonlyMap<string, RemotePeerSnapshot>,
): ReadonlyMap<string, RemotePeerSnapshot> {
  const peers = new Map<string, RemotePeerSnapshot>();
  for (const candidate of snapshot) {
    const peer = validateRemotePeer(candidate);
    if (peer !== null) peers.set(peer.id, peer);
  }
  return peers;
}

function immutableSnapshot(snapshot: readonly RemotePeerSnapshot[]): readonly RemotePeerSnapshot[] {
  // Reuse the same validation policy as the renderer so every source
  // subscriber receives only an opaque, finite, legal presentation snapshot.
  // `reconcileRemotePeers` also gives duplicate IDs deterministic last-wins
  // semantics and maps unknown cosmetic keys to the safe local fallback.
  return Object.freeze([...reconcileRemotePeers(snapshot).values()]);
}

/**
 * Create the replaying retained source used by the Shell composition root.
 * Publishing is synchronous and preserves arrival order; subscribers are
 * never called after their idempotent unsubscribe.
 */
export function createRemotePeerSource(
  initial: readonly RemotePeerSnapshot[] = [],
): RemotePeerSourceController {
  let current = immutableSnapshot(initial);
  const listeners = new Map<RemotePeerListener, symbol>();
  const pending: Array<readonly RemotePeerSnapshot[]> = [];
  let publishing = false;

  function drain(): void {
    if (publishing) return;
    publishing = true;
    try {
      while (pending.length > 0) {
        current = pending.shift()!;
        for (const [listener, token] of [...listeners]) {
          if (listeners.get(listener) === token) listener(current);
        }
      }
    } catch (error) {
      pending.length = 0;
      throw error;
    } finally {
      publishing = false;
    }
  }

  const source: RemotePeerSource = {
    subscribe(listener) {
      const token = Symbol();
      listeners.set(listener, token);
      let active = true;
      const unsubscribe = (): void => {
        if (!active) return;
        active = false;
        if (listeners.get(listener) === token) listeners.delete(listener);
      };
      try {
        listener(current);
      } catch (error) {
        unsubscribe();
        throw error;
      }
      return unsubscribe;
    },
  };

  return {
    source,

    publish(snapshot) {
      pending.push(immutableSnapshot(snapshot));
      drain();
    },

    clear() {
      this.publish([]);
    },
  };
}
