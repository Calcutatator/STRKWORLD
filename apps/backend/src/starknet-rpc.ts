import type { PoolRpcPort } from './types.js';

const FEE_SELECTOR = '0x3d323cd692ad43935b81ce230c47bfc57f69656249c5a33fe5223c17dd32ed2';
const PUBLIC_KEY_SELECTOR = '0x1a35984e05126dbecb7c3bb9929e7dd9106d460c59b1633739a5c733a5fb13b';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface StarknetRpcOptions {
  rpcUrl: string;
  poolAddress: string;
  feeToken: string;
  proofValidityBlocks?: number;
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

  async getPoolConfig() {
    const result = await this.callPool(FEE_SELECTOR, []);
    const low = BigInt(result[0] ?? '0x0');
    const high = BigInt(result[1] ?? '0x0');
    return {
      feeAmount: low + (high << 128n),
      feeToken: this.options.feeToken,
      proofValidityBlocks: this.options.proofValidityBlocks ?? 450,
      noteMaturityBlocks: this.options.noteMaturityBlocks ?? 10,
    };
  }

  async getPublicKey(address: string): Promise<string> {
    const result = await this.callPool(PUBLIC_KEY_SELECTOR, [address]);
    return result[0] ?? '0x0';
  }

  async getReceipt(transactionHash: string): Promise<unknown> {
    return this.rpc('starknet_getTransactionReceipt', [transactionHash]);
  }

  async getBlockNumber(): Promise<number> {
    const value = await this.rpc('starknet_blockNumber', []);
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
      throw new Error('Starknet RPC returned an invalid block number.');
    }
    return value;
  }

  private async callPool(selector: string, calldata: string[]): Promise<string[]> {
    const value = await this.rpc('starknet_call', [{
      contract_address: this.options.poolAddress,
      entry_point_selector: selector,
      calldata,
    }, 'latest']);
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      throw new Error('Starknet RPC returned an invalid call result.');
    }
    return value as string[];
  }

  private async rpc(method: string, params: unknown[]): Promise<unknown> {
    const response = await this.fetcher(this.options.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
    });
    if (!response.ok) throw new Error('Starknet RPC request failed.');
    const payload = await response.json() as { result?: unknown; error?: unknown };
    if (payload.error || !('result' in payload)) throw new Error('Starknet RPC returned an error.');
    return payload.result;
  }
}
