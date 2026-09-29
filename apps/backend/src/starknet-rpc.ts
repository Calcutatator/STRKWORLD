import type { ChainHead, PoolEventsFilter, PoolEventsPage, PoolRpcPort, PoolStatsRpcPort } from './types.js';
import { isFelt } from './validation.js';

const FEE_SELECTOR = '0x3d323cd692ad43935b81ce230c47bfc57f69656249c5a33fe5223c17dd32ed2';
const PUBLIC_KEY_SELECTOR = '0x1a35984e05126dbecb7c3bb9929e7dd9106d460c59b1633739a5c733a5fb13b';
const PROOF_VALIDITY_SELECTOR = '0x11d6d65b366023adbdaeaa04008285431f4509d78e78cda7067e58fbba35147';
/** `sn_keccak('balance_of')`, pinned in pool-stats.test.ts. */
export const BALANCE_OF_SELECTOR = '0x35a73cd311a05d46deda634c5ee045db92f811b4e74bca4437fcb5302b7af33';
/** Events asked for per page; nodes accept up to about a thousand. */
export const POOL_EVENTS_CHUNK_SIZE = 1_000;
const MAX_CONTINUATION_TOKEN_LENGTH = 512;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const MAX_RPC_ID = Number.MAX_SAFE_INTEGER;

/** The Starknet JSON-RPC spec's `TXN_HASH_NOT_FOUND`: the node has not seen this hash. */
const TXN_HASH_NOT_FOUND = 29;

type RpcEnvelope = { kind: 'result'; result: unknown } | { kind: 'error'; code: number | null };

export interface StarknetRpcOptions {
  rpcUrl: string;
  poolAddress: string;
  feeToken: string;
  noteMaturityBlocks?: number;
  fetcher?: FetchLike;
}

/** Minimal raw JSON-RPC port; it cannot relay arbitrary client calls. */
export class StarknetRpcPoolPort implements PoolRpcPort, PoolStatsRpcPort {
  private id = 0;
  private readonly activeIds = new Set<number>();
  private readonly fetcher: FetchLike;

  constructor(private readonly options: StarknetRpcOptions) {
    this.fetcher = options.fetcher ?? ((input, init) => globalThis.fetch(input, init));
  }

  async getPoolConfig(signal?: AbortSignal) {
    const [feeResult, validityResult] = await Promise.all([
      this.callPool(FEE_SELECTOR, [], signal),
      this.callPool(PROOF_VALIDITY_SELECTOR, [], signal),
    ]);
    // `get_fee_amount` returns a u128 (a single felt) in the live pool's ABI.
    // It was modelled as a u256 (two felts), which failed every pool-config
    // read against mainnet, where the call returns `[0x53444835ec580000]`.
    if (feeResult.length !== 1) {
      throw new Error('Starknet RPC returned an invalid fee amount.');
    }
    const feeAmount = feltToU128(feeResult[0], 'fee amount');
    if (validityResult.length !== 1) {
      throw new Error('Starknet RPC returned an invalid proof-validity window.');
    }
    const proofValidityBlocks = feltToPositiveSafeInteger(
      validityResult[0],
      'proof-validity window',
    );
    return {
      feeAmount,
      feeToken: this.options.feeToken,
      proofValidityBlocks,
      noteMaturityBlocks: this.options.noteMaturityBlocks ?? 10,
    };
  }

  async getPublicKey(address: string, signal?: AbortSignal): Promise<string> {
    const result = await this.callPool(PUBLIC_KEY_SELECTOR, [address], signal);
    const key = result[0];
    if (result.length !== 1 || !key || !isFelt(key)) {
      throw new Error('Starknet RPC returned an invalid public key.');
    }
    return key;
  }

  /**
   * D-072: a transaction the node has not seen yet is an answer, not a
   * failure. A deposit has no receipt for its first seconds, and the node says
   * so with error 29, which resolves `null` here so the receipt route can tell
   * "not yet" apart from a read that failed. Every other error still rejects.
   */
  async getReceipt(transactionHash: string, signal?: AbortSignal): Promise<unknown> {
    const envelope = await this.request('starknet_getTransactionReceipt', [transactionHash], signal);
    if (envelope.kind === 'result') return envelope.result;
    if (envelope.code === TXN_HASH_NOT_FOUND) return null;
    throw new Error('Starknet RPC returned an error.');
  }

  /**
   * D-076: one page of the pool's own events whose first key is `key`. Only
   * each match's block number leaves this port: never its keys (a user's
   * address), its data or its transaction. A page holding anything outside
   * the filter, the range or the page size is refused whole. With
   * `toBlockHash` the range ends at that block by hash, which a node that
   * has not reached it refuses (`BLOCK_NOT_FOUND`) instead of answering
   * short.
   */
  async getPoolEvents(filter: PoolEventsFilter, signal?: AbortSignal): Promise<PoolEventsPage> {
    const { key, fromBlock, toBlock } = filter;
    const token = filter.continuationToken ?? null;
    const toHash = filter.toBlockHash ?? null;
    if (
      !isFelt(key) ||
      !Number.isSafeInteger(fromBlock) || !Number.isSafeInteger(toBlock) ||
      fromBlock < 0 || toBlock < fromBlock ||
      (toHash !== null && (typeof toHash !== 'string' || !isFelt(toHash))) ||
      (token !== null && !isContinuationToken(token))
    ) {
      throw new Error('Pool event filter is invalid.');
    }
    const value = await this.rpc('starknet_getEvents', [{
      from_block: { block_number: fromBlock },
      to_block: toHash !== null ? { block_hash: toHash } : { block_number: toBlock },
      address: this.options.poolAddress,
      keys: [[key]],
      chunk_size: POOL_EVENTS_CHUNK_SIZE,
      ...(token !== null ? { continuation_token: token } : {}),
    }], signal);
    const events = ownData(value, 'events');
    if (!Array.isArray(events) || events.length > POOL_EVENTS_CHUNK_SIZE) {
      throw new Error('Starknet RPC returned an invalid events page.');
    }
    const pool = BigInt(this.options.poolAddress);
    const selector = BigInt(key);
    const blocks: number[] = [];
    for (let index = 0; index < events.length; index += 1) {
      const event = ownData(events, String(index));
      const from = ownData(event, 'from_address');
      const keys = ownData(event, 'keys');
      const first = Array.isArray(keys) ? ownData(keys, '0') : undefined;
      const block = ownData(event, 'block_number');
      if (
        typeof from !== 'string' || !isFelt(from) || BigInt(from) !== pool ||
        typeof first !== 'string' || !isFelt(first) || BigInt(first) !== selector ||
        typeof block !== 'number' || !Number.isSafeInteger(block) || block < fromBlock || block > toBlock
      ) {
        throw new Error('Starknet RPC returned an event outside its filter.');
      }
      blocks.push(block);
    }
    const next = ownData(value, 'continuation_token');
    if (next !== undefined && next !== null && (typeof next !== 'string' || !isContinuationToken(next))) {
      throw new Error('Starknet RPC returned an invalid continuation token.');
    }
    return { blocks, continuationToken: typeof next === 'string' ? next : null };
  }

  /** D-076: `balance_of(pool)` on a token contract: a u256 as two u128 felts. */
  async getPoolBalance(token: string, signal?: AbortSignal): Promise<bigint> {
    if (!isFelt(token) || BigInt(token) === 0n) throw new Error('Pool balance token is invalid.');
    const value = await this.rpc('starknet_call', [{
      contract_address: token,
      entry_point_selector: BALANCE_OF_SELECTOR,
      calldata: [this.options.poolAddress],
    }, 'latest'], signal);
    if (!Array.isArray(value) || value.length !== 2) {
      throw new Error('Starknet RPC returned an invalid balance.');
    }
    const low = feltToU128(value[0] as string | undefined, 'balance');
    const high = feltToU128(value[1] as string | undefined, 'balance');
    return low + (high << 128n);
  }

  /** D-076: the latest block's number and hash, for a scan to end at. */
  async getHead(signal?: AbortSignal): Promise<ChainHead> {
    const value = await this.rpc('starknet_blockHashAndNumber', [], signal);
    const number = ownData(value, 'block_number');
    const hash = ownData(value, 'block_hash');
    if (
      typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0 ||
      typeof hash !== 'string' || !isFelt(hash)
    ) {
      throw new Error('Starknet RPC returned an invalid head.');
    }
    return { number, hash };
  }

  async getBlockNumber(signal?: AbortSignal): Promise<number> {
    const value = await this.rpc('starknet_blockNumber', [], signal);
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new Error('Starknet RPC returned an invalid block number.');
    }
    return value;
  }

  private async callPool(selector: string, calldata: string[], signal?: AbortSignal): Promise<string[]> {
    const value = await this.rpc('starknet_call', [{
      contract_address: this.options.poolAddress,
      entry_point_selector: selector,
      calldata,
    }, 'latest'], signal);
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      throw new Error('Starknet RPC returned an invalid call result.');
    }
    return value as string[];
  }

  private async rpc(method: string, params: unknown[], signal?: AbortSignal): Promise<unknown> {
    const envelope = await this.request(method, params, signal);
    if (envelope.kind === 'error') throw new Error('Starknet RPC returned an error.');
    return envelope.result;
  }

  private async request(method: string, params: unknown[], signal?: AbortSignal): Promise<RpcEnvelope> {
    const id = this.allocateId();
    try {
      const response = await this.fetcher(this.options.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal,
      });
      if (!response.ok) throw new Error('Starknet RPC request failed.');
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new Error('Starknet RPC returned an invalid response.');
      }
      return parseRpcEnvelope(payload, id);
    } finally {
      this.activeIds.delete(id);
    }
  }

  private allocateId(): number {
    const first = this.id >= MAX_RPC_ID ? 1 : this.id + 1;
    let candidate = first;
    for (;;) {
      if (!this.activeIds.has(candidate)) {
        this.activeIds.add(candidate);
        this.id = candidate;
        return candidate;
      }
      candidate = candidate === MAX_RPC_ID ? 1 : candidate + 1;
      if (candidate === first) {
        throw new Error('Starknet RPC request-id space is exhausted.');
      }
    }
  }
}

function parseRpcEnvelope(payload: unknown, requestId: number): RpcEnvelope {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Starknet RPC returned an invalid response.');
  }
  const record = payload as Record<string, unknown>;
  // JSON-RPC permits extension members; this narrow port consumes only the
  // required envelope fields and never reflects provider extensions.
  const jsonrpc = Object.getOwnPropertyDescriptor(record, 'jsonrpc');
  const id = Object.getOwnPropertyDescriptor(record, 'id');
  const result = Object.getOwnPropertyDescriptor(record, 'result');
  const error = Object.getOwnPropertyDescriptor(record, 'error');
  if (
    !jsonrpc || !('value' in jsonrpc) ||
    !id || !('value' in id)
  ) {
    throw new Error('Starknet RPC returned an invalid response.');
  }
  const hasResult = Boolean(result);
  const hasError = Boolean(error);
  if (
    hasResult === hasError ||
    (result !== undefined && !('value' in result)) ||
    (error !== undefined && !('value' in error)) ||
    jsonrpc.value !== '2.0' ||
    id.value !== requestId
  ) {
    throw new Error('Starknet RPC returned an invalid response.');
  }
  return hasError ? { kind: 'error', code: rpcErrorCode(error!.value) } : { kind: 'result', result: result!.value };
}

/**
 * The error's own numeric `code`, and nothing else: its message and data are
 * provider text this port never reads or reflects.
 */
function rpcErrorCode(error: unknown): number | null {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return null;
  const code = Object.getOwnPropertyDescriptor(error, 'code');
  return code && 'value' in code && Number.isSafeInteger(code.value) ? code.value as number : null;
}

/** An own data property, never a getter or an inherited value. */
function ownData(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

/** A node's opaque page cursor: printable, short, and never taken from a request. */
function isContinuationToken(value: string): boolean {
  return value.length > 0 && value.length <= MAX_CONTINUATION_TOKEN_LENGTH && /^[\x21-\x7e]+$/.test(value);
}

function feltToPositiveSafeInteger(value: string | undefined, label: string): number {
  if (!value || !isFelt(value)) throw new Error(`Starknet RPC returned an invalid ${label}.`);
  const parsed = BigInt(value);
  if (parsed <= 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Starknet RPC returned an invalid ${label}.`);
  }
  return Number(parsed);
}

function feltToU128(value: string | undefined, label: string): bigint {
  if (!value || !isFelt(value)) {
    throw new Error(`Starknet RPC returned an invalid ${label}.`);
  }
  const parsed = BigInt(value);
  if (parsed >= (1n << 128n)) {
    throw new Error(`Starknet RPC returned an invalid ${label}.`);
  }
  return parsed;
}
