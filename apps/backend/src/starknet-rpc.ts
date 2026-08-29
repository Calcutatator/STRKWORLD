import type { PoolRpcPort } from './types.js';
import { isFelt } from './validation.js';

const FEE_SELECTOR = '0x3d323cd692ad43935b81ce230c47bfc57f69656249c5a33fe5223c17dd32ed2';
const PUBLIC_KEY_SELECTOR = '0x1a35984e05126dbecb7c3bb9929e7dd9106d460c59b1633739a5c733a5fb13b';
const PROOF_VALIDITY_SELECTOR = '0x11d6d65b366023adbdaeaa04008285431f4509d78e78cda7067e58fbba35147';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface StarknetRpcOptions {
  rpcUrl: string;
  poolAddress: string;
  feeToken: string;
  noteMaturityBlocks?: number;
  fetcher?: FetchLike;
}

/** Minimal raw JSON-RPC port; it cannot relay arbitrary client calls. */
export class StarknetRpcPoolPort implements PoolRpcPort {
  private id = 0;
  private readonly fetcher: FetchLike;

  constructor(private readonly options: StarknetRpcOptions) {
    this.fetcher = options.fetcher ?? fetch;
  }

  async getPoolConfig(signal?: AbortSignal) {
    const [feeResult, validityResult] = await Promise.all([
      this.callPool(FEE_SELECTOR, [], signal),
      this.callPool(PROOF_VALIDITY_SELECTOR, [], signal),
    ]);
    if (feeResult.length !== 2) {
      throw new Error('Starknet RPC returned an invalid fee amount.');
    }
    const low = feltToU128(feeResult[0], 'fee amount low word');
    const high = feltToU128(feeResult[1], 'fee amount high word');
    if (validityResult.length !== 1) {
      throw new Error('Starknet RPC returned an invalid proof-validity window.');
    }
    const proofValidityBlocks = feltToPositiveSafeInteger(
      validityResult[0],
      'proof-validity window',
    );
    return {
      feeAmount: low + (high << 128n),
      feeToken: this.options.feeToken,
      proofValidityBlocks,
      noteMaturityBlocks: this.options.noteMaturityBlocks ?? 10,
    };
  }

  async getPublicKey(address: string, signal?: AbortSignal): Promise<string> {
    const result = await this.callPool(PUBLIC_KEY_SELECTOR, [address], signal);
    return result[0] ?? '0x0';
  }

  async getReceipt(transactionHash: string, signal?: AbortSignal): Promise<unknown> {
    return this.rpc('starknet_getTransactionReceipt', [transactionHash], signal);
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
    const response = await this.fetcher(this.options.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
      signal,
    });
    if (!response.ok) throw new Error('Starknet RPC request failed.');
    const payload = await response.json() as { result?: unknown; error?: unknown };
    if (payload.error || !('result' in payload)) throw new Error('Starknet RPC returned an error.');
    return payload.result;
  }
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
