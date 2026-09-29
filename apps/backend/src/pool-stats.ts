import type { ChainHead, PoolEventsPage, PoolStatsPort, PoolStatsRpcPort, PoolStatsSnapshot } from './types.js';
import { isFelt } from './validation.js';

/**
 * The Privacy Plaza's public pool stats (D-076), computed in the background
 * and served from memory.
 *
 * Three aggregates, all public chain facts, none about a player:
 *
 * - accounts registered: the pool's `ViewingKeySet` events since its first
 *   block (one per account: a viewing key is set once);
 * - deposits in the last 24 hours: its `Deposit` events in the last
 *   `DEPOSIT_WINDOW_BLOCKS` blocks;
 * - held in the pool: `balance_of(pool)` on each pinned token.
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
 * Reading never waits on the chain. The route serves the last good value of
 * each part (null until a part has one) and, when it is a minute old, starts
 * the next refresh in the background. Refreshes run about every 60 s while
 * someone keeps asking, one at a time, and stop after ten quiet minutes. A
 * part whose refresh fails keeps its last good value. Nothing is logged
 * (D-014).
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
 * The tokens whose pool balance is read: the six the web's Exchange catalog
 * describes (`apps/web/src/panels/exchange/catalog.ts`; pool-stats.test.ts
 * checks they agree). The web shows those on its own shield allowlist. Pinned
 * here, never taken from a request, so the route cannot be made to call an
 * arbitrary contract.
 */
export const POOL_STATS_TOKENS: readonly string[] = Object.freeze([
  '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
  '0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7',
  '0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb',
  '0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8',
  '0x03fe2b97c1fd336e750087d68b9b867997fd64a2661ff3ca5a7c771641e8e7ac',
  '0x0787150e306e6eae6e3f79dea881770e8bbff2c1b8eb490f969669ee945b3135',
]);

export const EMPTY_POOL_STATS: PoolStatsSnapshot = Object.freeze({ accounts: null, deposits24h: null, held: null });

/** Returns a cancel. The default runs on an unref'd timer, so it never holds the process open. */
export type PoolStatsScheduler = (callback: () => void, ms: number) => () => void;

export interface PoolStatsCacheOptions {
  readonly rpc: PoolStatsRpcPort;
  readonly now?: () => number;
  readonly schedule?: PoolStatsScheduler;
  readonly tokens?: readonly string[];
  readonly firstBlock?: number;
  readonly windowBlocks?: number;
  readonly scanWindow?: number;
  readonly refreshMs?: number;
  readonly idleMs?: number;
  readonly rpcTimeoutMs?: number;
}

const defaultSchedule: PoolStatsScheduler = (callback, ms) => {
  const timer = setTimeout(callback, ms);
  (timer as { unref?: () => void }).unref?.();
  return () => clearTimeout(timer);
};

export class PoolStatsCache implements PoolStatsPort {
  private readonly rpc: PoolStatsRpcPort;
  private readonly now: () => number;
  private readonly schedule: PoolStatsScheduler;
  private readonly tokens: readonly string[];
  private readonly firstBlock: number;
  private readonly windowBlocks: number;
  private readonly scanWindow: number;
  private readonly refreshMs: number;
  private readonly idleMs: number;
  private readonly rpcTimeoutMs: number;

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
    this.now = options.now ?? Date.now;
    this.schedule = options.schedule ?? defaultSchedule;
    this.tokens = Object.freeze([...(options.tokens ?? POOL_STATS_TOKENS)]);
    this.firstBlock = options.firstBlock ?? POOL_FIRST_BLOCK;
    this.windowBlocks = options.windowBlocks ?? DEPOSIT_WINDOW_BLOCKS;
    this.scanWindow = options.scanWindow ?? POOL_STATS_SCAN_WINDOW;
    this.refreshMs = options.refreshMs ?? POOL_STATS_REFRESH_MS;
    this.idleMs = options.idleMs ?? POOL_STATS_IDLE_MS;
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? POOL_STATS_RPC_TIMEOUT_MS;
    for (const [name, value] of Object.entries({
      firstBlock: this.firstBlock,
      windowBlocks: this.windowBlocks,
      scanWindow: this.scanWindow,
      refreshMs: this.refreshMs,
      idleMs: this.idleMs,
      rpcTimeoutMs: this.rpcTimeoutMs,
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
    for (const part of [() => this.refreshHeld(), () => this.refreshDeposits(head), () => this.refreshRegistrations(head)]) {
      try {
        await part();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'Pool stats refresh was partial.');
  }

  /**
   * One read per token. A token whose read fails keeps its last good amount,
   * or is left out until it has one; only when every read fails does the
   * whole part keep its last good value.
   */
  private async refreshHeld(): Promise<void> {
    const results = await Promise.allSettled(
      this.tokens.map((token) => this.read((signal) => this.rpc.getPoolBalance(token, signal))),
    );
    const previous = this.served.held ?? [];
    const held: { readonly token: string; readonly amount: bigint }[] = [];
    let read = 0;
    this.tokens.forEach((token, index) => {
      const result = results[index]!;
      if (result.status === 'fulfilled' && typeof result.value === 'bigint' && result.value >= 0n) {
        read += 1;
        held.push(Object.freeze({ token, amount: result.value }));
        return;
      }
      const kept = previous.find((entry) => entry.token === token);
      if (kept) held.push(kept);
    });
    if (read === 0) throw new Error('Pool stats could not read any pool balance.');
    this.publish({ held: Object.freeze(held) });
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

  private async read<T>(call: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new DOMException('A pool stats read timed out.', 'TimeoutError'));
    }, this.rpcTimeoutMs);
    (timer as { unref?: () => void }).unref?.();
    try {
      return await call(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Whether an RPC port can serve the pool stats' narrow reads. */
export function isPoolStatsRpc(value: unknown): value is PoolStatsRpcPort {
  if (!value || typeof value !== 'object') return false;
  const port = value as Partial<Record<keyof PoolStatsRpcPort, unknown>>;
  return typeof port.getHead === 'function'
    && typeof port.getPoolEvents === 'function'
    && typeof port.getPoolBalance === 'function';
}
