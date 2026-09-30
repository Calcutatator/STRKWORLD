import type {
  ChainHead,
  PoolEventsPage,
  PoolStatsPort,
  PoolStatsRpcPort,
  PoolStatsSnapshot,
  PoolTokenValue,
  PoolValueRead,
  PoolValueSourcePort,
} from './types.js';
import { isFelt } from './validation.js';

/**
 * The Privacy Plaza's public pool stats (D-076, value fields D-080), computed
 * in the background and served from memory.
 *
 * Four aggregates, all public facts, none about a player:
 *
 * - accounts registered: the pool's `ViewingKeySet` events since its first
 *   block (one per account: a viewing key is set once);
 * - deposits in the last 24 hours: its `Deposit` events in the last
 *   `DEPOSIT_WINDOW_BLOCKS` blocks;
 * - held in the pool, in USD: the pool's total value and its highest-value
 *   holdings, read from Voyager through strkprice.com's public proxy
 *   (`PLAZA_POOL_VALUE_URL`), which needs no key and sees no user data;
 * - how many distinct tokens the pool holds.
 *
 * The scans are incremental and cursor-based. The first registration scan
 * reads the pool's whole life once, a window of blocks at a time, committing
 * after each window so a failure resumes where it stopped; after that each
 * refresh reads only the blocks since the last. The deposit window keeps the
 * block number of each deposit it has counted, and nothing else, and drops
 * the ones that age out. No address, key, amount or transaction hash is ever
 * held: the RPC port hands back block numbers only.
 *
 * A scan never takes a node's word that it has reached a block number: a
 * numeric `to_block` past a node's tip is answered short, with no error, and
 * behind a load balancer the node answering the events can trail the one
 * that gave the head. So the window that reaches the head names it by hash,
 * which a trailing node refuses, and a window that ends by number ends at
 * least a whole window (about five days) below the head.
 *
 * The pool's value is a separate, single HTTP read of the external aggregate,
 * on its own bounded timeout, validated strictly: the total and every
 * holding's amount must be finite and non-negative, every symbol is cleaned
 * to short printable ASCII or dropped, every address must be a valid felt,
 * and the holdings kept are capped to the highest-value few. A malformed or
 * unreachable answer fails that part alone, keeping its last good value.
 *
 * Reading never waits on the chain or the aggregate. The route serves the
 * last good value of each part (null until a part has one) and, when it is a
 * minute old, starts the next refresh in the background. Refreshes run about
 * every 60 s while someone keeps asking, one at a time, and stop after ten
 * quiet minutes. A part whose refresh fails keeps its last good value.
 * Nothing is logged (D-014).
 */

/** The canonical mainnet pool's first block, where the registration scan starts. */
export const POOL_FIRST_BLOCK = 8_978_970;

/** `sn_keccak('ViewingKeySet')`: keys `[selector, user_addr, public_key]`, pinned in pool-stats.test.ts. */
export const VIEWING_KEY_SET_EVENT = '0x1321a492485b4f19851fb787ab3800a0030b595332cba93cd5fe40dfb5a4daf';

/** `sn_keccak('Deposit')`: keys `[selector, user_addr, token]` (D-072). */
export const DEPOSIT_EVENT = '0x9149d2123147c5f43d258257fef0b7b969db78269369ebcf5ebb9eef8592f2';

/** A day of blocks at about 1.68 s a block. */
export const DEPOSIT_WINDOW_BLOCKS = Math.ceil(86_400 / 1.68);

/** How often a refresh starts while someone is asking. */
export const POOL_STATS_REFRESH_MS = 60_000;

/** After this long without a request the refreshes stop, until the next one. */
export const POOL_STATS_IDLE_MS = 10 * 60_000;

/** Blocks per registration-scan window; progress commits after each. */
export const POOL_STATS_SCAN_WINDOW = 250_000;

/** Longest a single RPC read may take. */
export const POOL_STATS_RPC_TIMEOUT_MS = 10_000;

/**
 * The route's own rate window, apart from the one the private routes share:
 * the figures come from memory and cost the chain nothing, so a crowd at the
 * plaza never takes a slot a fee quote or a submission needs.
 */
export const POOL_STATS_RATE_LIMIT = Object.freeze({ maxRequests: 600, windowMs: 60_000 });

/** More pages than one window should ever need; beyond it the node is misbehaving. */
const MAX_PAGES_PER_SCAN = 1_000;

/**
 * D-080: strkprice.com's public proxy over Voyager, summing the pool's USD
 * value across every token it holds, with a GeckoTerminal price fallback,
 * cached there for 20 s. Public, no key. `PLAZA_POOL_VALUE_URL` overrides it;
 * either way `environment.ts` requires https.
 */
export const DEFAULT_POOL_VALUE_URL = 'https://strkprice-pool-api-production.up.railway.app/api/pool';

/** Longest a single read of the pool value aggregate may take. */
export const POOL_VALUE_FETCH_TIMEOUT_MS = 15_000;

/** Holdings kept from the aggregate's answer: the highest-value few. */
export const MAX_TOP_HOLDINGS = 10;

/** Longest a cleaned symbol may be; anything longer is not a symbol, it's noise. */
export const MAX_SYMBOL_LENGTH = 16;

export const EMPTY_POOL_STATS: PoolStatsSnapshot = Object.freeze({
  accounts: null,
  deposits24h: null,
  valueUsd: null,
  topHoldings: null,
  valueAsOf: null,
  tokenCount: null,
});

/** Returns a cancel. The default runs on an unref'd timer, so it never holds the process open. */
export type PoolStatsScheduler = (callback: () => void, ms: number) => () => void;

export interface PoolStatsCacheOptions {
  readonly rpc: PoolStatsRpcPort;
  /** D-080: the external USD-value aggregate. Without it, valueUsd/topHoldings/tokenCount stay null. */
  readonly poolValue?: PoolValueSourcePort;
  readonly now?: () => number;
  readonly schedule?: PoolStatsScheduler;
  readonly firstBlock?: number;
  readonly windowBlocks?: number;
  readonly scanWindow?: number;
  readonly refreshMs?: number;
  readonly idleMs?: number;
  readonly rpcTimeoutMs?: number;
  /** Longest one read of the pool value aggregate may take. */
  readonly poolValueTimeoutMs?: number;
}

const defaultSchedule: PoolStatsScheduler = (callback, ms) => {
  const timer = setTimeout(callback, ms);
  (timer as { unref?: () => void }).unref?.();
  return () => clearTimeout(timer);
};

export class PoolStatsCache implements PoolStatsPort {
  private readonly rpc: PoolStatsRpcPort;
  private readonly poolValue?: PoolValueSourcePort;
  private readonly now: () => number;
  private readonly schedule: PoolStatsScheduler;
  private readonly firstBlock: number;
  private readonly windowBlocks: number;
  private readonly scanWindow: number;
  private readonly refreshMs: number;
  private readonly idleMs: number;
  private readonly rpcTimeoutMs: number;
  private readonly poolValueTimeoutMs: number;

  /** Registrations counted in `[firstBlock, cursor]`; null before the first window. */
  private registrations: { cursor: number | null; count: number } = { cursor: null, count: 0 };
  /** Deposit blocks counted up to `cursor`, only those still inside the window. */
  private deposits: { cursor: number | null; blocks: readonly number[] } = { cursor: null, blocks: [] };
  private served: PoolStatsSnapshot = EMPTY_POOL_STATS;
  private inFlight: Promise<void> | null = null;
  private cancelNext: (() => void) | null = null;
  private lastAsked = Number.NEGATIVE_INFINITY;

  constructor(options: PoolStatsCacheOptions) {
    this.rpc = options.rpc;
    this.poolValue = options.poolValue;
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? defaultSchedule;
    this.firstBlock = options.firstBlock ?? POOL_FIRST_BLOCK;
    this.windowBlocks = options.windowBlocks ?? DEPOSIT_WINDOW_BLOCKS;
    this.scanWindow = options.scanWindow ?? POOL_STATS_SCAN_WINDOW;
    this.refreshMs = options.refreshMs ?? POOL_STATS_REFRESH_MS;
    this.idleMs = options.idleMs ?? POOL_STATS_IDLE_MS;
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? POOL_STATS_RPC_TIMEOUT_MS;
    this.poolValueTimeoutMs = options.poolValueTimeoutMs ?? POOL_VALUE_FETCH_TIMEOUT_MS;
    for (const [name, value] of Object.entries({
      firstBlock: this.firstBlock,
      windowBlocks: this.windowBlocks,
      scanWindow: this.scanWindow,
      refreshMs: this.refreshMs,
      idleMs: this.idleMs,
      rpcTimeoutMs: this.rpcTimeoutMs,
      poolValueTimeoutMs: this.poolValueTimeoutMs,
    })) {
      if (!Number.isSafeInteger(value) || value < (name === 'firstBlock' ? 0 : 1)) {
        throw new Error(`Pool stats ${name} must be a positive integer.`);
      }
    }
  }

  /** The last good value of each part, at once. Keeps the background refresh going. */
  snapshot(): PoolStatsSnapshot {
    this.lastAsked = this.now();
    this.ensureRefreshing();
    return this.served;
  }

  /** The same value as `snapshot()`, without keeping the refresh going. */
  peek(): PoolStatsSnapshot {
    return this.served;
  }

  warm(): void {
    this.lastAsked = this.now();
    this.ensureRefreshing();
  }

  /** Cancel the next scheduled refresh. One already running finishes, and schedules nothing. */
  stop(): void {
    this.lastAsked = Number.NEGATIVE_INFINITY;
    this.cancelNext?.();
    this.cancelNext = null;
  }

  /** One refresh, awaited: the test seam, and what the scheduler runs. */
  refresh(): Promise<void> {
    this.inFlight ??= this.runRefresh().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private ensureRefreshing(): void {
    // A refresh is running, or the next is already booked.
    if (this.inFlight || this.cancelNext) return;
    void this.cycle();
  }

  private async cycle(): Promise<void> {
    const started = this.now();
    try {
      await this.refresh();
    } catch {
      // Each part already kept its last good value.
    }
    if (this.cancelNext || this.now() - this.lastAsked >= this.idleMs) return;
    const wait = Math.max(0, started + this.refreshMs - this.now());
    this.cancelNext = this.schedule(() => {
      this.cancelNext = null;
      void this.cycle();
    }, wait);
  }

  private async runRefresh(): Promise<void> {
    const latest = await this.read((signal) => this.rpc.getHead(signal));
    const head: ChainHead = { number: latest?.number, hash: latest?.hash };
    if (
      !Number.isSafeInteger(head.number) || head.number < 0 ||
      typeof head.hash !== 'string' || !isFelt(head.hash)
    ) {
      throw new Error('Pool stats read an invalid head.');
    }
    // Quick parts first, so a first visitor sees them while the long first
    // registration scan runs. A failed part keeps its last good value.
    const failures: unknown[] = [];
    const parts: Array<() => Promise<void>> = [];
    if (this.poolValue) parts.push(() => this.refreshValue());
    parts.push(() => this.refreshDeposits(head), () => this.refreshRegistrations(head));
    for (const part of parts) {
      try {
        await part();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Pool stats refresh was partial.');
  }

  /**
   * D-080: one read of the external USD-value aggregate, on its own timeout.
   * The port has already validated and capped its answer strictly; a
   * malformed or unreachable answer throws here, which keeps this part's
   * last good value exactly like a failed chain read.
   */
  private async refreshValue(): Promise<void> {
    const read = await this.read((signal) => this.poolValue!.load(signal), this.poolValueTimeoutMs);
    this.publish({
      valueUsd: read.usd,
      topHoldings: Object.freeze(read.topHoldings.map((holding) => Object.freeze({ ...holding }))),
      valueAsOf: new Date(this.now()).toISOString(),
      tokenCount: read.tokenCount,
    });
  }

  private async refreshDeposits(head: ChainHead): Promise<void> {
    const oldest = head.number - this.windowBlocks + 1;
    let { cursor, blocks } = this.deposits;
    // Nothing yet, or a gap longer than the window: count the window afresh.
    if (cursor === null || cursor < oldest - 1) {
      cursor = Math.max(oldest, this.firstBlock) - 1;
      blocks = [];
    }
    if (head.number > cursor) {
      // Always one range, up to the head named by hash.
      const found = await this.scan(DEPOSIT_EVENT, cursor + 1, head.number, head.hash);
      blocks = [...blocks, ...found];
      cursor = head.number;
    }
    const kept = Object.freeze(blocks.filter((block) => block >= oldest));
    this.deposits = { cursor, blocks: kept };
    this.publish({ deposits24h: kept.length });
  }

  private async refreshRegistrations(head: ChainHead): Promise<void> {
    let { cursor, count } = this.registrations;
    let from = cursor === null ? this.firstBlock : cursor + 1;
    while (from <= head.number) {
      // The last window reaches the head and names it by hash; any before it
      // ends by number at least a whole window below the head.
      const last = head.number - from < this.scanWindow;
      const to = last ? head.number : Math.min(from + this.scanWindow - 1, head.number - this.scanWindow);
      const found = await this.scan(VIEWING_KEY_SET_EVENT, from, to, last ? head.hash : null);
      count += found.length;
      cursor = to;
      // Commit each window: a later failure resumes here, not from the start.
      this.registrations = { cursor, count };
      from = to + 1;
    }
    // Served only once the count has caught up with a head, never mid-scan.
    if (cursor !== null && cursor >= head.number) this.publish({ accounts: count });
  }

  /** Every matching event's block in `[from, to]`, across the node's pages; `toHash` names `to`. */
  private async scan(key: string, from: number, to: number, toHash: string | null): Promise<number[]> {
    const blocks: number[] = [];
    const seen = new Set<string>();
    let continuationToken: string | null = null;
    for (let page = 0; page < MAX_PAGES_PER_SCAN; page++) {
      const token: string | null = continuationToken;
      const result: PoolEventsPage = await this.read(
        (signal) => this.rpc.getPoolEvents({ key, fromBlock: from, toBlock: to, toBlockHash: toHash, continuationToken: token }, signal),
      );
      for (const block of result.blocks) {
        if (!Number.isSafeInteger(block) || block < from || block > to) {
          throw new Error('Pool stats read an event outside its block range.');
        }
        blocks.push(block);
      }
      const next: string | null = result.continuationToken;
      if (next === null) return blocks;
      if (seen.has(next)) throw new Error('Pool stats read a repeated continuation token.');
      seen.add(next);
      continuationToken = next;
    }
    throw new Error('Pool stats read too many event pages.');
  }

  private publish(part: Partial<PoolStatsSnapshot>): void {
    this.served = Object.freeze({ ...this.served, ...part });
  }

  private async read<T>(call: (signal: AbortSignal) => Promise<T>, timeoutMs: number = this.rpcTimeoutMs): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new DOMException('A pool stats read timed out.', 'TimeoutError'));
    }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
    try {
      return await call(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Whether an RPC port can serve the pool stats' narrow chain reads. */
export function isPoolStatsRpc(value: unknown): value is PoolStatsRpcPort {
  if (!value || typeof value !== 'object') return false;
  const port = value as Partial<Record<keyof PoolStatsRpcPort, unknown>>;
  return typeof port.getHead === 'function' && typeof port.getPoolEvents === 'function';
}

// ---------------------------------------------------------------------------
// D-080: the pool's USD value, read from the external aggregate
// ---------------------------------------------------------------------------

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface PoolValueSourceOptions {
  /** `PLAZA_POOL_VALUE_URL`, already validated https-only by `environment.ts`. */
  readonly url: string;
  readonly fetcher?: FetchLike;
}

/**
 * D-080: fetches strkprice.com's public pool-value proxy and validates its
 * answer strictly. Called from the backend only — its CORS allows strkprice
 * origins alone, so a browser could not read it even if asked to.
 *
 * Times out only through the `signal` it is given: like every other RPC port
 * here, the timeout is `PoolStatsCache`'s to own (`poolValueTimeoutMs`), not
 * each port's own.
 */
export class HttpPoolValueSource implements PoolValueSourcePort {
  private readonly url: string;
  private readonly fetcher: FetchLike;

  constructor(options: PoolValueSourceOptions) {
    if (!isHttpsUrl(options.url)) throw new Error('Pool value URL must be https.');
    this.url = options.url;
    this.fetcher = options.fetcher ?? ((input, init) => globalThis.fetch(input, init));
  }

  async load(signal?: AbortSignal): Promise<PoolValueRead> {
    const response = await this.fetcher(this.url, { method: 'GET', signal });
    if (!response.ok) throw new Error('The pool value aggregate refused the read.');
    return parsePoolValueResponse(await response.json());
  }
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Reads the aggregate's answer strictly: the total and `tokens` must be
 * present and well-typed, or the whole read fails (keeping the cache's last
 * good value). Within `tokens`, one malformed entry is dropped rather than
 * failing every other one: a single bad or unpriced token should not hide
 * the rest of a 40-token pool. `tokenCount` is taken as a plain count; the
 * `unpriced` symbol list (if any) is never read beyond confirming its shape,
 * since nothing here exposes raw upstream strings besides a cleaned symbol.
 */
export function parsePoolValueResponse(value: unknown): PoolValueRead {
  if (!isRecord(value)) throw invalid();
  const usd = ownValue(value, 'usd');
  if (typeof usd !== 'number' || !isFiniteNonNegative(usd)) throw invalid();
  const tokensValue = ownValue(value, 'tokens');
  if (!Array.isArray(tokensValue)) throw invalid();
  const unpricedValue = ownValue(value, 'unpriced');
  if (unpricedValue !== undefined && !Array.isArray(unpricedValue)) throw invalid();

  const candidates: PoolTokenValue[] = [];
  for (const item of ownItems(tokensValue)) {
    if (!isRecord(item)) continue;
    const rawUsd = ownValue(item, 'usd');
    const rawAddress = ownValue(item, 'address');
    const rawSymbol = ownValue(item, 'symbol');
    if (typeof rawUsd !== 'number' || !isFiniteNonNegative(rawUsd)) continue;
    if (typeof rawAddress !== 'string' || !isFelt(rawAddress) || BigInt(rawAddress) === 0n) continue;
    const symbol = cleanSymbol(rawSymbol);
    if (symbol === null) continue;
    candidates.push(Object.freeze({ symbol, usd: rawUsd }));
  }
  candidates.sort((a, b) => b.usd - a.usd);
  const topHoldings = Object.freeze(candidates.slice(0, MAX_TOP_HOLDINGS));

  const rawCount = ownValue(value, 'tokenCount');
  const tokenCount = typeof rawCount === 'number' && Number.isSafeInteger(rawCount) && rawCount >= 0 ? rawCount : null;

  return Object.freeze({ usd, topHoldings, tokenCount });
}

/** Printable ASCII only, trimmed, 1-16 characters; anything else (homoglyphs, control bytes) is not a symbol. */
function cleanSymbol(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[^\x20-\x7E]/g, '').trim();
  return cleaned.length >= 1 && cleaned.length <= MAX_SYMBOL_LENGTH ? cleaned : null;
}

function isFiniteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function isRecord(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Own-property reads only: a getter on the prototype chain must not smuggle a value past validation. */
function ownValue(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function ownItems(array: readonly unknown[]): unknown[] {
  const length = Object.getOwnPropertyDescriptor(array, 'length');
  if (!length || !('value' in length) || !Number.isSafeInteger(length.value)) throw invalid();
  const items: unknown[] = [];
  for (let index = 0; index < (length.value as number); index += 1) {
    items.push(Object.getOwnPropertyDescriptor(array, String(index))?.value);
  }
  return items;
}

function invalid(): Error {
  return new Error('The pool value aggregate answered with a malformed body.');
}
