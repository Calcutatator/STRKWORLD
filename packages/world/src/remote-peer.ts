import type { Facing } from '@strkworld/shared';

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
export const DEFAULT_REMOTE_SPRITE = 'avatar-1';

/** The current approved lobby cosmetic key registry. */
export const REMOTE_SPRITE_KEYS: readonly string[] = [
  'avatar-1',
  'avatar-2',
  'avatar-3',
  'avatar-4',
  'avatar-5',
  'avatar-6',
  'avatar-7',
  'avatar-8',
];

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

  const id = value.id;
  const x = value.x;
  const y = value.y;
  const facing = value.facing;

  if (typeof id !== 'string' || !OPAQUE_ID.test(id)) return null;
  if (typeof x !== 'number' || !Number.isFinite(x) || Math.abs(x) > REMOTE_WORLD_LIMIT) {
    return null;
  }
  if (typeof y !== 'number' || !Number.isFinite(y) || Math.abs(y) > REMOTE_WORLD_LIMIT) {
    return null;
  }
  if (!FACINGS.includes(facing as Facing)) return null;

  const sprite = value.sprite;
  return Object.freeze({
    id,
    x,
    y,
    facing: facing as Facing,
    sprite:
      typeof sprite === 'string' && REMOTE_SPRITE_KEYS.includes(sprite)
        ? sprite
        : DEFAULT_REMOTE_SPRITE,
  });
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
  const copy = snapshot.map((entry) => {
    // Copy only the frozen seam. Extra runtime fields cannot enter the source
    // even if a caller has received a wider object from a transport adapter.
    const value: Record<string, unknown> = isRecord(entry)
      ? entry
      : ({} as Record<string, unknown>);
    return Object.freeze({
      id: value.id as string,
      x: value.x as number,
      y: value.y as number,
      facing: value.facing as Facing,
      sprite: value.sprite as string,
    });
  });
  return Object.freeze(copy);
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
  const listeners = new Set<RemotePeerListener>();

  const source: RemotePeerSource = {
    subscribe(listener) {
      listeners.add(listener);
      listener(current);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        listeners.delete(listener);
      };
    },
  };

  return {
    source,

    publish(snapshot) {
      current = immutableSnapshot(snapshot);
      for (const listener of listeners) listener(current);
    },

    clear() {
      this.publish([]);
    },
  };
}
