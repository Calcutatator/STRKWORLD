import { fetchTokens } from '@avnu/avnu-sdk';
import {
  CURATED_ONLY_SNAPSHOT,
  degenSnapshot,
  filterLiveTokens,
  validateDegenConfig,
} from './degen-catalog.js';
import type { DegenCatalogPort, DegenCatalogSnapshot, DegenConfig } from './types.js';

interface AvnuTokenFunctions {
  fetchTokens: typeof fetchTokens;
}

export interface AvnuDegenCatalogOptions {
  config: DegenConfig;
  /** `AVNU_BASE_URL`; the SDK default (`https://starknet.api.avnu.fi`) applies when unset. */
  baseUrl?: string;
  functions?: AvnuTokenFunctions;
  now?: () => number;
  /** Bound on one refresh, independent of any player's request deadline. */
  fetchTimeoutMs?: number;
}

/** avnu returns at most 200 tokens a page, whatever is asked for (read 2026-09-28). */
export const AVNU_TOKEN_PAGE_SIZE = 200;
/** A refresh never reads more than this many pages. */
export const AVNU_TOKEN_MAX_PAGES = 5;
const DEFAULT_FETCH_TIMEOUT_MS = 5_000;
/** After a failed refresh, the curated-only answer stands this long before avnu is asked again. */
export const DEGEN_FAILURE_RETRY_MS = 60_000;

/**
 * avnu's live token list, fetched by the backend itself so avnu never sees a
 * player's IP (D-067), filtered, and cached for the configured TTL.
 *
 * Refreshes are single-flight and run on their own timeout: a player whose
 * request is cancelled stops waiting, but never cancels the refresh another
 * request shares. Any failure (unreachable, timed out, rejected, malformed)
 * fails safe to the curated core alone, which is cached for a shorter retry
 * window so a down API is not hammered. Nothing from a request reaches the
 * fetch: it asks for fixed tags and pages only.
 *
 * avnu sorts the list by `lastDailyVolumeUsd`, highest first, and ignores any
 * other sort it is asked for (checked 2026-09-28). Paging therefore stops at
 * the first page whose last token is below the floor. Every token is still
 * filtered on its own, so a changed order can only list fewer tokens.
 */
export class AvnuDegenCatalog implements DegenCatalogPort {
  private readonly config: DegenConfig;
  private readonly baseUrl?: string;
  private readonly functions: AvnuTokenFunctions;
  private readonly now: () => number;
  private readonly fetchTimeoutMs: number;
  private cached: { snapshot: DegenCatalogSnapshot; expiresAt: number } | null = null;
  private refreshing: Promise<DegenCatalogSnapshot> | null = null;

  constructor(options: AvnuDegenCatalogOptions) {
    validateDegenConfig(options.config);
    this.config = Object.freeze({ ...options.config, tags: Object.freeze([...options.config.tags]) });
    this.baseUrl = options.baseUrl;
    this.functions = options.functions ?? { fetchTokens };
    this.now = options.now ?? Date.now;
    const timeout = options.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeout) || timeout <= 0) {
      throw new Error('Backend degen catalog fetch timeout must be a positive integer.');
    }
    this.fetchTimeoutMs = timeout;
  }

  async snapshot(signal?: AbortSignal): Promise<DegenCatalogSnapshot> {
    throwIfAborted(signal);
    const cached = this.cached;
    if (cached && this.now() < cached.expiresAt) return cached.snapshot;
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = null;
    });
    return waitFor(this.refreshing, signal);
  }

  private async refresh(): Promise<DegenCatalogSnapshot> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new DOMException('The avnu token list timed out.', 'TimeoutError'));
    }, this.fetchTimeoutMs);
    let snapshot: DegenCatalogSnapshot;
    let lifetime: number;
    try {
      const raw = await this.fetchLive(controller.signal);
      snapshot = degenSnapshot('live', filterLiveTokens(raw, this.config));
      lifetime = this.config.cacheTtlMs;
    } catch {
      snapshot = CURATED_ONLY_SNAPSHOT;
      lifetime = Math.min(this.config.cacheTtlMs, DEGEN_FAILURE_RETRY_MS);
    } finally {
      clearTimeout(timer);
    }
    this.cached = { snapshot, expiresAt: this.now() + lifetime };
    return snapshot;
  }

  private async fetchLive(signal: AbortSignal): Promise<unknown[]> {
    const tokens: unknown[] = [];
    for (let page = 0; page < AVNU_TOKEN_MAX_PAGES; page += 1) {
      const result: unknown = await this.functions.fetchTokens(
        { page, size: AVNU_TOKEN_PAGE_SIZE, tags: [...this.config.tags] },
        { ...(this.baseUrl ? { baseUrl: this.baseUrl } : {}), abortSignal: signal },
      );
      if (signal.aborted) throw signal.reason;
      const content = pageContent(result);
      tokens.push(...content);
      if (content.length < AVNU_TOKEN_PAGE_SIZE) break;
      const totalPages = ownValue(result as object, 'totalPages');
      if (typeof totalPages === 'number' && Number.isSafeInteger(totalPages) && page + 1 >= totalPages) break;
      const last = content[content.length - 1];
      const lastVolume = last && typeof last === 'object' ? ownValue(last, 'lastDailyVolumeUsd') : undefined;
      // Highest volume first: once a page ends below the floor, no later token passes.
      if (!(typeof lastVolume === 'number' && lastVolume >= this.config.minDailyVolumeUsd)) break;
    }
    return tokens;
  }
}

/** A page's own `content` array, copied by index; anything else is a malformed response. */
function pageContent(result: unknown): unknown[] {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('avnu returned a malformed token page.');
  }
  const content = ownValue(result, 'content');
  if (!Array.isArray(content) || content.length > AVNU_TOKEN_PAGE_SIZE) {
    throw new Error('avnu returned a malformed token page.');
  }
  const owned: unknown[] = [];
  for (let index = 0; index < content.length; index += 1) owned.push(ownValue(content, String(index)));
  return owned;
}

function ownValue(record: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
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
