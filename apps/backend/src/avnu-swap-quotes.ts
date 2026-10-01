import type { SwapQuote, SwapQuotePort } from './types.js';
import { isFelt, sameAddress } from './validation.js';

/**
 * avnu's public, keyless swap API, read by this service for the private swap
 * (D-084), so avnu never sees a player's IP next to their swap stand-in
 * address and the amounts (D-014).
 *
 * Two requests, neither carrying a key, an integrator fee or anything about
 * the player beyond the stand-in address the swap must name:
 *
 * 1. `GET /swap/v3/quotes` for the sell token, buy token, sell amount and
 *    the stand-in as taker, one quote;
 * 2. `POST /swap/v3/build` for that quote, the stand-in as taker, the
 *    policy's slippage, and no approve (the browser builds its own).
 *
 * Both were read without a key on 2026-10-01 (D-084). Nothing here logs,
 * caches or retries: one player action is at most these two requests, under
 * the route's own rate window. The browser re-checks every field; this side
 * checks the shape and the pinned exchange so a malformed answer is a 502,
 * never a quote.
 */

/** avnu's exchange contract, pinned on both sides (`packages/privacy/src/swap.ts`). */
export const AVNU_EXCHANGE = '0x04270219d365d6b017231b52e92b3fb5d7c8378b05e9abc97724537a80e93b0f';
export const AVNU_SWAP_ENTRYPOINT = 'multi_route_swap';
const DEFAULT_BASE_URL = 'https://starknet.api.avnu.fi';
const DEFAULT_TIMEOUT_MS = 5_000;
/**
 * The longest `multi_route_swap` calldata a quote may carry, the browser's own
 * bound (`MAX_SWAP_CALLDATA`, `packages/privacy/src/swap.ts`). It is the
 * swap's, not the relay's `BACKEND_MAX_CALLDATA_ITEMS`: no swap is relayed
 * (D-084). Thin degen pairs split widely: read keylessly on 2026-10-01,
 * 1,000 STRK→DREAMS built 266 felts over 26 routes and 100 LORDS→DREAMS 336
 * over 30, past the relay's usual 256.
 */
export const AVNU_SWAP_MAX_CALLDATA = 512;
/** The most of an avnu answer read: a quote and its build are a few kilobytes. */
export const MAX_RESPONSE_BYTES = 256 * 1024;
const U128_BOUND = 1n << 128n;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface AvnuSwapQuotesOptions {
  chainId: string;
  /** `AVNU_BASE_URL`; avnu's public API when unset. */
  baseUrl?: string;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export class AvnuSwapQuotes implements SwapQuotePort {
  private readonly chainId: string;
  private readonly baseUrl: string;
  private readonly fetcher: FetchLike;
  private readonly timeoutMs: number;

  constructor(options: AvnuSwapQuotesOptions) {
    this.chainId = options.chainId;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.fetcher = options.fetch
      ? ((input, init) => Reflect.apply(options.fetch!, undefined, [input, init]))
      : globalThis.fetch.bind(globalThis);
    const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isSafeInteger(timeout) || timeout <= 0) {
      throw new Error('Backend swap quote timeout must be a positive integer.');
    }
    this.timeoutMs = timeout;
  }

  async quote(input: Parameters<SwapQuotePort['quote']>[0]): Promise<SwapQuote> {
    const query = new URLSearchParams({
      sellTokenAddress: input.sellToken,
      buyTokenAddress: input.buyToken,
      sellAmount: `0x${input.sellAmount.toString(16)}`,
      takerAddress: input.taker,
      size: '1',
    });
    const quotes = await this.read(`${this.baseUrl}/swap/v3/quotes?${query.toString()}`, { method: 'GET' }, input.signal);
    if (!Array.isArray(quotes) || quotes.length === 0) throw new Error('avnu returned no swap quote.');
    const first: unknown = quotes[0];
    const quoteId = own(first, 'quoteId');
    const chainId = own(first, 'chainId');
    const sellToken = own(first, 'sellTokenAddress');
    const buyToken = own(first, 'buyTokenAddress');
    const sellAmount = hexAmount(own(first, 'sellAmount'));
    const buyAmount = hexAmount(own(first, 'buyAmount'));
    if (
      typeof quoteId !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(quoteId)
      || chainId !== this.chainId
      || typeof sellToken !== 'string' || !sameAddress(sellToken, input.sellToken)
      || typeof buyToken !== 'string' || !sameAddress(buyToken, input.buyToken)
      || sellAmount !== input.sellAmount
      || buyAmount === null || buyAmount <= 0n || buyAmount >= U128_BOUND
    ) {
      throw new Error('avnu returned a swap quote that does not answer the request.');
    }
    const built = await this.read(`${this.baseUrl}/swap/v3/build`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        quoteId,
        takerAddress: input.taker,
        slippage: input.slippageBps / 10_000,
        includeApprove: false,
      }),
    }, input.signal);
    const calls = own(built, 'calls');
    if (own(built, 'chainId') !== this.chainId || !Array.isArray(calls) || calls.length !== 1) {
      throw new Error('avnu returned an unexpected swap build.');
    }
    const call: unknown = calls[0];
    const calldata = own(call, 'calldata');
    if (
      !sameAddress(String(own(call, 'contractAddress')), AVNU_EXCHANGE)
      || own(call, 'entrypoint') !== AVNU_SWAP_ENTRYPOINT
      || !Array.isArray(calldata)
      || calldata.length < 13
      || calldata.length > AVNU_SWAP_MAX_CALLDATA
      || calldata.some((felt) => typeof felt !== 'string' || !isFelt(felt))
      || !sameAddress(calldata[8] as string, input.taker)
    ) {
      throw new Error('avnu returned an unexpected swap call.');
    }
    return Object.freeze({
      quoteId,
      chainId,
      sellToken: input.sellToken,
      buyToken: input.buyToken,
      sellAmount: input.sellAmount,
      buyAmount,
      calls: Object.freeze([Object.freeze({
        contractAddress: AVNU_EXCHANGE,
        entrypoint: AVNU_SWAP_ENTRYPOINT,
        calldata: Object.freeze([...(calldata as string[])]),
      })]),
    });
  }

  /** One request on its own timeout, joined to the caller's signal; any non-2xx or oversized body throws. */
  private async read(url: string, init: RequestInit, signal?: AbortSignal): Promise<unknown> {
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new DOMException('avnu timed out.', 'TimeoutError')), this.timeoutMs);
    try {
      const response = await this.fetcher(url, { ...init, signal: controller.signal });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error(`avnu answered ${response.status}.`);
      }
      return JSON.parse(await readBounded(response)) as unknown;
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason ?? error;
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }
}

/**
 * The body as text, streamed, and aborted the moment it passes
 * `MAX_RESPONSE_BYTES`: an oversized answer is never held in full. A
 * declared length past the cap is refused before reading.
 */
async function readBounded(response: Response): Promise<string> {
  const declared = Number(response.headers?.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('avnu answered too much.');
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      // Cancelling the stream stops the transfer; nothing more is read.
      await reader.cancel().catch(() => undefined);
      throw new Error('avnu answered too much.');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

function hexAmount(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/.test(value)) return null;
  return BigInt(value);
}

function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}
