import { hash, shortString } from 'starknet';
import { PRAGMA_ORACLE, PRICE_FEEDS, type PragmaPrice } from '../swap-prices.js';
import { PrivacyError } from '../types.js';
import type { SwapPriceReader } from './types.js';

/**
 * Pragma's spot prices over the wallet's own RPC (D-084): the swap's price
 * reference, independent of STRKWORLD's backend and of avnu. One JSON-RPC
 * batch of `get_data_median(SpotEntry(pair))` for every pinned feed, always
 * the same set, so the node learns only that someone opened the Exchange: no
 * pair, amount or address. A node that refuses batches is asked one call at a
 * time. Answers are cached for 30 s and refreshed single-flight.
 */

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const GET_DATA_MEDIAN = hash.getSelectorFromName('get_data_median');
const CACHE_MS = 30_000;
const TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

export class PragmaPriceReader implements SwapPriceReader {
  private readonly rpcUrl: string;
  private readonly fetcher: FetchLike;
  private readonly now: () => number;
  private cached: { readonly at: number; readonly prices: readonly PragmaPrice[] } | null = null;
  private pending: Promise<readonly PragmaPrice[]> | null = null;

  constructor(rpcUrl: string, options: { fetch?: FetchLike; now?: () => number } = {}) {
    if (typeof rpcUrl !== 'string' || !/^https:\/\//.test(rpcUrl)) {
      throw new PrivacyError('unknown', 'The price reference RPC must be an https URL.');
    }
    this.rpcUrl = rpcUrl;
    this.fetcher = options.fetch
      ? ((input, init) => Reflect.apply(options.fetch!, undefined, [input, init]))
      : globalThis.fetch.bind(globalThis);
    this.now = options.now ?? Date.now;
  }

  async read(signal?: AbortSignal): Promise<readonly PragmaPrice[]> {
    const cached = this.cached;
    if (cached && this.now() - cached.at < CACHE_MS) return cached.prices;
    this.pending ??= this.refresh().finally(() => { this.pending = null; });
    const pending = this.pending;
    if (!signal) return pending;
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new PrivacyError('user-rejected', 'Operation cancelled.')); return; }
      const onAbort = () => reject(new PrivacyError('user-rejected', 'Operation cancelled.'));
      signal.addEventListener('abort', onAbort, { once: true });
      pending.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  private async refresh(): Promise<readonly PragmaPrice[]> {
    const requests = PRICE_FEEDS.map((feed, index) => ({
      jsonrpc: '2.0',
      id: index + 1,
      method: 'starknet_call',
      params: [{
        contract_address: PRAGMA_ORACLE,
        entry_point_selector: GET_DATA_MEDIAN,
        calldata: ['0x0', shortString.encodeShortString(feed.pair)],
      }, 'latest'],
    }));
    let answers: unknown = await this.post(requests);
    if (!Array.isArray(answers)) {
      // A node that refuses batches: one call at a time.
      answers = await Promise.all(requests.map((request) => this.post(request)));
    }
    const prices: PragmaPrice[] = [];
    PRICE_FEEDS.forEach((feed, index) => {
      const answer = (answers as unknown[]).find((entry) => own(entry, 'id') === index + 1);
      const result = own(answer, 'result');
      if (!Array.isArray(result) || result.length < 4 || result.some((felt) => typeof felt !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(felt))) return;
      const [price, decimals, updatedAt, sources] = (result as string[]).slice(0, 4).map((felt) => BigInt(felt));
      if (decimals! > 36n || updatedAt! > BigInt(Number.MAX_SAFE_INTEGER) || sources! > 1_000n) return;
      prices.push(Object.freeze({
        pair: feed.pair,
        price: price!,
        decimals: Number(decimals),
        updatedAt: Number(updatedAt),
        sources: Number(sources),
      }));
    });
    const frozen = Object.freeze(prices);
    this.cached = { at: this.now(), prices: frozen };
    return frozen;
  }

  private async post(body: unknown): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await this.fetcher(this.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('price RPC failed');
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) throw new Error('price RPC answered too much');
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new PrivacyError('unreachable', 'The oracle price could not be read.', error);
    } finally {
      clearTimeout(timer);
    }
  }
}

function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}
