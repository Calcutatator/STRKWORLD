import type {
  GetExecutionStatusResponse,
  QuoteRequest,
  QuoteResponse,
  SubmitDepositTxRequest,
  SubmitDepositTxResponse,
  TokenResponse,
} from '@defuse-protocol/one-click-sdk-typescript';
import {
  BridgeService,
  LocalBridgeStore,
  MemoryBridgeStore,
  loadSourceAssets,
  type OneClickClient,
} from '@strkworld/bridge';
import type { PublicShieldPlanner } from '@strkworld/privacy';
import type { BridgeRuntime } from './BridgeProvider.js';
import { fixedBridgeAccount } from './BridgeProvider.js';

const DEMO_ACCOUNT = '0x123';
const DEMO_REFUND = '0x1111111111111111111111111111111111111111';
const DEMO_NOW = Date.parse('2026-08-18T12:00:00.000Z');

/** Offline 1Click client: it never creates a real deposit address or network request. */
class DemoOneClickClient implements OneClickClient {
  private signed: QuoteResponse | null;
  private statusCall = 0;

  constructor(savedQuote: QuoteResponse | null = null) {
    // A persisted demo record is still only offline evidence, but the fake
    // provider must know its signed quote after a reload so a resume can run
    // the same status path as the first tab.
    this.signed = savedQuote;
  }
  async getTokens(): Promise<TokenResponse[]> {
    return [{
      assetId: 'nep141:arb-usdc.omft.near',
      blockchain: 'arb',
      symbol: 'USDC',
      decimals: 6,
    } as TokenResponse];
  }
  async getQuote(request: QuoteRequest): Promise<QuoteResponse> {
    const deadline = request.deadline ?? new Date(DEMO_NOW + 1_800_000).toISOString();
    const response = {
      correlationId: 'demo-correlation',
      timestamp: new Date(DEMO_NOW).toISOString(),
      signature: 'demo-signed-evidence',
      quoteRequest: { ...request, deadline },
      quote: {
        depositAddress: DEMO_REFUND,
        amountIn: request.amount,
        amountInFormatted: request.amount,
        amountInUsd: '0',
        minAmountIn: request.amount,
        amountOut: '20000000000000000000',
        amountOutFormatted: '20',
        amountOutUsd: '0',
        minAmountOut: '19000000000000000000',
        deadline,
        timeEstimate: 60,
      },
    } as QuoteResponse;
    this.signed = response;
    this.statusCall = 0;
    return response;
  }
  async getExecutionStatus(): Promise<GetExecutionStatusResponse> {
    if (!this.signed) throw new Error('No demo quote exists.');
    this.statusCall += 1;
    const settled = this.statusCall > 1;
    const response = {
      correlationId: this.signed.correlationId,
      quoteResponse: this.signed,
      status: (settled ? 'SUCCESS' : 'PENDING_DEPOSIT') as never,
      updatedAt: new Date(DEMO_NOW + this.statusCall * 1_000).toISOString(),
      swapDetails: {
        intentHashes: [], nearTxHashes: [], originChainTxHashes: [],
        destinationChainTxHashes: settled ? [{ hash: '0xdemo-settled', explorerUrl: 'https://example.invalid/demo' }] : [],
        ...(settled ? { amountOut: '18500000000000000000' } : {}),
      },
    } as unknown as GetExecutionStatusResponse;
    return response;
  }
  async submitDepositTx(_request: SubmitDepositTxRequest): Promise<SubmitDepositTxResponse> {
    throw new Error('Demo bridge does not submit origin transactions.');
  }
}

export async function createDemoBridgeRuntime(storage?: Storage): Promise<BridgeRuntime> {
  const { FakePublicShieldPlanner } = await import('@strkworld/privacy');
  const store = demoBridgeStore(storage);
  const client = new DemoOneClickClient(store.load()?.signedQuote ?? null);
  const service = new BridgeService({
    client,
    store,
    quoteVerifier: () => true,
    now: () => DEMO_NOW,
  });
  const planner: PublicShieldPlanner = new FakePublicShieldPlanner({
    token: '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d',
    recipient: DEMO_ACCOUNT,
    poolFee: 6n * 10n ** 18n,
    gasEstimate: 1n * 10n ** 18n,
  });
  return Object.freeze({
    service,
    loadSources: () => loadSourceAssets(client),
    readAccount: fixedBridgeAccount(DEMO_ACCOUNT),
    planner,
    now: () => DEMO_NOW,
    account: DEMO_ACCOUNT,
    available: () => true,
    load: () => {},
  });
}

/**
 * The demo is the only browser runtime currently available. Keep its signed
 * quote across reloads when Web Storage exists, while preserving a memory
 * fallback for SSR, tests, and privacy-mode browsers that reject storage.
 */
function demoBridgeStore(storage?: Storage): LocalBridgeStore | MemoryBridgeStore {
  try {
    const candidate = storage ?? (typeof globalThis.localStorage !== 'undefined' ? globalThis.localStorage : undefined);
    if (candidate) {
      candidate.getItem('__strkworld_bridge_storage_probe__');
      return new LocalBridgeStore(candidate);
    }
  } catch {
    // Storage can be unavailable or throw in a restricted browser context.
  }
  return new MemoryBridgeStore();
}
