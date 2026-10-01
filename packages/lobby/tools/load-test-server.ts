/**
 * The instrumented lobby half of the load test. Forked by `load-test.ts`;
 * never run in production and never pointed at production.
 *
 * It starts the real presence server (`startPresenceServer`) on an ephemeral
 * loopback port and wraps three Colyseus internals, measuring them without
 * changing what they do:
 *
 *   - `Room#broadcastPatch` — one room tick: the room's `onBeforePatch`, the
 *     room clock (football steps, sky drops) and the patch encode and send.
 *   - `Room#_onMessage` — every inbound message, handler included (a move's
 *     interest recompute runs here).
 *   - `WebSocketClient#raw` — every outbound frame, by protocol code, so the
 *     driver can report patch bytes, patch rate and full-state bytes.
 *
 * Plus process CPU, memory, event-loop delay and the room's own aggregate
 * counters. Everything it reports is an aggregate: no session id, no
 * coordinate.
 *
 * IPC protocol (parent → child): `{ type: 'reset' }` starts a measurement
 * window, `{ type: 'report' }` returns it, `{ type: 'stop' }` exits. The child
 * announces `{ type: 'ready', port }` once listening.
 */

import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { Room } from '@colyseus/core';
import { WebSocketClient } from '@colyseus/ws-transport';
import { PresenceRoom } from '../src/room.js';
import { startPresenceServer } from '../src/server.js';
import type { PresenceRoomConfigOverrides } from '../src/config.js';

const ROOM_STATE = 14;
const ROOM_STATE_PATCH = 15;

interface Window {
  startedAt: number;
  cpu: NodeJS.CpuUsage;
  tickMs: number[];
  messageMs: number[];
  patchFrames: number;
  patchBytes: number;
  patchSizes: number[];
  fullStateFrames: number;
  fullStateBytes: number;
  otherFrames: number;
  otherBytes: number;
  peakRss: number;
  peakHeap: number;
}

function freshWindow(): Window {
  return {
    startedAt: performance.now(),
    cpu: process.cpuUsage(),
    tickMs: [],
    messageMs: [],
    patchFrames: 0,
    patchBytes: 0,
    patchSizes: [],
    fullStateFrames: 0,
    fullStateBytes: 0,
    otherFrames: 0,
    otherBytes: 0,
    peakRss: 0,
    peakHeap: 0,
  };
}

let window = freshWindow();
const loopDelay = monitorEventLoopDelay({ resolution: 5 });
loopDelay.enable();

// --- Instrumentation -------------------------------------------------------

type AnyFn = (this: unknown, ...args: unknown[]) => unknown;
const roomProto = Room.prototype as unknown as Record<string, AnyFn>;

const originalPatch = roomProto['broadcastPatch'] as AnyFn;
roomProto['broadcastPatch'] = function timedPatch(this: unknown, ...args: unknown[]) {
  const start = performance.now();
  try {
    return originalPatch.apply(this, args);
  } finally {
    window.tickMs.push(performance.now() - start);
  }
};

const originalOnMessage = roomProto['_onMessage'] as AnyFn;
roomProto['_onMessage'] = function timedMessage(this: unknown, ...args: unknown[]) {
  const start = performance.now();
  try {
    return originalOnMessage.apply(this, args);
  } finally {
    window.messageMs.push(performance.now() - start);
  }
};

const clientProto = WebSocketClient.prototype as unknown as Record<string, AnyFn>;
const originalRaw = clientProto['raw'] as AnyFn;
clientProto['raw'] = function countedRaw(this: unknown, ...args: unknown[]) {
  const data = args[0] as Uint8Array | undefined;
  if (data !== undefined) {
    const size = data.byteLength;
    if (data[0] === ROOM_STATE_PATCH) {
      window.patchFrames += 1;
      window.patchBytes += size;
      if (window.patchSizes.length < 200_000) window.patchSizes.push(size);
    } else if (data[0] === ROOM_STATE) {
      window.fullStateFrames += 1;
      window.fullStateBytes += size;
    } else {
      window.otherFrames += 1;
      window.otherBytes += size;
    }
  }
  return originalRaw.apply(this, args);
};

const rooms = new Set<PresenceRoom>();
const presenceProto = PresenceRoom.prototype as unknown as Record<string, AnyFn>;
const originalCreate = presenceProto['onCreate'] as AnyFn;
presenceProto['onCreate'] = function trackedCreate(this: unknown, ...args: unknown[]) {
  rooms.add(this as PresenceRoom);
  return originalCreate.apply(this, args);
};
const originalDispose = presenceProto['onDispose'] as AnyFn;
presenceProto['onDispose'] = function trackedDispose(this: unknown, ...args: unknown[]) {
  rooms.delete(this as PresenceRoom);
  return originalDispose.apply(this, args);
};

const memoryTimer = setInterval(() => {
  const memory = process.memoryUsage();
  window.peakRss = Math.max(window.peakRss, memory.rss);
  window.peakHeap = Math.max(window.peakHeap, memory.heapUsed);
}, 250);
memoryTimer.unref();

// --- Reporting -------------------------------------------------------------

function stats(values: number[]): { avg: number; p95: number; p99: number; max: number; n: number } {
  if (values.length === 0) return { avg: 0, p95: 0, p99: 0, max: 0, n: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  const pick = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number;
  const sum = sorted.reduce((total, value) => total + value, 0);
  return { avg: sum / sorted.length, p95: pick(0.95), p99: pick(0.99), max: sorted[sorted.length - 1] as number, n: sorted.length };
}

function report(): Record<string, unknown> {
  const seconds = (performance.now() - window.startedAt) / 1000;
  const cpu = process.cpuUsage(window.cpu);
  const memory = process.memoryUsage();
  let clients = 0;
  let throttled = 0;
  let refused = 0;
  let present = 0;
  let rejected = 0;
  let areaSwitches = 0;
  let suspended = 0;
  for (const room of rooms) {
    clients += room.clients.length;
    const counters = room.counters;
    throttled += counters.throttled;
    refused += counters.refused;
    present += counters.present;
    rejected += counters.rejected;
    areaSwitches += counters.areaSwitches;
    suspended += counters.suspended;
  }
  const tick = stats(window.tickMs);
  const message = stats(window.messageMs);
  return {
    seconds,
    rooms: rooms.size,
    clients,
    present,
    throttledTotal: throttled,
    refusedTotal: refused,
    // D-087: moves refused by a shared area's tiles, and accepted area switches.
    rejectedTotal: rejected,
    areaSwitchesTotal: areaSwitches,
    suspended,
    tickMs: tick,
    messageMs: message,
    // Wall time the event loop spent inside room code, as a share of one core.
    roomBusyPct: ((tick.avg * tick.n + message.avg * message.n) / 1000 / seconds) * 100,
    cpuPct: ((cpu.user + cpu.system) / 1e6 / seconds) * 100,
    rssMb: memory.rss / 1048576,
    heapMb: memory.heapUsed / 1048576,
    peakRssMb: Math.max(window.peakRss, memory.rss) / 1048576,
    peakHeapMb: Math.max(window.peakHeap, memory.heapUsed) / 1048576,
    loopDelayMs: {
      p50: loopDelay.percentile(50) / 1e6,
      p99: loopDelay.percentile(99) / 1e6,
      max: loopDelay.max / 1e6,
    },
    patchFramesPerSec: window.patchFrames / seconds,
    patchBytesPerSec: window.patchBytes / seconds,
    patchSize: stats(window.patchSizes),
    fullStateFrames: window.fullStateFrames,
    fullStateBytes: window.fullStateBytes,
    otherBytesPerSec: window.otherBytes / seconds,
    outboundBytesPerSec: (window.patchBytes + window.fullStateBytes + window.otherBytes) / seconds,
  };
}

// --- Lifecycle -------------------------------------------------------------

const roomOverrides = JSON.parse(process.env['LOAD_TEST_ROOM'] ?? '{}') as PresenceRoomConfigOverrides;

const server = await startPresenceServer({
  port: 0,
  hostname: '127.0.0.1',
  room: roomOverrides,
});

process.on('message', (raw: unknown) => {
  const message = raw as { type?: string };
  if (message.type === 'reset') {
    window = freshWindow();
    loopDelay.reset();
    process.send?.({ type: 'reset-done' });
  } else if (message.type === 'report') {
    process.send?.({ type: 'report', report: report() });
  } else if (message.type === 'stop') {
    void server.shutdown().finally(() => process.exit(0));
  }
});

process.send?.({ type: 'ready', port: server.port });
