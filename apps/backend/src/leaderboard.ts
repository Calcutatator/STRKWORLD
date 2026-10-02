import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { poseidonHashMany } from '@scure/starknet';
import { PerClientRateLimiter } from './client-key.js';
import { AggregateRateLimiter, type RequestRateLimiterPort } from './metrics.js';
import type { ApiRequest, ApiResponse } from './types.js';
import { ApiFailure, isFelt, requireNonzeroFelt, requireRecord, requireVersion } from './validation.js';

/**
 * The private placement's blind tally (leaderboard phase 1), behind
 * `BACKEND_LEADERBOARD_ENABLED`.
 *
 * A player who asks for their placement sends the season partial commitment
 * `p` their wallet derives for `strkworld-lb-s1`: no address, no signature.
 * This service recounts that player's receipts on-chain (the canonical
 * anonymizer's shadow accounts for `p`, and the ledger's `count_of` for each),
 * keeps only `(h(p, 'id'), count, updatedAt)` for the season, and drops `p`.
 * Anyone can read the season's histogram: counts only.
 *
 * What it never does: log, persist or return `p`; log or keep a client's
 * address (rate limits key a salted, in-memory HMAC, `client-key.ts`); store
 * anything for a player with no receipts (so random felts cannot pad the
 * ranking); or hold a timestamp finer than a day.
 *
 * The trust assumption, stated plainly: while it handles a request this
 * service sees `p`, so it could link that season's receipts to each other, and
 * a shield receipt names the account that shielded. Phase 2 replaces this
 * tally with zero-knowledge claims to an on-chain registry.
 */

export const LEADERBOARD_SEASON = 's1';
/** The receipts' dapp name: pinned in the privacy package too, and the two are tested equal. */
export const LEADERBOARD_DAPP_NAME = 'strkworld-lb-s1';
export const LEADERBOARD_SHADOW_PAGE = 128;
export const MAX_LEADERBOARD_RECEIPTS = 1_024;
/** The most entries one season holds: a ceiling on memory and on the file, not a policy. */
export const MAX_LEADERBOARD_ENTRIES = 200_000;

export const LB_SHADOWS_PATH = '/v1/rpc/lb-shadows';
export const LB_COUNTS_PATH = '/v1/rpc/lb-counts';
export const LB_CHECK_IN_PATH = '/v1/leaderboard/check-in';
export const LB_HISTOGRAM_PATH = '/v1/leaderboard/histogram';
const ROUTES = new Set([LB_SHADOWS_PATH, LB_COUNTS_PATH, LB_CHECK_IN_PATH, LB_HISTOGRAM_PATH]);

/** `sn_keccak('count_of')`, pinned in leaderboard.test.ts. */
export const COUNT_OF_SELECTOR = '0x1d655843ed5930f45f922b765b759b6a312463f0137fe8a130e1b83e897622e';

/** Every leaderboard route: each client's own bucket, refilled one every 2 s. */
export const LEADERBOARD_CLIENT_RATE_LIMIT = Object.freeze({ capacity: 30, refillMs: 2_000 });
/** A check-in recounts on-chain: three per client at once, one more a minute. */
export const LEADERBOARD_CHECK_IN_CLIENT_RATE_LIMIT = Object.freeze({ capacity: 3, refillMs: 60_000 });
/** And sixty check-ins a minute for everyone together. */
export const LEADERBOARD_CHECK_IN_RATE_LIMIT = Object.freeze({ maxRequests: 60, windowMs: 60_000 });

const DAY_MS = 86_400_000;
const STARK_FIELD_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;

export interface LeaderboardConfig {
  /** The `ReceiptLedger` contract. */
  readonly ledger: string;
  /** A JSON file on a persistent volume, or null to keep the tally in memory only. */
  readonly storePath: string | null;
}

/** One nonce of the anonymizer's `get_shadow_accounts` view. */
export interface LeaderboardShadowRead {
  readonly nonce: number;
  readonly address: string;
  readonly deployed: boolean;
}

/** The chain reads the tally makes, each pinned: the canonical anonymizer, and the configured ledger. */
export interface LeaderboardRpcPort {
  /** `get_shadow_accounts(p, start, start + page, false)`: exactly one row per nonce, in order. */
  getLeaderboardShadows(partialCommitment: string, start: number, count: number, signal?: AbortSignal): Promise<readonly LeaderboardShadowRead[]>;
  /** `count_of(C)` on `ledger` for each commitment, in order; null for a call that failed. */
  getLeaderboardCounts(ledger: string, commitments: readonly string[], signal?: AbortSignal): Promise<readonly (bigint | null)[]>;
}

export interface LeaderboardHistogramBody {
  readonly season: string;
  readonly total: number;
  readonly buckets: readonly { readonly count: number; readonly players: number }[];
}

/**
 * The season tally: per entry key, the count and the day it was last
 * refreshed. Memory first; with a path, written to a JSON file after each
 * change (atomically, through a temporary file) and read back at start.
 */
export class LeaderboardStore {
  private readonly seasons = new Map<string, Map<string, { count: number; day: number }>>();
  private writing: Promise<void> = Promise.resolve();
  private dirty = false;

  constructor(private readonly path: string | null) {}

  /** Read the file back, if there is one. A missing file is an empty tally; a malformed one is refused. */
  async load(): Promise<void> {
    if (!this.path) return;
    let text: string;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ENOENT') return;
      throw new Error('The leaderboard store could not be read.');
    }
    const parsed = parseStoreFile(text);
    if (!parsed) throw new Error('The leaderboard store is malformed.');
    for (const [season, entries] of parsed) this.seasons.set(season, entries);
  }

  upsert(season: string, key: string, count: number, now: number): void {
    let entries = this.seasons.get(season);
    if (!entries) {
      entries = new Map();
      this.seasons.set(season, entries);
    }
    if (!entries.has(key) && entries.size >= MAX_LEADERBOARD_ENTRIES) {
      throw new ApiFailure(503, 'The leaderboard is full for this season.');
    }
    entries.set(key, { count, day: Math.floor(now / DAY_MS) * DAY_MS });
    this.schedule();
  }

  histogram(season: string): LeaderboardHistogramBody {
    const byCount = new Map<number, number>();
    for (const { count } of this.seasons.get(season)?.values() ?? []) {
      byCount.set(count, (byCount.get(count) ?? 0) + 1);
    }
    const buckets = [...byCount.entries()]
      .sort(([a], [b]) => a - b)
      .map(([count, players]) => ({ count, players }));
    return { season, total: buckets.reduce((sum, bucket) => sum + bucket.players, 0), buckets };
  }

  /** What is kept, for tests: never more than the key, the count and the day. */
  snapshot(): Record<string, Record<string, { count: number; day: number }>> {
    return Object.fromEntries([...this.seasons].map(([season, entries]) => [
      season,
      Object.fromEntries([...entries].map(([key, value]) => [key, { ...value }])),
    ]));
  }

  /** Resolves once every change so far is on disk. */
  flushed(): Promise<void> {
    return this.writing;
  }

  private schedule(): void {
    if (!this.path) return;
    this.dirty = true;
    this.writing = this.writing.then(async () => {
      if (!this.dirty) return;
      this.dirty = false;
      await this.write();
    }).catch(() => {
      // A failed write is retried with the next change; the tally stays in memory.
      this.dirty = true;
    });
  }

  private async write(): Promise<void> {
    const path = this.path!;
    const body = JSON.stringify({ v: 1, seasons: this.snapshot() });
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.tmp`;
    await writeFile(temporary, body, { mode: 0o600 });
    await rename(temporary, path);
  }
}

export interface LeaderboardServiceOptions {
  readonly config: LeaderboardConfig;
  readonly rpc: LeaderboardRpcPort;
  readonly store: LeaderboardStore;
  readonly now?: () => number;
  readonly clientLimiter?: PerClientRateLimiter;
  readonly checkInClientLimiter?: PerClientRateLimiter;
  readonly checkInLimiter?: RequestRateLimiterPort;
  /** The store's load from disk; every route waits for it, and a failed load answers 503. */
  readonly ready?: Promise<void>;
}

export class LeaderboardService {
  private readonly config: LeaderboardConfig;
  private readonly rpc: LeaderboardRpcPort;
  private readonly store: LeaderboardStore;
  private readonly now: () => number;
  private readonly clientLimiter: PerClientRateLimiter;
  private readonly checkInClientLimiter: PerClientRateLimiter;
  private readonly checkInLimiter: RequestRateLimiterPort;
  private readonly ready: Promise<boolean>;

  constructor(options: LeaderboardServiceOptions) {
    if (!isFelt(options.config.ledger) || BigInt(options.config.ledger) === 0n) {
      throw new Error('The leaderboard ledger address is invalid.');
    }
    this.config = options.config;
    this.rpc = options.rpc;
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.clientLimiter = options.clientLimiter ?? new PerClientRateLimiter(
      LEADERBOARD_CLIENT_RATE_LIMIT.capacity, LEADERBOARD_CLIENT_RATE_LIMIT.refillMs, this.now,
    );
    this.checkInClientLimiter = options.checkInClientLimiter ?? new PerClientRateLimiter(
      LEADERBOARD_CHECK_IN_CLIENT_RATE_LIMIT.capacity, LEADERBOARD_CHECK_IN_CLIENT_RATE_LIMIT.refillMs, this.now,
    );
    this.checkInLimiter = options.checkInLimiter ?? new AggregateRateLimiter(
      LEADERBOARD_CHECK_IN_RATE_LIMIT.maxRequests, LEADERBOARD_CHECK_IN_RATE_LIMIT.windowMs, this.now,
    );
    this.ready = (options.ready ?? Promise.resolve()).then(() => true, () => false);
  }

  owns(path: string): boolean {
    return ROUTES.has(path);
  }

  async handle(request: ApiRequest, signal: AbortSignal): Promise<ApiResponse> {
    const client = request.client ?? 'unknown';
    const histogram = request.path === LB_HISTOGRAM_PATH;
    if (histogram ? request.method !== 'GET' : request.method !== 'POST') {
      throw new ApiFailure(405, 'Method not allowed.');
    }
    if (!this.clientLimiter.take(client)) return rateLimited();
    if (!await this.ready) throw new ApiFailure(503, 'The leaderboard is unavailable.');
    switch (request.path) {
      case LB_HISTOGRAM_PATH:
        return { status: 200, body: this.store.histogram(LEADERBOARD_SEASON) };
      case LB_SHADOWS_PATH:
        return this.shadows(request.body, signal);
      case LB_COUNTS_PATH:
        return this.counts(request.body, signal);
      case LB_CHECK_IN_PATH:
        if (!this.checkInClientLimiter.take(client) || !this.checkInLimiter.take()) return rateLimited();
        return this.checkIn(request.body, signal);
      default:
        throw new ApiFailure(404, 'Endpoint not found.');
    }
  }

  /** One page of the anonymizer's view for `p`. The request names `p` and a page; never a contract or a range. */
  private async shadows(body: unknown, signal: AbortSignal): Promise<ApiResponse> {
    const value = requireRecord(body, ['v', 'partialCommitment', 'page']);
    requireVersion(value);
    const partial = requireNonzeroFelt(value.partialCommitment, 'partial commitment');
    const page = value.page;
    if (!Number.isSafeInteger(page) || (page as number) < 0 || (page as number) >= MAX_LEADERBOARD_RECEIPTS / LEADERBOARD_SHADOW_PAGE) {
      throw new ApiFailure(400, 'Invalid page.');
    }
    const rows = await this.readPage(partial, page as number, signal);
    return { status: 200, body: { rows: rows.map((row) => ({ nonce: row.nonce, address: row.address, deployed: row.deployed })) } };
  }

  /** The ledger's `count_of` for up to one page of commitments. */
  private async counts(body: unknown, signal: AbortSignal): Promise<ApiResponse> {
    const value = requireRecord(body, ['v', 'commitments']);
    requireVersion(value);
    const commitments = value.commitments;
    if (!Array.isArray(commitments) || commitments.length === 0 || commitments.length > LEADERBOARD_SHADOW_PAGE) {
      throw new ApiFailure(400, 'Invalid commitments.');
    }
    const owned = commitments.map((commitment) => requireNonzeroFelt(commitment, 'commitment'));
    const counts = await this.readCounts(owned, signal);
    return { status: 200, body: { counts: counts.map(String) } };
  }

  /**
   * The blind tally. `p` is held in this call's locals and nowhere else: it
   * is read, hashed into the entry key, used for the chain reads, and goes
   * out of scope with the call. Nothing about it is logged or returned.
   */
  private async checkIn(body: unknown, signal: AbortSignal): Promise<ApiResponse> {
    const value = requireRecord(body, ['v', 'season', 'partialCommitment']);
    requireVersion(value);
    if (value.season !== LEADERBOARD_SEASON) throw new ApiFailure(400, 'Unknown season.');
    const partial = requireNonzeroFelt(value.partialCommitment, 'partial commitment');
    const count = await this.countReceipts(partial, signal);
    // Zero receipts store nothing: a random felt cannot pad the ranking.
    if (count > 0) this.store.upsert(LEADERBOARD_SEASON, leaderboardEntryKey(LEADERBOARD_SEASON, partial), count, this.now());
    return { status: 200, body: { count: String(count) } };
  }

  /** Every deployed receipt shadow for `p`, page by page, and the sum of the ledger's counts for them. */
  private async countReceipts(partial: string, signal: AbortSignal): Promise<number> {
    const commitments: string[] = [];
    for (let page = 0; page < MAX_LEADERBOARD_RECEIPTS / LEADERBOARD_SHADOW_PAGE; page += 1) {
      const rows = await this.readPage(partial, page, signal);
      const deployed = rows.filter((row) => row.deployed);
      for (const row of deployed) commitments.push(receiptCommitment(partial, row.nonce));
      if (deployed.length === 0) break;
    }
    let total = 0;
    for (let at = 0; at < commitments.length; at += LEADERBOARD_SHADOW_PAGE) {
      for (const count of await this.readCounts(commitments.slice(at, at + LEADERBOARD_SHADOW_PAGE), signal)) {
        total += count;
      }
    }
    return total;
  }

  private async readPage(partial: string, page: number, signal: AbortSignal): Promise<readonly LeaderboardShadowRead[]> {
    const start = page * LEADERBOARD_SHADOW_PAGE;
    const rows = await this.rpc.getLeaderboardShadows(partial, start, LEADERBOARD_SHADOW_PAGE, signal);
    if (rows.length !== LEADERBOARD_SHADOW_PAGE || rows.some((row, index) => row.nonce !== start + index)) {
      throw new Error('Starknet RPC returned an invalid shadow page.');
    }
    return rows;
  }

  private async readCounts(commitments: readonly string[], signal: AbortSignal): Promise<number[]> {
    const counts = await this.rpc.getLeaderboardCounts(this.config.ledger, commitments, signal);
    if (counts.length !== commitments.length) throw new Error('Starknet RPC returned invalid ledger counts.');
    return counts.map((count) => {
      if (count === null || count < 0n || count > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw new Error('Starknet RPC returned an invalid ledger count.');
      }
      return Number(count);
    });
  }
}

/** `C_n = h(p, n)`, the receipt's commitment, as the anonymizer salts its shadow account. */
export function receiptCommitment(partialCommitment: string, nonce: number): string {
  return `0x${poseidonHashMany([BigInt(partialCommitment), BigInt(nonce)]).toString(16)}`;
}

/**
 * `h(p, 'id')`, the entry key: Poseidon over a domain tag, the season and
 * `p`. Three elements, so it can never equal a receipt's two-element `h(p, n)`,
 * and without `p` it cannot be linked to any receipt or reversed.
 */
export function leaderboardEntryKey(season: string, partialCommitment: string): string {
  return `0x${poseidonHashMany([shortString('strkworld-lb-id'), shortString(season), BigInt(partialCommitment)]).toString(16)}`;
}

function shortString(text: string): bigint {
  let value = 0n;
  for (const char of text) value = (value << 8n) | BigInt(char.charCodeAt(0));
  if (text.length > 31 || value >= STARK_FIELD_PRIME) throw new Error('Invalid short string.');
  return value;
}

function rateLimited(): ApiResponse {
  return { status: 429, body: { code: 'RATE_LIMITED', message: 'Service is busy. Try again shortly.' } };
}

function parseStoreFile(text: string): Map<string, Map<string, { count: number; day: number }>> | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || (raw as { v?: unknown }).v !== 1) return null;
  const seasons = (raw as { seasons?: unknown }).seasons;
  if (!seasons || typeof seasons !== 'object' || Array.isArray(seasons)) return null;
  const out = new Map<string, Map<string, { count: number; day: number }>>();
  for (const [season, entries] of Object.entries(seasons as Record<string, unknown>)) {
    if (!/^[a-z0-9]{1,8}$/.test(season) || !entries || typeof entries !== 'object' || Array.isArray(entries)) return null;
    const map = new Map<string, { count: number; day: number }>();
    for (const [key, entry] of Object.entries(entries as Record<string, unknown>)) {
      const count = (entry as { count?: unknown })?.count;
      const day = (entry as { day?: unknown })?.day;
      if (
        !isFelt(key) || !Number.isSafeInteger(count) || (count as number) <= 0
        || !Number.isSafeInteger(day) || (day as number) % DAY_MS !== 0
        || Object.keys(entry as object).length !== 2
      ) {
        return null;
      }
      map.set(key, { count: count as number, day: day as number });
    }
    out.set(season, map);
  }
  return out;
}
