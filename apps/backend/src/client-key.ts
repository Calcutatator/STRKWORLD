import { createHmac, randomBytes } from 'node:crypto';

/**
 * A per-client rate limit without keeping a client identifier (D-014, D-084).
 *
 * The key is an HMAC of the client's address under a random salt drawn when
 * the process starts and never written anywhere, so it is not reversible to
 * an address, cannot be matched across restarts, and nothing else in the
 * process can relate it to a player. It is never logged. The buckets live in
 * memory only, are bounded in number, and are dropped once idle long enough
 * to have refilled: a bucket that is full again holds no information.
 *
 * In the Railway composition the public edge (`deploy/fly/src/edge.ts`)
 * computes the key under its own salt and sends it to this service on the
 * loopback connection as `x-strkworld-client`; this service trusts that header
 * only from a loopback peer and otherwise keys the socket's own address.
 */

export const CLIENT_KEY_HEADER = 'x-strkworld-client';

const KEY_PATTERN = /^[0-9a-f]{32}$/;

export function isClientKey(value: unknown): value is string {
  return typeof value === 'string' && KEY_PATTERN.test(value);
}

export class ClientKeyer {
  private readonly salt: Buffer;

  constructor(salt: Buffer = randomBytes(32)) {
    if (salt.length < 16) throw new Error('The client-key salt is too short.');
    this.salt = salt;
  }

  key(address: string): string {
    return createHmac('sha256', this.salt).update(address).digest('hex').slice(0, 32);
  }
}

/** Whether a socket peer is this machine, so its `x-strkworld-client` header is the edge's. */
export function isLoopback(address: string | undefined): boolean {
  if (!address) return false;
  return address === '::1' || address.startsWith('127.') || address.startsWith('::ffff:127.');
}

/**
 * The client key for a request: the edge's, from a loopback peer, or this
 * service's own HMAC of the peer's address.
 */
export function requestClientKey(keyer: ClientKeyer, remoteAddress: string | undefined, header: unknown): string {
  if (isLoopback(remoteAddress) && isClientKey(header)) return header;
  return keyer.key(remoteAddress ?? 'unknown');
}

/**
 * A token bucket per client key: `capacity` requests at once, refilled one
 * every `refillMs`. At most `maxClients` buckets are held; past that the
 * least recently used is dropped, and a bucket idle long enough to be full
 * again is dropped on the next sweep.
 */
export class PerClientRateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  private takes = 0;

  constructor(
    private readonly capacity: number,
    private readonly refillMs: number,
    private readonly now: () => number = Date.now,
    private readonly maxClients = 10_000,
  ) {
    if (![capacity, refillMs, maxClients].every((value) => Number.isSafeInteger(value) && value > 0)) {
      throw new Error('The per-client rate limit must be positive integers.');
    }
  }

  take(key: string): boolean {
    const now = this.now();
    if (++this.takes % 256 === 0) this.sweep(now);
    const held = this.buckets.get(key);
    const tokens = held
      ? Math.min(this.capacity, held.tokens + Math.max(0, now - held.at) / this.refillMs)
      : this.capacity;
    // Re-inserted, so the map's order is least recently used first.
    this.buckets.delete(key);
    const allowed = tokens >= 1;
    this.buckets.set(key, { tokens: allowed ? tokens - 1 : tokens, at: now });
    while (this.buckets.size > this.maxClients) {
      const oldest = this.buckets.keys().next().value as string;
      this.buckets.delete(oldest);
    }
    return allowed;
  }

  /** How many buckets are held: for tests, never exported as a metric. */
  get size(): number {
    return this.buckets.size;
  }

  private sweep(now: number): void {
    const idleMs = this.capacity * this.refillMs;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.at >= idleMs) this.buckets.delete(key);
    }
  }
}
