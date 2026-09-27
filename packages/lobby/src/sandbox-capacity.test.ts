/**
 * The worst-case sandbox reaches a late joiner intact.
 *
 * With `peers` behind a `StateView`, every joiner's full state goes through
 * Colyseus's view path, which used to hand a stale 8 KB buffer to the
 * per-client encode: everything past 8 KB arrived as zeros, so a late joiner
 * saw a corrupted sandbox once it grew (see `STATE_ENCODE_BUFFER_BYTES` in
 * room.ts). These tests build the true worst case — the block cap spread over
 * every tile — and check it byte for byte.
 *
 * Seeding goes through two test-only, server-side seams, never client input:
 * the rules module is wrapped so every authority draws a fixed sequence
 * (spawn n lands on open tile n mod 784, colour n mod 8), and the registry's
 * spawn is wrapped so one spawner tick fills the sandbox to the cap.
 *
 * One server for the file, as the matchmaker is a process-global.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SchemaSerializer } from '@colyseus/core';
import { Encoder, Reflection, StateView } from '@colyseus/schema';
import {
  SANDBOX_AREA,
  SANDBOX_COLOURS,
  SANDBOX_MAX_BLOCKS,
  type SandboxColumn,
  type SandboxSnapshot,
} from '@strkworld/shared';
import { LobbyClient } from './client';
import { LobbyPresence } from './presence';
import { STATE_ENCODE_BUFFER_BYTES, reserveStateEncodeBuffer } from './room';
import type { SandboxAuthorityOptions } from './sandbox-rules';
import { startPresenceServer, type PresenceServer } from './server';
import type { PresenceEntry } from './state';

const TILES = SANDBOX_AREA.width * SANDBOX_AREA.height;

vi.mock('./sandbox-rules', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sandbox-rules')>();
  return {
    ...actual,
    createSandboxAuthority: (options?: SandboxAuthorityOptions) => {
      // Per authority: draws alternate tile, colour. With nobody inside the
      // area and no full stack, the open list is every tile in (y, x) order.
      let draw = 0;
      // vi.mock factories run before this file's imports, so the 28 x 28
      // area is spelled out rather than read from SANDBOX_AREA.
      const tiles = 28 * 28;
      return actual.createSandboxAuthority({
        ...options,
        random: () => {
          const n = Math.floor(draw / 2);
          const isTile = draw % 2 === 0;
          draw += 1;
          return isTile ? ((n % tiles) + 0.5) / tiles : ((n % 8) + 0.5) / 8;
        },
      });
    },
  };
});

/** The layout the fixed draws produce: every tile once, then 116 more on the first tiles. */
function worstCaseColumns(): SandboxColumn[] {
  const stacks = new Map<number, number[]>();
  for (let n = 0; n < SANDBOX_MAX_BLOCKS; n += 1) {
    const index = n % TILES;
    const stack = stacks.get(index) ?? [];
    stack.push(n % SANDBOX_COLOURS);
    stacks.set(index, stack);
  }
  return [...stacks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, colours]) => ({
      x: SANDBOX_AREA.x + (index % SANDBOX_AREA.width),
      y: SANDBOX_AREA.y + Math.floor(index / SANDBOX_AREA.width),
      colours,
    }));
}

function plain(columns: readonly SandboxColumn[]): SandboxColumn[] {
  return columns.map(({ x, y, colours }) => ({ x, y, colours: [...colours] }));
}

function blocksOf(snapshot: SandboxSnapshot): number {
  return snapshot.columns.reduce((sum, column) => sum + column.colours.length, 0);
}

async function waitFor<V>(
  read: () => V,
  ready: (value: V) => boolean,
  label: string,
  timeoutMs = 10_000,
): Promise<V> {
  const limit = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (ready(value)) return value;
    if (Date.now() > limit) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Every console.warn line, so an encoder overflow cannot pass silently. */
const warnings: string[] = [];
let server: PresenceServer;
const opened: LobbyClient[] = [];

/** Road tiles west of the sandbox: players here leave every sandbox tile open. */
const WAITING = { x: (SANDBOX_AREA.x - 4) * 32 + 16, y: 5 * 32 + 16 };

beforeAll(async () => {
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map(String).join(' '));
  });
  const spawnOne = LobbyPresence.prototype.spawnBlock;
  vi.spyOn(LobbyPresence.prototype, 'spawnBlock').mockImplementation(function fill(
    this: LobbyPresence,
  ) {
    let last = null;
    for (;;) {
      const tile = spawnOne.call(this);
      if (tile === null) return last;
      last = tile;
    }
  });
  server = await startPresenceServer({
    hostname: '127.0.0.1',
    port: 53_500 + Math.floor(Math.random() * 1_500),
    portAttempts: 40,
    room: { sandboxSpawnIntervalMs: 50 },
  });
});

afterEach(async () => {
  while (opened.length > 0) await opened.pop()?.disconnect().catch(() => undefined);
});

afterAll(async () => {
  await server.shutdown();
  vi.restoreAllMocks();
});

describe('the full sandbox reaches a late joiner', () => {
  it('reserves an encode buffer the worst case fits before any room exists', () => {
    expect(Encoder.BUFFER_SIZE).toBeGreaterThanOrEqual(STATE_ENCODE_BUFFER_BYTES);
    expect(STATE_ENCODE_BUFFER_BYTES).toBe(64 * 1024);
  });

  it('gives a new client exactly the room’s 900 blocks over all 784 tiles', async () => {
    const early = new LobbyClient({ endpoint: server.endpoint, start: WAITING });
    opened.push(early);
    await early.connect();
    const full = await waitFor(
      () => early.sandbox(),
      (snapshot) => blocksOf(snapshot) === SANDBOX_MAX_BLOCKS,
      'the sandbox to fill',
    );
    expect(full.columns).toHaveLength(TILES);
    expect(plain(full.columns)).toEqual(worstCaseColumns());

    const late = new LobbyClient({
      endpoint: server.endpoint,
      start: { x: WAITING.x + 20, y: WAITING.y },
    });
    opened.push(late);
    await late.connect();

    // The whole full state was decoded before connect resolved.
    expect(plain(late.sandbox().columns)).toEqual(worstCaseColumns());
    // Presence is encoded after the sandbox, so it survives only if every
    // byte before it did.
    await waitFor(
      () => late.peers().some((peer) => peer.gameId === early.gameId),
      Boolean,
      'the late joiner to see the early one',
    );
    expect(late.status).toBe('connected');
    expect(warnings.filter((line) => line.includes('buffer overflow'))).toEqual([]);
  });
});

describe('the worst case fits one encode buffer', () => {
  it('encodes 900 blocks over 784 tiles plus 128 visible peers without overflowing', () => {
    reserveStateEncodeBuffer();
    const registry = new LobbyPresence({
      capacity: 128,
      maxVisiblePeers: 128,
      interestRadius: 16_384,
    });
    registry.spawnBlock(); // the wrapped spawn fills to the cap
    expect(registry.sandboxBlocks).toBe(SANDBOX_MAX_BLOCKS);
    const ids: string[] = [];
    for (let n = 0; n < 128; n += 1) {
      const outcome = registry.admit(`s${n}`, { x: 10 + n, y: 10 });
      if (outcome.ok) ids.push(outcome.gameId);
    }
    expect(ids).toHaveLength(128);

    const serializer = new SchemaSerializer();
    serializer.reset(registry.state);
    const view = new StateView();
    for (const id of ids) view.add(registry.peers.get(id) as PresenceEntry);
    const before = warnings.length;
    const bytes = serializer.getFullState({ view } as never);

    expect(warnings.slice(before)).toEqual([]);
    expect(bytes.byteLength).toBeLessThan(STATE_ENCODE_BUFFER_BYTES);
    const encoder = (serializer as unknown as { encoder: Encoder }).encoder;
    const decoder = Reflection.decode(Reflection.encode(encoder));
    decoder.decode(bytes, { offset: 1 });
    const json = (decoder.state as { toJSON(): { sandbox?: object; peers?: object } }).toJSON();
    const decoded = Object.values(json.sandbox ?? {})
      .map((column) => column as SandboxColumn)
      .map(({ x, y, colours }) => ({ x, y, colours: [...colours] }))
      .sort((a, b) => a.y - b.y || a.x - b.x);
    expect(decoded).toEqual(worstCaseColumns());
    expect(Object.keys(json.peers ?? {})).toHaveLength(128);
  });
});
