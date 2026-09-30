import type { VaultRateRead, VaultRatesPort } from './types.js';
import { VESU_VAULTS, vesuPoolApiUrl, type PinnedVault } from './vault.js';

/**
 * Vesu's supply APY for the Vault's pinned vaults (D-079), read from Vesu's
 * public API by this service itself, so Vesu never sees a player's IP (the
 * reason D-067 gives for avnu's token list). The endpoints are pinned, one per
 * Vesu pool a pinned vault supplies into (D-081), and need no key; nothing from
 * a request reaches them, and the answer names only pinned vaults and their
 * rates.
 *
 * One refresh serves every player for `ttlMs`: one GET per pinned pool, all at
 * once, on one timeout. Refreshes are single-flight and run on their own
 * timeout, so a player who stops waiting never cancels a refresh another
 * request shares. A pool whose read fails (down, slow, refused, oversized or
 * malformed) answers no rates for its vaults, and never touches another
 * pool's; a refresh with any such failure is kept only for the shorter retry
 * window, so a down API is not hammered and a recovered pool is asked again
 * soon. The Vault then shows no rate, never an old one presented as current.
 *
 * Vesu's pool answer lists each token as an asset with its `vToken` and
 * `stats.supplyApy` (`{ value, decimals }`, an integer and its decimal
 * places: 27351899613523568 with 18 is 2.735%). A pinned vault's rate counts
 * only when its own pool's answer names that pool, is not deprecated, and has
 * exactly one asset naming both its token and its vault, and the value is a
 * plain integer below 100 (10,000%).
 */

/** How long one good read is served (5 minutes). */
export const VESU_RATES_TTL_MS = 300_000;
/** After a failed read, how long "no rates" stands before Vesu is asked again. */
export const VESU_RATES_FAILURE_RETRY_MS = 60_000;
const DEFAULT_FETCH_TIMEOUT_MS = 5_000;
/** Vesu's largest pool answer is about 40 kB; far more is not a pool answer, and reading stops there. */
export const VESU_RATES_MAX_BODY_BYTES = 1_000_000;
const MAX_ASSETS = 128;
const MAX_DECIMALS = 36;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface VesuVaultRatesOptions {
  fetch?: FetchLike;
  now?: () => number;
  ttlMs?: number;
  failureRetryMs?: number;
  fetchTimeoutMs?: number;
  vaults?: readonly PinnedVault[];
}

export class VesuVaultRates implements VaultRatesPort {
  private readonly fetcher: FetchLike;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly failureRetryMs: number;
  private readonly fetchTimeoutMs: number;
  private readonly vaults: readonly PinnedVault[];
  /** Each pool the vaults name, once, in first-use order: the only endpoints ever read. */
  private readonly pools: readonly string[];
  private cached: { rates: readonly VaultRateRead[]; expiresAt: number } | null = null;
  private refreshing: Promise<readonly VaultRateRead[]> | null = null;

  constructor(options: VesuVaultRatesOptions = {}) {
    const injected = options.fetch;
    // Node's fetch rejects a foreign receiver, as the browser's does.
    this.fetcher = injected
      ? (input, init) => Reflect.apply(injected, undefined, [input, init]) as Promise<Response>
      : (input, init) => globalThis.fetch(input, init);
    this.now = options.now ?? Date.now;
    this.ttlMs = positiveInteger(options.ttlMs ?? VESU_RATES_TTL_MS, 'TTL');
    this.failureRetryMs = positiveInteger(options.failureRetryMs ?? VESU_RATES_FAILURE_RETRY_MS, 'retry window');
    this.fetchTimeoutMs = positiveInteger(options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS, 'fetch timeout');
    this.vaults = Object.freeze([...(options.vaults ?? VESU_VAULTS)]);
    this.pools = Object.freeze(this.vaults.map(({ pool }) => pool).filter((pool, index, pools) => (
      pools.findIndex((other) => sameFelt(other, pool)) === index
    )));
  }

  async rates(signal?: AbortSignal): Promise<readonly VaultRateRead[]> {
    throwIfAborted(signal);
    const cached = this.cached;
    if (cached && this.now() < cached.expiresAt) return cached.rates;
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = null;
    });
    return waitFor(this.refreshing, signal);
  }

  private async refresh(): Promise<readonly VaultRateRead[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new DOMException("Vesu's rates timed out.", 'TimeoutError'));
    }, this.fetchTimeoutMs);
    let reads: Array<readonly VaultRateRead[] | null>;
    try {
      reads = await Promise.all(this.pools.map(async (pool) => {
        try {
          return parseVesuPoolRates(await this.fetchPool(pool, controller.signal), pool, this.vaults);
        } catch {
          return null;
        }
      }));
    } finally {
      clearTimeout(timer);
    }
    const found = reads.flatMap((read) => read ?? []);
    // Pinned order, whichever pool answered first.
    const rates = Object.freeze(this.vaults.flatMap(({ vault }) => found.filter((rate) => sameFelt(rate.vault, vault))));
    const lifetime = reads.includes(null) ? Math.min(this.ttlMs, this.failureRetryMs) : this.ttlMs;
    this.cached = { rates, expiresAt: this.now() + lifetime };
    return rates;
  }

  private async fetchPool(pool: string, signal: AbortSignal): Promise<unknown> {
    const response = await this.fetcher(vesuPoolApiUrl(pool), {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal,
    });
    if (!response.ok) throw new Error('Vesu refused the pool read.');
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (!Number.isFinite(declared) || declared > VESU_RATES_MAX_BODY_BYTES) throw new Error("Vesu's pool answer is too large.");
    return JSON.parse(await readBoundedText(response, VESU_RATES_MAX_BODY_BYTES)) as unknown;
  }
}

/**
 * The body as text, read chunk by chunk and abandoned the moment it passes
 * `maxBytes`, decompressed bytes counted, so neither a missing
 * `content-length` nor a compressed body can make the backend buffer more.
 * The fetch's own timeout still ends a slow body.
 */
async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body) return '';
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new Error("Vesu's pool answer is too large.");
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released by the cancel.
    }
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(joined);
}

/**
 * The rates of the pinned vaults that supply into `pool`, out of Vesu's answer
 * for that pool, in pinned order. A malformed answer, or one about another
 * pool, throws; a vault with no clean rate is left out.
 */
export function parseVesuPoolRates(
  payload: unknown,
  pool: string,
  vaults: readonly PinnedVault[] = VESU_VAULTS,
): readonly VaultRateRead[] {
  const data = ownValue(payload, 'data');
  const id = ownValue(data, 'id');
  if (typeof id !== 'string' || !sameFelt(id, pool)) throw new Error('Not the pinned pool.');
  if (ownValue(data, 'isDeprecated') !== false) throw new Error('The pool is deprecated.');
  const assets = ownValue(data, 'assets');
  if (!Array.isArray(assets) || assets.length > MAX_ASSETS) throw new Error('Malformed pool assets.');
  const rates: VaultRateRead[] = [];
  for (const { token, vault } of vaults.filter((entry) => sameFelt(entry.pool, pool))) {
    const matching = assets.filter((asset) => {
      const address = ownValue(asset, 'address');
      const vToken = ownValue(ownValue(asset, 'vToken'), 'address');
      return typeof address === 'string' && sameFelt(address, token)
        && typeof vToken === 'string' && sameFelt(vToken, vault);
    });
    if (matching.length !== 1) continue;
    const apy = ownValue(ownValue(matching[0], 'stats'), 'supplyApy');
    const value = ownValue(apy, 'value');
    const decimals = ownValue(apy, 'decimals');
    if (
      typeof value !== 'string' || !/^(?:0|[1-9][0-9]{0,39})$/.test(value)
      || typeof decimals !== 'number' || !Number.isSafeInteger(decimals) || decimals < 0 || decimals > MAX_DECIMALS
      || BigInt(value) >= 100n * 10n ** BigInt(decimals)
    ) {
      continue;
    }
    rates.push(Object.freeze({ vault, supplyApy: Object.freeze({ value: BigInt(value), decimals }) }));
  }
  return Object.freeze(rates);
}

/** An own data property of an object, or undefined; an accessor is never run. */
function ownValue(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function sameFelt(value: string, expected: string): boolean {
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(value)) return false;
  return BigInt(value) === BigInt(expected);
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Backend Vesu rates ${label} must be a positive integer.`);
  return value;
}

function waitFor<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('Request aborted.', 'AbortError');
}
