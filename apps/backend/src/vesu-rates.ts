import type { VaultRateRead, VaultRatesPort } from './types.js';
import { VESU_PRIME_POOL, VESU_PRIME_POOL_API_URL, VESU_VAULTS, type PinnedVault } from './vault.js';

/**
 * Vesu's supply APY for the Vault's pinned vaults (D-079), read from Vesu's
 * public API by this service itself, so Vesu never sees a player's IP (the
 * reason D-067 gives for avnu's token list). The endpoint is pinned and needs
 * no key; nothing from a request reaches it, and the answer names only
 * pinned vaults and their rates.
 *
 * One upstream read serves every player for `ttlMs`. Refreshes are
 * single-flight and run on their own timeout, so a player who stops waiting
 * never cancels a refresh another request shares. A failed refresh (down,
 * slow, refused, oversized or malformed) answers no rates and is cached for a
 * shorter retry window, so a down API is not hammered; the Vault then shows
 * no rate, never an old one presented as current.
 *
 * Vesu's pool answer lists each token as an asset with its `vToken` and
 * `stats.supplyApy` (`{ value, decimals }`, an integer and its decimal
 * places: 27351899613523568 with 18 is 2.735%). A pinned vault's rate counts
 * only when exactly one asset names both its token and its vault, the pool is
 * the Prime pool and not deprecated, and the value is a plain integer below
 * 100 (10,000%).
 */

/** How long one good read is served (5 minutes). */
export const VESU_RATES_TTL_MS = 300_000;
/** After a failed read, how long "no rates" stands before Vesu is asked again. */
export const VESU_RATES_FAILURE_RETRY_MS = 60_000;
const DEFAULT_FETCH_TIMEOUT_MS = 5_000;
/** Vesu's Prime answer is about 40,000 characters; far more is not a pool answer. */
export const VESU_RATES_MAX_BODY_LENGTH = 1_000_000;
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
    let rates: readonly VaultRateRead[];
    let lifetime: number;
    try {
      rates = parseVesuPoolRates(await this.fetchPool(controller.signal), this.vaults);
      lifetime = this.ttlMs;
    } catch {
      rates = Object.freeze([]);
      lifetime = Math.min(this.ttlMs, this.failureRetryMs);
    } finally {
      clearTimeout(timer);
    }
    this.cached = { rates, expiresAt: this.now() + lifetime };
    return rates;
  }

  private async fetchPool(signal: AbortSignal): Promise<unknown> {
    const response = await this.fetcher(VESU_PRIME_POOL_API_URL, {
      method: 'GET',
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal,
    });
    if (!response.ok) throw new Error('Vesu refused the pool read.');
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (!Number.isFinite(declared) || declared > VESU_RATES_MAX_BODY_LENGTH) throw new Error("Vesu's pool answer is too large.");
    const text = await response.text();
    if (text.length > VESU_RATES_MAX_BODY_LENGTH) throw new Error("Vesu's pool answer is too large.");
    return JSON.parse(text) as unknown;
  }
}

/**
 * The pinned vaults' rates out of Vesu's pool answer, in pinned order. A
 * malformed answer throws; a vault with no clean rate is left out.
 */
export function parseVesuPoolRates(payload: unknown, vaults: readonly PinnedVault[] = VESU_VAULTS): readonly VaultRateRead[] {
  const data = ownValue(payload, 'data');
  const id = ownValue(data, 'id');
  if (typeof id !== 'string' || !sameFelt(id, VESU_PRIME_POOL)) throw new Error('Not the Prime pool.');
  if (ownValue(data, 'isDeprecated') !== false) throw new Error('The Prime pool is deprecated.');
  const assets = ownValue(data, 'assets');
  if (!Array.isArray(assets) || assets.length > MAX_ASSETS) throw new Error('Malformed pool assets.');
  const rates: VaultRateRead[] = [];
  for (const { token, vault } of vaults) {
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
