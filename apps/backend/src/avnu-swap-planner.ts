import {
  calculateMinReceivedAmount,
  getQuotes,
  quoteToCalls,
  toPaymasterCall,
  type Quote,
} from '@avnu/avnu-sdk';
import type { SwapPlan, SwapPlannerPort } from './types.js';
import { sameAddress } from './validation.js';

interface AvnuSwapFunctions {
  getQuotes: typeof getQuotes;
  quoteToCalls: typeof quoteToCalls;
  toPaymasterCall: typeof toPaymasterCall;
}

export interface AvnuSwapPlannerOptions {
  chainId: string;
  baseUrl?: string;
  functions?: AvnuSwapFunctions;
  now?: () => number;
}

/** Server-side quote selection and private-executor plan construction. */
export class AvnuSwapPlanner implements SwapPlannerPort {
  private readonly functions: AvnuSwapFunctions;
  private readonly now: () => number;

  constructor(private readonly options: AvnuSwapPlannerOptions) {
    this.functions = options.functions ?? { getQuotes, quoteToCalls, toPaymasterCall };
    this.now = options.now ?? Date.now;
  }

  async prepare(input: Parameters<SwapPlannerPort['prepare']>[0]): Promise<SwapPlan> {
    const quotes = await this.functions.getQuotes({
      sellTokenAddress: input.sellToken,
      buyTokenAddress: input.buyToken,
      sellAmount: input.sellAmount,
    }, avnuOptions(this.options.baseUrl, input.signal));
    throwIfAborted(input.signal);
    const quote = quotes.find((candidate) => quoteMatches(candidate, input));
    if (!quote) throw new Error('AVNU returned no quote satisfying the minimum output.');
    const expiry = normalizeExpiry(quote.expiry);
    if (expiry === null || expiry <= this.now()) throw new Error('AVNU quote is expired or has no expiry.');
    if (quote.chainId !== this.options.chainId) throw new Error('AVNU quote chain does not match mainnet.');
    const built = await this.functions.quoteToCalls({
      quoteId: quote.quoteId,
      slippage: input.slippageBps / 10_000,
      private: true,
    }, avnuOptions(this.options.baseUrl, input.signal));
    throwIfAborted(input.signal);
    if (!built.executorAddress || built.chainId !== this.options.chainId) {
      throw new Error('AVNU did not return a mainnet private executor.');
    }
    return {
      quoteId: quote.quoteId,
      buyAmount: quote.buyAmount,
      expiresAt: expiry,
      chainId: quote.chainId,
      executorAddress: built.executorAddress,
      executorCalls: built.calls.map((call) => {
        const rpcCall = this.functions.toPaymasterCall(call);
        return {
          contractAddress: call.contractAddress,
          entrypoint: call.entrypoint,
          selector: rpcCall.selector,
          calldata: rpcCall.calldata,
        };
      }),
    };
  }
}

function avnuOptions(baseUrl: string | undefined, signal: AbortSignal | undefined) {
  return baseUrl || signal ? { baseUrl, abortSignal: signal } : undefined;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function quoteMatches(
  quote: Quote,
  input: Parameters<SwapPlannerPort['prepare']>[0],
): boolean {
  return sameAddress(quote.sellTokenAddress, input.sellToken) &&
    sameAddress(quote.buyTokenAddress, input.buyToken) &&
    quote.sellAmount === input.sellAmount &&
    calculateMinReceivedAmount(quote.buyAmount, input.slippageBps / 10_000) >= input.minAmountOut;
}

function normalizeExpiry(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return value < 1_000_000_000_000 ? value * 1_000 : value;
}
