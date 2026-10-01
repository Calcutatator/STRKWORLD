import { hash } from 'starknet';
import { PrivacyError, type Address } from '../types.js';
import type { PublicBalanceReader } from './types.js';

/**
 * The connected account's public ERC-20 balance, over the wallet's own RPC
 * (D-094): what a shield draws on. One `starknet_call` of the token's
 * `balance_of(account)`, the same node the wallet account and Pragma's
 * oracle check already use (D-084), never STRKWORLD's backend or the lobby,
 * so no STRKWORLD server learns the address. Nothing is cached and nothing is
 * logged; no wallet is asked, so reading it raises no prompt.
 */

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const BALANCE_OF = hash.getSelectorFromName('balance_of');
const TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 4 * 1024;
const U128 = 1n << 128n;
const FELT = /^0x[0-9a-fA-F]{1,64}$/;

export class RpcPublicBalanceReader implements PublicBalanceReader {
  private readonly rpcUrl: string;
  private readonly fetcher: FetchLike;

  constructor(rpcUrl: string, options: { fetch?: FetchLike } = {}) {
    if (typeof rpcUrl !== 'string' || !/^https:\/\//.test(rpcUrl)) {
      throw new PrivacyError('unknown', 'The public balance RPC must be an https URL.');
    }
    this.rpcUrl = rpcUrl;
    this.fetcher = options.fetch
      ? ((input, init) => Reflect.apply(options.fetch!, undefined, [input, init]))
      : globalThis.fetch.bind(globalThis);
  }

  async read(token: Address, account: Address, signal?: AbortSignal): Promise<bigint> {
    if (typeof token !== 'string' || !FELT.test(token) || typeof account !== 'string' || !FELT.test(account)) {
      throw new PrivacyError('unknown', 'The public balance read needs a token and an account address.');
    }
    const answer = await this.post({
      jsonrpc: '2.0',
      id: 1,
      method: 'starknet_call',
      params: [{ contract_address: token, entry_point_selector: BALANCE_OF, calldata: [account] }, 'latest'],
    }, signal);
    const result = own(answer, 'result');
    // A u256 answers as (low, high), each below 2^128.
    if (!Array.isArray(result) || result.length !== 2 || result.some((felt) => typeof felt !== 'string' || !FELT.test(felt))) {
      throw new PrivacyError('unreachable', 'The wallet balance could not be read.');
    }
    const [low, high] = (result as string[]).map((felt) => BigInt(felt));
    if (low! >= U128 || high! >= U128) {
      throw new PrivacyError('unreachable', 'The wallet balance could not be read.');
    }
    return low! + high! * U128;
  }

  private async post(body: unknown, signal?: AbortSignal): Promise<unknown> {
    if (signal?.aborted) throw new PrivacyError('user-rejected', 'Operation cancelled.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await this.fetcher(this.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error('balance RPC failed');
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES) throw new Error('balance RPC answered too much');
      return JSON.parse(text) as unknown;
    } catch (error) {
      if (signal?.aborted) throw new PrivacyError('user-rejected', 'Operation cancelled.');
      // The error carries no address: the cause is the fetch's own, and the
      // request body is never attached.
      throw new PrivacyError('unreachable', 'The wallet balance could not be read.', error);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
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
