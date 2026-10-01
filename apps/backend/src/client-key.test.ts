import { describe, expect, it, vi } from 'vitest';
import { ClientKeyer, PerClientRateLimiter, isLoopback, requestClientKey } from './client-key.js';

/** D-084: per-client limits keyed by a salted hash, held in memory, evicted, never logged. */

describe('ClientKeyer', () => {
  it('derives a fixed-length key that hides the address and changes with the salt', () => {
    const one = new ClientKeyer(Buffer.alloc(32, 1));
    const key = one.key('198.51.100.1');
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(key).not.toContain('198');
    expect(one.key('198.51.100.1')).toBe(key);
    expect(one.key('198.51.100.2')).not.toBe(key);
    expect(new ClientKeyer(Buffer.alloc(32, 2)).key('198.51.100.1')).not.toBe(key);
    expect(() => new ClientKeyer(Buffer.alloc(8))).toThrow(/too short/);
  });

  it('trusts the edge\'s key only from a loopback peer, and keys anything else itself', () => {
    const keyer = new ClientKeyer(Buffer.alloc(32, 3));
    const edgeKey = 'a'.repeat(32);
    expect(requestClientKey(keyer, '127.0.0.1', edgeKey)).toBe(edgeKey);
    expect(requestClientKey(keyer, '::ffff:127.0.0.1', edgeKey)).toBe(edgeKey);
    expect(requestClientKey(keyer, '203.0.113.9', edgeKey)).toBe(keyer.key('203.0.113.9'));
    expect(requestClientKey(keyer, '127.0.0.1', 'not-a-key')).toBe(keyer.key('127.0.0.1'));
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('10.0.0.1')).toBe(false);
  });
});

describe('PerClientRateLimiter', () => {
  it('gives each client its own bucket, refilled over time', () => {
    let now = 0;
    const limiter = new PerClientRateLimiter(2, 1_000, () => now);
    expect([limiter.take('a'), limiter.take('a'), limiter.take('a')]).toEqual([true, true, false]);
    // Another client is unaffected.
    expect(limiter.take('b')).toBe(true);
    now = 1_000;
    expect([limiter.take('a'), limiter.take('a')]).toEqual([true, false]);
  });

  it('holds at most maxClients buckets, dropping the least recently used', () => {
    const limiter = new PerClientRateLimiter(1, 60_000, () => 0, 3);
    for (const key of ['a', 'b', 'c']) limiter.take(key);
    limiter.take('a');
    limiter.take('d');
    expect(limiter.size).toBe(3);
    // 'b' was evicted, so it starts full again; 'a' was kept and is spent.
    expect(limiter.take('b')).toBe(true);
    expect(limiter.take('a')).toBe(false);
  });

  it('sweeps buckets idle long enough to be full again', () => {
    let now = 0;
    const limiter = new PerClientRateLimiter(2, 1_000, () => now);
    for (let index = 0; index < 255; index += 1) limiter.take(`k${index}`);
    expect(limiter.size).toBe(255);
    now = 2_000;
    limiter.take('fresh');
    expect(limiter.size).toBe(1);
  });

  it('writes nothing', () => {
    const write = vi.spyOn(process.stdout, 'write');
    const log = vi.spyOn(console, 'log');
    const limiter = new PerClientRateLimiter(1, 1_000, () => 0);
    limiter.take('a'); limiter.take('a');
    expect(write).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
