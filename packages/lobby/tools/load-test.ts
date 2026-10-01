/**
 * Reproducible lobby load test. Local only: it forks its own instrumented
 * lobby (`load-test-server.ts`) on a loopback port and never takes an
 * endpoint, so it cannot be pointed at production.
 *
 *   npx tsx packages/lobby/tools/load-test.ts [options]
 *
 *   --bots 10,25,50,100   bot counts, one fresh lobby per count
 *   --seconds 20          measured window per count, after warm-up
 *   --warmup 5            seconds between the last join and the window
 *   --jitter 20           uplink jitter per bot, ms (0 = loopback timing)
 *   --capacity 128        room capacity override (48 is production)
 *   --join-rate 25        joins per second while ramping up
 *   --seed 1              PRNG seed for paths and sandbox actions
 *   --fill-sandbox        drop sky blocks every 50 ms until the sandbox holds
 *                         850, then at the normal slow pace, so the window
 *                         sees a near-full sandbox (use --warmup 50)
 *   --json out.json       also write the full results as JSON
 *   --mixed               D-087: every bot also visits the Avatar Studio and
 *                         the Exchange roof. Street 4-10 s, then the Studio
 *                         (one area switch) or the roof (a suspend, a 1-2 s
 *                         ride through the private floors, then a switch),
 *                         4-10 s there walking its floor, and back. Reports
 *                         area switches, moves the rooms refused, every peer
 *                         an observer saw in an area it should not see (a
 *                         roof bot may see the street), and bytes per second
 *                         a client receives in each area
 *
 * Every bot is the real `LobbyClient` — the browser's own client, with its
 * own send floor, reconcile and sandbox action floor — subscribed to peers,
 * sandbox and ball like the shell. Each walks the street at the game's walk
 * speed (160 px/s, sprinting a fifth of the time), reports its position every
 * 16 ms frame as the World does, pauses at waypoints, and works the sandbox
 * every few seconds while inside it. Uplink jitter delays each bot's outgoing
 * frames by a random 0..jitter ms, in order, which is what a real network does
 * to a 50 ms send cadence.
 *
 * Reported per bot count: server tick (avg/p95/max), message handling, CPU,
 * memory, event-loop delay, outbound bytes per client per second, patch size
 * and rate, full-state bytes, join latency, refusals, disconnects, moves the
 * server dropped as too early, how evenly an observer sees peers move, and the
 * client's own cost of decoding and reading each patch.
 */

import { fork, type ChildProcess } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { PerformanceObserver, performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { Room as SdkRoom } from '@colyseus/sdk';
import {
  PITCH_AREA,
  ROOF_PRESENCE_GRID,
  SANDBOX_AREA,
  STREET_ORIGIN_X,
  STUDIO_PRESENCE_GRID,
  type Facing,
  type PresenceAreaGrid,
  type SandboxTile,
} from '@strkworld/shared';
import { LobbyClient, type PeerSnapshot } from '../src/client.js';
import { DEFAULT_SPRITE_KEYS, type LobbySprite } from '../src/config.js';

// --- Options ---------------------------------------------------------------

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] !== undefined ? (process.argv[index + 1] as string) : fallback;
}

const BOT_COUNTS = option('bots', '10,25,50,100').split(',').map(Number);
const SECONDS = Number(option('seconds', '20'));
const WARMUP = Number(option('warmup', '5'));
const JITTER_MS = Number(option('jitter', '20'));
const CAPACITY = Number(option('capacity', '128'));
const JOIN_RATE = Number(option('join-rate', '25'));
const SEED = Number(option('seed', '1'));
const JSON_OUT = option('json', '');
const FILL_SANDBOX = process.argv.includes('--fill-sandbox');
const MIXED = process.argv.includes('--mixed');

const TILE = 32;
const WALK = 160;
const SPRINT = 1.5;
const FRAME_MS = 16;

// --- Deterministic randomness ---------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// --- SDK instrumentation (bot side) ---------------------------------------

const ROOM_STATE = 14;
const ROOM_STATE_PATCH = 15;

type BotArea = 'street' | 'studio' | 'roof' | 'lift';
const BOT_AREAS: readonly BotArea[] = ['street', 'studio', 'roof', 'lift'];

interface BotNet {
  bytes: number;
  patches: number;
  patchMs: number;
  fullStateBytes: number;
  movesSent: number;
  /** D-087, with `--mixed`: bytes received and time spent in each area. */
  area: BotArea;
  areaSince: number;
  areaBytes: Record<BotArea, number>;
  areaMs: Record<BotArea, number>;
}

function freshNet(): BotNet {
  return {
    bytes: 0,
    patches: 0,
    patchMs: 0,
    fullStateBytes: 0,
    movesSent: 0,
    area: 'street',
    areaSince: performance.now(),
    areaBytes: { street: 0, studio: 0, roof: 0, lift: 0 },
    areaMs: { street: 0, studio: 0, roof: 0, lift: 0 },
  };
}

/** Close the net's current area stretch at `now`, and open one in `area`. */
function enterNetArea(net: BotNet, area: BotArea, now: number): void {
  net.areaMs[net.area] += Math.max(0, now - net.areaSince);
  net.area = area;
  net.areaSince = now;
}

const netByRoom = new WeakMap<object, BotNet>();
let pendingNet: BotNet | null = null;
type AnyFn = (this: unknown, ...args: unknown[]) => unknown;
const sdkProto = SdkRoom.prototype as unknown as Record<string, AnyFn>;

function netFor(room: object): BotNet {
  let net = netByRoom.get(room);
  if (net === undefined) {
    // The bot whose join is in flight owns the first room that speaks.
    net = pendingNet ?? freshNet();
    pendingNet = null;
    netByRoom.set(room, net);
  }
  return net;
}

const originalOnMessage = sdkProto['onMessageCallback'] as AnyFn;
sdkProto['onMessageCallback'] = function counted(this: unknown, ...args: unknown[]) {
  const event = args[0] as { data: ArrayBuffer };
  const net = netFor(this as object);
  const size = event.data.byteLength;
  net.bytes += size;
  net.areaBytes[net.area] += size;
  const code = new Uint8Array(event.data, 0, 1)[0];
  if (code === ROOM_STATE_PATCH) {
    const start = performance.now();
    try {
      return originalOnMessage.apply(this, args);
    } finally {
      net.patchMs += performance.now() - start;
      net.patches += 1;
    }
  }
  if (code === ROOM_STATE) net.fullStateBytes += size;
  return originalOnMessage.apply(this, args);
};

// Uplink jitter: every outgoing frame waits a random 0..JITTER_MS, never
// overtaking the previous one, as on a real connection. One FIFO per room,
// drained by one timer: a timer per frame could fire out of order when two
// frames fall due in the same millisecond, which a TCP stream never does
// (it once delivered a street move after the area switch sent before it).
const jitterRandom = mulberry32(SEED ^ 0x5eed);
interface Uplink {
  readonly queue: Array<{ readonly at: number; readonly args: unknown[] }>;
  timer: ReturnType<typeof setTimeout> | null;
}
const uplinks = new WeakMap<object, Uplink>();
const originalSend = sdkProto['send'] as AnyFn;
function drainUplink(room: object, uplink: Uplink): void {
  uplink.timer = null;
  const now = performance.now();
  while (uplink.queue.length > 0 && uplink.queue[0]!.at <= now) {
    const { args } = uplink.queue.shift()!;
    try {
      originalSend.apply(room, args);
    } catch {
      // The room closed while the frame was in flight; a real network drops it too.
    }
  }
  const next = uplink.queue[0];
  if (next !== undefined) uplink.timer = setTimeout(() => drainUplink(room, uplink), Math.max(0, next.at - now));
}
sdkProto['send'] = function jittered(this: unknown, ...args: unknown[]) {
  const room = this as object;
  if (args[0] === 'move') netFor(room).movesSent += 1;
  if (JITTER_MS <= 0) return originalSend.apply(this, args);
  const now = performance.now();
  let uplink = uplinks.get(room);
  if (uplink === undefined) {
    uplink = { queue: [], timer: null };
    uplinks.set(room, uplink);
  }
  const last = uplink.queue.at(-1)?.at ?? 0;
  uplink.queue.push({ at: Math.max(last, now + jitterRandom() * JITTER_MS), args });
  if (uplink.timer === null) {
    const owned = uplink;
    owned.timer = setTimeout(() => drainUplink(room, owned), Math.max(0, owned.queue[0]!.at - now));
  }
  return undefined;
};

// The SDK's decoder reports a patch it cannot apply — a reference it never
// received — on the console and skips that structure: the client's copy of
// the room has diverged from the server's. Count those instead of printing.
let decodeErrors = 0;
const consoleError = console.error.bind(console);
const consoleWarn = console.warn.bind(console);
console.error = (...args: unknown[]) => {
  if (String(args[0]).includes('"refId" not found')) decodeErrors += 1;
  else consoleError(...args);
};
console.warn = (...args: unknown[]) => {
  if (String(args[0]).includes('Please report this issue')) return;
  consoleWarn(...args);
};

// GC in the bot process: a proxy for client-side allocation churn.
let gcCount = 0;
let gcMs = 0;
new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    gcCount += 1;
    gcMs += entry.duration;
  }
}).observe({ entryTypes: ['gc'] });

// --- The street ------------------------------------------------------------

const STREET_MIN_X = (STREET_ORIGIN_X + 1) * TILE;
const STREET_MAX_X = (SANDBOX_AREA.x - 1) * TILE;
const STREET_MIN_Y = 10 * TILE;
const STREET_MAX_Y = 18 * TILE;
const SANDBOX_MIN_X = (SANDBOX_AREA.x + 1) * TILE;
const SANDBOX_MAX_X = (SANDBOX_AREA.x + SANDBOX_AREA.width - 1) * TILE;
const SANDBOX_MIN_Y = (SANDBOX_AREA.y + 1) * TILE;
const SANDBOX_MAX_Y = (SANDBOX_AREA.y + SANDBOX_AREA.height - 1) * TILE;
const PITCH_MIN_X = (PITCH_AREA.x + 1) * TILE;
const PITCH_MAX_X = (PITCH_AREA.x + PITCH_AREA.width - 1) * TILE;

// --- The shared rooms (D-087) ----------------------------------------------

/** A walkable rectangle of a shared room, in World pixels, kept a body clear of its edges. */
function floorOf(grid: PresenceAreaGrid): { minX: number; maxX: number; minY: number; maxY: number } {
  const rect = grid.walkable[0]!;
  const inset = 10;
  return {
    minX: grid.originX + rect.x * grid.tileSize + inset,
    maxX: grid.originX + (rect.x + rect.width) * grid.tileSize - inset,
    minY: grid.originY + rect.y * grid.tileSize + inset,
    maxY: grid.originY + (rect.y + rect.height) * grid.tileSize - inset,
  };
}
const FLOORS = { studio: floorOf(STUDIO_PRESENCE_GRID), roof: floorOf(ROOF_PRESENCE_GRID) } as const;

/**
 * Where every bot really is, by game id, and since when: the truth an
 * observer's peers are checked against. A peer that switched less than
 * `SIGHTING_GRACE_MS` ago may still be in flight to the room or in the patch
 * after it; anything older seen in the wrong area is a leak.
 */
const truth = new Map<string, { area: BotArea; at: number }>();
const SIGHTING_GRACE_MS = 300;
const mixedStats = { switches: 0, checked: 0, crossArea: 0, ownSwitchLeaks: 0, roofSawStreet: 0 };

function inSandbox(x: number, y: number): boolean {
  return x >= SANDBOX_MIN_X && x < SANDBOX_MAX_X && y >= SANDBOX_MIN_Y && y < SANDBOX_MAX_Y;
}

interface Observation {
  /** Gaps between successive position changes of one peer, in ms. */
  gaps: number[];
  last: Map<string, { x: number; y: number; at: number }>;
}

class Bot {
  readonly client: LobbyClient;
  readonly net: BotNet = freshNet();
  readonly random: () => number;
  x: number;
  y: number;
  facing: Facing = 'down';
  target = { x: 0, y: 0 };
  pauseUntil = 0;
  sprinting = false;
  nextSandboxAt = 0;
  joinMs = Number.NaN;
  disconnected = false;
  refused = false;
  sandboxActions = 0;
  observation: Observation | null = null;
  /** D-087, with `--mixed`: where this bot is, until when, and where its lift goes. */
  area: BotArea = 'street';
  areaUntil = Number.POSITIVE_INFINITY;
  switchedAt = 0;
  liftTo: 'roof' | 'street' = 'roof';
  street = { x: 0, y: 0 };
  readonly sprite: LobbySprite;

  constructor(endpoint: string, index: number, observe: boolean) {
    this.random = mulberry32(SEED * 7919 + index);
    this.x = STREET_MIN_X + this.random() * (STREET_MAX_X - STREET_MIN_X);
    this.y = STREET_MIN_Y + this.random() * (STREET_MAX_Y - STREET_MIN_Y);
    this.sprite = DEFAULT_SPRITE_KEYS[index % DEFAULT_SPRITE_KEYS.length] as LobbySprite;
    this.client = new LobbyClient({
      endpoint,
      start: { x: this.x, y: this.y, facing: 'down' },
      sprite: this.sprite,
    });
    // Subscribed like the shell: every patch builds what these listeners get.
    this.client.onPeers((peers) => this.#observe(peers));
    this.client.onSandbox(() => undefined);
    this.client.onFootball(() => undefined);
    this.client.onStatus((event) => {
      if (event.status === 'closed' && event.reason !== 'client-left') this.disconnected = true;
    });
    if (observe) this.observation = { gaps: [], last: new Map() };
    this.#pickTarget(0);
  }

  async join(): Promise<void> {
    const start = performance.now();
    pendingNet = this.net;
    try {
      await this.client.connect();
      this.joinMs = performance.now() - start;
      if (MIXED) {
        const now = performance.now();
        this.areaUntil = now + 4000 + this.random() * 6000;
        this.#record(now);
      }
    } catch {
      this.refused = true;
    } finally {
      if (pendingNet === this.net) pendingNet = null;
    }
  }

  #pickTarget(now: number): void {
    const roll = this.random();
    if (roll < 0.55) {
      this.target = {
        x: SANDBOX_MIN_X + this.random() * (SANDBOX_MAX_X - SANDBOX_MIN_X),
        y: SANDBOX_MIN_Y + this.random() * (SANDBOX_MAX_Y - SANDBOX_MIN_Y),
      };
    } else if (roll < 0.7) {
      this.target = {
        x: PITCH_MIN_X + this.random() * (PITCH_MAX_X - PITCH_MIN_X),
        y: SANDBOX_MIN_Y + this.random() * (SANDBOX_MAX_Y - SANDBOX_MIN_Y),
      };
    } else {
      this.target = {
        x: STREET_MIN_X + this.random() * (STREET_MAX_X - STREET_MIN_X),
        y: STREET_MIN_Y + this.random() * (STREET_MAX_Y - STREET_MIN_Y),
      };
    }
    this.sprinting = this.random() < 0.2;
    this.pauseUntil = now;
  }

  #record(now: number): void {
    this.switchedAt = now;
    enterNetArea(this.net, this.area, now);
    if (this.client.gameId !== null) truth.set(this.client.gameId, { area: this.area, at: now });
  }

  /** D-087: move on to the next area when this one's time is up. */
  #switchArea(now: number): void {
    const dwell = () => now + 4000 + this.random() * 6000;
    const enter = (area: 'studio' | 'roof', at: { x: number; y: number }) => {
      this.client.enterArea(area, { ...at, facing: 'down' }, this.sprite);
      this.area = area;
      this.x = at.x;
      this.y = at.y;
      this.#pickFloorTarget(now);
      this.areaUntil = dwell();
    };
    if (this.area === 'street') {
      this.street = { x: this.x, y: this.y };
      if (this.random() < 0.5) {
        enter('studio', { x: (FLOORS.studio.minX + FLOORS.studio.maxX) / 2, y: FLOORS.studio.minY });
      } else {
        // Into the Exchange: private floors first, the lift to the roof after.
        this.client.suspend();
        this.area = 'lift';
        this.liftTo = 'roof';
        this.areaUntil = now + 1000 + this.random() * 1000;
      }
    } else if (this.area === 'lift') {
      if (this.liftTo === 'roof') {
        enter('roof', { x: FLOORS.roof.maxX, y: (FLOORS.roof.minY + FLOORS.roof.maxY) / 2 });
      } else {
        this.client.resume({ ...this.street, facing: 'down' }, this.sprite);
        this.area = 'street';
        this.x = this.street.x;
        this.y = this.street.y;
        this.#pickTarget(now);
        this.areaUntil = dwell();
      }
    } else if (this.area === 'studio') {
      this.client.enterArea('street', { ...this.street, facing: 'up' }, this.sprite);
      this.area = 'street';
      this.x = this.street.x;
      this.y = this.street.y;
      this.#pickTarget(now);
      this.areaUntil = dwell();
    } else {
      // Down the lift, through the private floors, out of the door.
      this.client.suspend();
      this.area = 'lift';
      this.liftTo = 'street';
      this.areaUntil = now + 1000 + this.random() * 1000;
    }
    mixedStats.switches += 1;
    this.#record(now);
  }

  #pickFloorTarget(now: number): void {
    const floor = FLOORS[this.area as 'studio' | 'roof'];
    this.target = {
      x: floor.minX + this.random() * (floor.maxX - floor.minX),
      y: floor.minY + this.random() * (floor.maxY - floor.minY),
    };
    this.sprinting = this.random() < 0.2;
    this.pauseUntil = now;
  }

  step(now: number, dtMs: number): void {
    if (MIXED && now >= this.areaUntil && (this.client.status === 'connected' || this.client.status === 'suspended')) {
      this.#switchArea(now);
    }
    if (this.client.status !== 'connected') return;
    if (now >= this.pauseUntil) {
      const dx = this.target.x - this.x;
      const dy = this.target.y - this.y;
      const distance = Math.hypot(dx, dy);
      const stride = (WALK * (this.sprinting ? SPRINT : 1) * dtMs) / 1000;
      if (distance <= stride) {
        this.x = this.target.x;
        this.y = this.target.y;
        if (this.area === 'street') this.#pickTarget(now + 500 + this.random() * 2500);
        else this.#pickFloorTarget(now + 500 + this.random() * 2500);
        this.pauseUntil = now + 500 + this.random() * 2500;
      } else {
        this.x += (dx / distance) * stride;
        this.y += (dy / distance) * stride;
        this.facing = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up';
      }
    }
    // The World reports every frame; the client decides when to send.
    this.client.updatePosition(this.x, this.y, this.facing);
    if (now >= this.nextSandboxAt) {
      this.nextSandboxAt = now + 3000 + this.random() * 3000;
      if (this.area === 'street' && inSandbox(this.x, this.y)) this.#workSandbox();
    }
  }

  #workSandbox(): void {
    const tx = Math.floor(this.x / TILE);
    const ty = Math.floor(this.y / TILE);
    const snapshot = this.client.sandbox();
    const neighbours: SandboxTile[] = [];
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx !== 0 || dy !== 0) neighbours.push({ x: tx + dx, y: ty + dy });
      }
    }
    if (snapshot.carrying === null) {
      const stacked = neighbours.filter((tile) =>
        snapshot.columns.some((column) => column.x === tile.x && column.y === tile.y),
      );
      if (stacked.length === 0) return;
      this.client.pickBlock(stacked[Math.floor(this.random() * stacked.length)] as SandboxTile);
    } else {
      this.client.placeBlock(neighbours[Math.floor(this.random() * neighbours.length)] as SandboxTile);
    }
    this.sandboxActions += 1;
  }

  /**
   * D-087: is every peer this bot is shown really in the bot's own area, or,
   * for a bot on the roof, on the street below (the one-way view)? A bot
   * between areas (on the lift) must be shown nobody. A peer that
   * switched within the grace may still be in flight; one this bot itself
   * just left behind may not: `LobbyClient` withholds peers until the room
   * shows its switch, so those count with no grace.
   */
  #checkAreas(peers: readonly PeerSnapshot[]): void {
    const now = performance.now();
    for (const peer of peers) {
      mixedStats.checked += 1;
      const seen = truth.get(peer.gameId);
      if (seen === undefined || seen.area === this.area) continue;
      if (this.area === 'roof' && seen.area === 'street') {
        mixedStats.roofSawStreet += 1;
        continue;
      }
      if (now - seen.at < SIGHTING_GRACE_MS) continue;
      if (this.switchedAt > seen.at) mixedStats.ownSwitchLeaks += 1;
      else mixedStats.crossArea += 1;
    }
  }

  #observe(peers: readonly PeerSnapshot[]): void {
    if (MIXED) this.#checkAreas(peers);
    const observation = this.observation;
    if (observation === null) return;
    const now = performance.now();
    for (const peer of peers) {
      const last = observation.last.get(peer.gameId);
      if (last === undefined) {
        observation.last.set(peer.gameId, { x: peer.x, y: peer.y, at: now });
        continue;
      }
      if (last.x === peer.x && last.y === peer.y) continue;
      const gap = now - last.at;
      // Longer than this is a pause at a waypoint, not a stall.
      if (gap < 400) observation.gaps.push(gap);
      last.x = peer.x;
      last.y = peer.y;
      last.at = now;
    }
  }
}

// --- Driver ----------------------------------------------------------------

function stats(values: number[]): { avg: number; p50: number; p95: number; max: number; n: number } {
  if (values.length === 0) return { avg: 0, p50: 0, p95: 0, max: 0, n: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number;
  return {
    avg: sorted.reduce((total, value) => total + value, 0) / sorted.length,
    p50: pick(0.5),
    p95: pick(0.95),
    max: sorted[sorted.length - 1] as number,
    n: sorted.length,
  };
}

function startLobby(): Promise<{ child: ChildProcess; port: number }> {
  const serverPath = fileURLToPath(new URL('./load-test-server.ts', import.meta.url));
  const child = fork(serverPath, [], {
    execArgv: ['--import', 'tsx'],
    env: {
      ...process.env,
      LOAD_TEST_ROOM: JSON.stringify({
        capacity: CAPACITY,
        ...(FILL_SANDBOX
          ? { sandboxSpawnIntervalMs: 50, sandboxFastSpawnLimit: 850 }
          : {}),
      }),
    },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.on('message', (message: { type?: string; port?: number }) => {
      if (message.type === 'ready') resolve({ child, port: message.port as number });
    });
  });
}

function ask(child: ChildProcess, type: string, reply: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const listener = (message: { type?: string; report?: Record<string, unknown> }) => {
      if (message.type !== reply) return;
      child.off('message', listener);
      resolve(message.report ?? {});
    };
    child.on('message', listener);
    child.send({ type });
  });
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function run(botCount: number): Promise<Record<string, unknown>> {
  const { child, port } = await startLobby();
  const endpoint = `ws://127.0.0.1:${port}`;
  const bots: Bot[] = [];
  let lastFrame = performance.now();
  const frame = setInterval(() => {
    const now = performance.now();
    const dt = now - lastFrame;
    lastFrame = now;
    for (const bot of bots) bot.step(now, dt);
  }, FRAME_MS);

  // Ramp: joins arrive at JOIN_RATE per second, as when a crowd turns up.
  for (let index = 0; index < botCount; index += 1) {
    const bot = new Bot(endpoint, index, index === 0);
    bots.push(bot);
    // One join in flight at a time keeps the bot-to-room accounting exact.
    await bot.join();
    await wait(1000 / JOIN_RATE);
  }
  await wait(WARMUP * 1000);

  for (const bot of bots) {
    bot.net.bytes = 0;
    bot.net.patches = 0;
    bot.net.patchMs = 0;
    bot.net.movesSent = 0;
    if (bot.observation) bot.observation.gaps = [];
  }
  const gcStart = { count: gcCount, ms: gcMs };
  const decodeErrorsStart = decodeErrors;
  await ask(child, 'reset', 'reset-done');
  const throttledBefore = Number((await ask(child, 'report', 'report'))['throttledTotal'] ?? 0);
  const rejectedBefore = Number((await ask(child, 'report', 'report'))['rejectedTotal'] ?? 0);
  mixedStats.switches = 0;
  mixedStats.checked = 0;
  mixedStats.crossArea = 0;
  mixedStats.ownSwitchLeaks = 0;
  mixedStats.roofSawStreet = 0;
  const areaWindowStart = performance.now();
  for (const bot of bots) {
    const net = bot.net;
    for (const area of BOT_AREAS) {
      net.areaBytes[area] = 0;
      net.areaMs[area] = 0;
    }
    net.areaSince = areaWindowStart;
  }
  // D-087: how the bots are spread over the areas, sampled through the window.
  const spread = { street: 0, studio: 0, roof: 0, lift: 0, samples: 0 };
  const sampler = setInterval(() => {
    for (const bot of bots) if (!bot.refused) spread[bot.area] += 1;
    spread.samples += 1;
  }, 500);
  const windowStart = performance.now();
  await wait(SECONDS * 1000);
  clearInterval(sampler);
  const areaWindowEnd = performance.now();
  for (const bot of bots) enterNetArea(bot.net, bot.net.area, areaWindowEnd);
  // Bytes a client receives per second while in each area, over every bot.
  const perClientByArea = Object.fromEntries(
    BOT_AREAS.map((area) => {
      const bytes = bots.reduce((total, bot) => total + bot.net.areaBytes[area], 0);
      const ms = bots.reduce((total, bot) => total + bot.net.areaMs[area], 0);
      return [area, ms > 0 ? bytes / (ms / 1000) : 0];
    }),
  ) as Record<BotArea, number>;
  const server = await ask(child, 'report', 'report');
  const seconds = (performance.now() - windowStart) / 1000;

  clearInterval(frame);
  const joined = bots.filter((bot) => !bot.refused);
  const movesSent = joined.reduce((total, bot) => total + bot.net.movesSent, 0);
  const throttled = Number(server['throttledTotal'] ?? 0) - throttledBefore;
  const patches = joined.reduce((total, bot) => total + bot.net.patches, 0);
  const patchMs = joined.reduce((total, bot) => total + bot.net.patchMs, 0);
  const inboundPerClient = joined.map((bot) => bot.net.bytes / seconds);
  const gaps = bots[0]?.observation?.gaps ?? [];
  const result = {
    bots: botCount,
    joined: joined.length,
    refused: bots.length - joined.length,
    disconnected: bots.filter((bot) => bot.disconnected).length,
    joinMs: stats(joined.map((bot) => bot.joinMs)),
    server,
    clientInboundBytesPerSec: stats(inboundPerClient),
    clientPatchesPerSec: patches / joined.length / seconds,
    clientPatchMs: patches === 0 ? 0 : patchMs / patches,
    movesSentPerBotPerSec: movesSent / joined.length / seconds,
    moveDropPct: movesSent === 0 ? 0 : (throttled / movesSent) * 100,
    observerGapMs: stats(gaps),
    observerStallPct: gaps.length === 0 ? 0 : (gaps.filter((gap) => gap >= 90).length / gaps.length) * 100,
    sandboxActions: joined.reduce((total, bot) => total + bot.sandboxActions, 0),
    sandboxBlocks: bots[0]?.client.sandbox().columns.reduce((total, column) => total + column.colours.length, 0) ?? 0,
    decodeErrors: decodeErrors - decodeErrorsStart,
    botGcMsPerSec: (gcMs - gcStart.ms) / seconds,
    botGcPerSec: (gcCount - gcStart.count) / seconds,
    ...(MIXED
      ? {
          mixed: {
            switchesPerSec: mixedStats.switches / seconds,
            serverAreaSwitches: Number(server['areaSwitchesTotal'] ?? 0),
            rejectedMoves: Number(server['rejectedTotal'] ?? 0) - rejectedBefore,
            peerSightingsChecked: mixedStats.checked,
            crossAreaSightings: mixedStats.crossArea,
            ownSwitchLeaks: mixedStats.ownSwitchLeaks,
            roofSawStreet: mixedStats.roofSawStreet,
            clientBytesPerSecByArea: perClientByArea,
            meanBots: {
              street: spread.street / Math.max(1, spread.samples),
              studio: spread.studio / Math.max(1, spread.samples),
              roof: spread.roof / Math.max(1, spread.samples),
              lift: spread.lift / Math.max(1, spread.samples),
            },
          },
        }
      : {}),
  };

  await Promise.all(bots.map((bot) => bot.client.disconnect().catch(() => undefined)));
  child.send({ type: 'stop' });
  await new Promise((resolve) => child.once('exit', resolve));
  return result;
}

function row(result: Record<string, any>): string {
  const s = result['server'];
  const f = (value: number, digits = 2) => value.toFixed(digits);
  return [
    `${result['bots']} bots (${result['joined']} joined, ${s.rooms} room(s), ${result['refused']} refused, ${result['disconnected']} dropped)`,
    `  tick ms        avg ${f(s.tickMs.avg, 3)}  p95 ${f(s.tickMs.p95, 3)}  max ${f(s.tickMs.max, 2)}   (${f(s.tickMs.n / s.seconds, 1)}/s)`,
    `  message ms     avg ${f(s.messageMs.avg, 4)}  p95 ${f(s.messageMs.p95, 4)}  max ${f(s.messageMs.max, 2)}   (${f(s.messageMs.n / s.seconds, 0)}/s)`,
    `  room busy      ${f(s.roomBusyPct, 1)}% of a core   process CPU ${f(s.cpuPct, 1)}%   loop delay p99 ${f(s.loopDelayMs.p99, 1)} ms max ${f(s.loopDelayMs.max, 1)} ms`,
    `  memory         rss ${f(s.rssMb, 0)} MB (peak ${f(s.peakRssMb, 0)})   heap ${f(s.heapMb, 0)} MB (peak ${f(s.peakHeapMb, 0)})`,
    `  outbound       ${f(s.outboundBytesPerSec / 1024, 1)} KB/s total   ${f(result['clientInboundBytesPerSec'].avg / 1024, 2)} KB/s per client (p95 ${f(result['clientInboundBytesPerSec'].p95 / 1024, 2)})`,
    `  patches        ${f(s.patchFramesPerSec / Math.max(1, s.clients), 1)}/s per client   size avg ${f(s.patchSize.avg, 0)} B p95 ${f(s.patchSize.p95, 0)} B max ${s.patchSize.max} B`,
    `  join           avg ${f(result['joinMs'].avg, 1)} ms  p95 ${f(result['joinMs'].p95, 1)} ms  max ${f(result['joinMs'].max, 1)} ms`,
    `  moves          ${f(result['movesSentPerBotPerSec'], 1)}/s per bot sent, ${f(result['moveDropPct'], 1)}% dropped by the server floor`,
    `  observer       peer update gap p50 ${f(result['observerGapMs'].p50, 0)} ms p95 ${f(result['observerGapMs'].p95, 0)} ms, ${f(result['observerStallPct'], 1)}% stalls (>=90 ms)`,
    `  client         ${f(result['clientPatchMs'], 3)} ms per patch decoded+read   bot-process GC ${f(result['botGcMsPerSec'], 1)} ms/s`,
    `  decode errors  ${result['decodeErrors']} patch structures the clients could not apply (state diverged)`,
    `  sandbox        ${result['sandboxBlocks']} blocks at the end, ${result['sandboxActions']} bot actions`,
    ...(result['mixed']
      ? [
          `  areas          mean bots street ${f(result['mixed'].meanBots.street, 1)} studio ${f(result['mixed'].meanBots.studio, 1)} roof ${f(result['mixed'].meanBots.roof, 1)} lift ${f(result['mixed'].meanBots.lift, 1)}   ${f(result['mixed'].switchesPerSec, 1)} switches/s`,
          `  isolation      ${result['mixed'].crossAreaSightings} cross-area sightings, ${result['mixed'].ownSwitchLeaks} after an own switch, of ${result['mixed'].peerSightingsChecked} checked   ${result['mixed'].rejectedMoves} moves refused by a room's tiles`,
          `  one-way        ${result['mixed'].roofSawStreet} street sightings from the roof (allowed)`,
          `  per client     KB/s while on the street ${f(result['mixed'].clientBytesPerSecByArea.street / 1024, 2)}  roof ${f(result['mixed'].clientBytesPerSecByArea.roof / 1024, 2)}  studio ${f(result['mixed'].clientBytesPerSecByArea.studio / 1024, 2)}  lift ${f(result['mixed'].clientBytesPerSecByArea.lift / 1024, 2)}`,
        ]
      : []),
  ].join('\n');
}

const results: Record<string, unknown>[] = [];
process.stdout.write(
  `lobby load test: bots ${BOT_COUNTS.join(',')}, ${SECONDS}s window, ${WARMUP}s warm-up, ` +
    `${JITTER_MS} ms uplink jitter, capacity ${CAPACITY}, seed ${SEED}${FILL_SANDBOX ? ', sandbox filling' : ''}` +
    `${MIXED ? ', mixed areas (D-087)' : ''}\n\n`,
);
for (const count of BOT_COUNTS) {
  const result = await run(count);
  results.push(result);
  process.stdout.write(`${row(result)}\n\n`);
}
if (JSON_OUT) writeFileSync(JSON_OUT, `${JSON.stringify(results, null, 2)}\n`);
process.exit(0);
