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
  SANDBOX_AREA,
  STREET_ORIGIN_X,
  type Facing,
  type SandboxTile,
} from '@strkworld/shared';
import { LobbyClient, type PeerSnapshot } from '../src/client.js';
import { DEFAULT_SPRITE_KEYS } from '../src/config.js';

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

interface BotNet {
  bytes: number;
  patches: number;
  patchMs: number;
  fullStateBytes: number;
  movesSent: number;
}

const netByRoom = new WeakMap<object, BotNet>();
let pendingNet: BotNet | null = null;
type AnyFn = (this: unknown, ...args: unknown[]) => unknown;
const sdkProto = SdkRoom.prototype as unknown as Record<string, AnyFn>;

function netFor(room: object): BotNet {
  let net = netByRoom.get(room);
  if (net === undefined) {
    // The bot whose join is in flight owns the first room that speaks.
    net = pendingNet ?? { bytes: 0, patches: 0, patchMs: 0, fullStateBytes: 0, movesSent: 0 };
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
// overtaking the previous one, as on a real connection.
const jitterRandom = mulberry32(SEED ^ 0x5eed);
const lastDelivery = new WeakMap<object, number>();
const originalSend = sdkProto['send'] as AnyFn;
sdkProto['send'] = function jittered(this: unknown, ...args: unknown[]) {
  const room = this as object;
  if (args[0] === 'move') netFor(room).movesSent += 1;
  if (JITTER_MS <= 0) return originalSend.apply(this, args);
  const now = performance.now();
  const at = Math.max(lastDelivery.get(room) ?? 0, now + jitterRandom() * JITTER_MS);
  lastDelivery.set(room, at);
  setTimeout(() => {
    try {
      originalSend.apply(room, args);
    } catch {
      // The room closed while the frame was in flight; a real network drops it too.
    }
  }, at - now);
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
  readonly net: BotNet = { bytes: 0, patches: 0, patchMs: 0, fullStateBytes: 0, movesSent: 0 };
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

  constructor(endpoint: string, index: number, observe: boolean) {
    this.random = mulberry32(SEED * 7919 + index);
    this.x = STREET_MIN_X + this.random() * (STREET_MAX_X - STREET_MIN_X);
    this.y = STREET_MIN_Y + this.random() * (STREET_MAX_Y - STREET_MIN_Y);
    this.client = new LobbyClient({
      endpoint,
      start: { x: this.x, y: this.y, facing: 'down' },
      sprite: DEFAULT_SPRITE_KEYS[index % DEFAULT_SPRITE_KEYS.length] as string,
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

  step(now: number, dtMs: number): void {
    if (this.client.status !== 'connected') return;
    if (now >= this.pauseUntil) {
      const dx = this.target.x - this.x;
      const dy = this.target.y - this.y;
      const distance = Math.hypot(dx, dy);
      const stride = (WALK * (this.sprinting ? SPRINT : 1) * dtMs) / 1000;
      if (distance <= stride) {
        this.x = this.target.x;
        this.y = this.target.y;
        this.#pickTarget(now + 500 + this.random() * 2500);
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
      if (inSandbox(this.x, this.y)) this.#workSandbox();
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

  #observe(peers: readonly PeerSnapshot[]): void {
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
  const windowStart = performance.now();
  await wait(SECONDS * 1000);
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
  ].join('\n');
}

const results: Record<string, unknown>[] = [];
process.stdout.write(
  `lobby load test: bots ${BOT_COUNTS.join(',')}, ${SECONDS}s window, ${WARMUP}s warm-up, ` +
    `${JITTER_MS} ms uplink jitter, capacity ${CAPACITY}, seed ${SEED}${FILL_SANDBOX ? ', sandbox filling' : ''}\n\n`,
);
for (const count of BOT_COUNTS) {
  const result = await run(count);
  results.push(result);
  process.stdout.write(`${row(result)}\n\n`);
}
if (JSON_OUT) writeFileSync(JSON_OUT, `${JSON.stringify(results, null, 2)}\n`);
process.exit(0);
