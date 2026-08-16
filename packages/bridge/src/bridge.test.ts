import { describe, expect, it } from 'vitest';
import type {
  GetExecutionStatusResponse,
  QuoteRequest,
  QuoteResponse,
  TokenResponse,
} from '@defuse-protocol/one-click-sdk-typescript';
import {
  BridgeService,
  MemoryBridgeStore,
  STRK_ON_STARKNET_ASSET_ID,
  loadSourceAssets,
  validateSourceAddress,
  type OneClickClient,
  type SourceAsset,
} from './index.js';

const SOURCE = {
  assetId: 'nep141:arb-usdc.omft.near',
  symbol: 'USDC',
  chainName: 'arbitrum',
  decimals: 6,
  depositMode: 'manual' as const,
} as const satisfies SourceAsset;

const request = {
  dry: false,
  swapType: 'EXACT_INPUT',
  slippageTolerance: 100,
  originAsset: SOURCE.assetId,
  depositType: 'ORIGIN_CHAIN',
  destinationAsset: STRK_ON_STARKNET_ASSET_ID,
  amount: '1000000',
  refundTo: '0x1111111111111111111111111111111111111111',
  refundType: 'ORIGIN_CHAIN',
  recipient: '0x123',
  recipientType: 'DESTINATION_CHAIN',
  deadline: '2026-08-16T12:30:00.000Z',
} as QuoteRequest;

const signedQuote = {
  correlationId: 'corr-1',
  timestamp: '2026-08-16T12:00:00.000Z',
  signature: 'signed-by-one-click',
  quoteRequest: request,
  quote: {
    depositAddress: '0xdeposit',
    amountIn: '1000000',
    amountInFormatted: '1',
    amountInUsd: '1',
    minAmountIn: '1000000',
    amountOut: '2000000000000000000',
    amountOutFormatted: '2',
    amountOutUsd: '1',
    minAmountOut: '1900000000000000000',
    deadline: request.deadline,
    timeEstimate: 60,
  },
} satisfies QuoteResponse;

function status(
  value: GetExecutionStatusResponse['status'],
  overrides: Partial<GetExecutionStatusResponse['swapDetails']> = {},
): GetExecutionStatusResponse {
  return {
    correlationId: 'status-1',
    quoteResponse: signedQuote,
    status: value,
    updatedAt: '2026-08-16T12:01:00.000Z',
    swapDetails: {
      intentHashes: [],
      nearTxHashes: [],
      originChainTxHashes: [],
      destinationChainTxHashes: [],
      ...overrides,
    },
  };
}

class StubClient implements OneClickClient {
  quoteRequests: QuoteRequest[] = [];
  statuses: GetExecutionStatusResponse[] = [];

  async getTokens(): Promise<TokenResponse[]> {
    return [];
  }

  async getQuote(value: QuoteRequest): Promise<QuoteResponse> {
    this.quoteRequests.push(value);
    return signedQuote;
  }

  async getExecutionStatus(): Promise<GetExecutionStatusResponse> {
    const next = this.statuses.shift();
    if (!next) throw new Error('no status queued');
    return next;
  }
}

describe('BridgeService', () => {
  it('creates only inbound exact-input quotes to Starknet STRK and retains the signed response', async () => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => Date.parse('2026-08-16T12:00:00Z') });

    const record = await service.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });

    expect(client.quoteRequests[0]).toMatchObject({
      dry: false,
      swapType: 'EXACT_INPUT',
      originAsset: SOURCE.assetId,
      destinationAsset: STRK_ON_STARKNET_ASSET_ID,
      amount: '1000000',
      recipient: '0x123',
      slippageTolerance: 100,
    });
    expect(record.status.leg).toBe('awaiting-deposit');
    expect(record.signedQuote).toEqual(signedQuote);
    expect(store.load()?.signedQuote.signature).toBe('signed-by-one-click');
  });

  it('maps solver states without exposing a raw status and keeps timeout distinct from failure', async () => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => Date.parse('2026-08-16T12:00:00Z') });
    await service.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });

    client.statuses.push(status('PROCESSING' as never));
    await expect(service.refresh()).resolves.toMatchObject({
      leg: 'solver-settling',
      pollingStopped: false,
    });

    client.statuses.push(
      status('SUCCESS' as never, {
        amountOut: '1980000000000000000',
        destinationChainTxHashes: [{ hash: '0xsettled', explorerUrl: 'https://example/tx' }],
      }),
    );
    await expect(service.refresh()).resolves.toMatchObject({
      leg: 'settled',
      strkReceived: 1_980_000_000_000_000_000n,
      settlementTxHash: '0xsettled',
    });
  });

  it('rejects a quote that omits its deposit address or signed dispute evidence', async () => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    client.getQuote = async () => ({ ...signedQuote, signature: '', quote: { ...signedQuote.quote, depositAddress: undefined } });
    const service = new BridgeService({ client, store, quoteVerifier: () => true });
    await expect(
      service.createManualDeposit({
        source: SOURCE,
        amountIn: 1_000_000n,
        starknetRecipient: '0x123',
        refundAddress: request.refundTo,
      }),
    ).rejects.toThrow(/signed quote|deposit address/i);
    expect(store.load()).toBeNull();
  });

  it('fails closed when the SDK cannot verify the signed quote', async () => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    const service = new BridgeService({ client, store, quoteVerifier: () => false });
    await expect(
      service.createManualDeposit({
        source: SOURCE,
        amountIn: 1_000_000n,
        starknetRecipient: '0x123',
        refundAddress: request.refundTo,
      }),
    ).rejects.toThrow(/signature/i);
    expect(store.load()).toBeNull();
  });
});

describe('source registry and refund validation', () => {
  it('merges live metadata over curated fallbacks without making live availability up', async () => {
    const live = [
      {
        assetId: SOURCE.assetId,
        symbol: 'USDC.e',
        decimals: 6,
        blockchain: 'arb',
        price: 1,
        priceUpdatedAt: '2026-08-16T12:00:00Z',
      },
    ] as TokenResponse[];
    const assets = await loadSourceAssets({ getTokens: async () => live });
    expect(assets.find((asset) => asset.assetId === SOURCE.assetId)).toMatchObject({
      symbol: 'USDC.e',
      chainName: 'arbitrum',
      availability: 'live',
    });
    expect(assets.some((asset) => asset.availability === 'fallback')).toBe(true);
  });

  it('uses chain-specific shape checks for irreversible refund addresses', () => {
    expect(validateSourceAddress('arbitrum', request.refundTo)).toEqual({ ok: true });
    expect(validateSourceAddress('arbitrum', '0x123').ok).toBe(false);
    expect(validateSourceAddress('stellar', `G${'A'.repeat(55)}`)).toEqual({ ok: true });
  });
});

describe('bridge persistence', () => {
  it('round-trips bigint fields while retaining the complete signed quote', async () => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    const service = new BridgeService({ client, store, quoteVerifier: () => true });
    const created = await service.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });
    const encoded = store.serialize(created);
    const decoded = store.deserialize(encoded);
    expect(decoded?.amountIn).toBe(1_000_000n);
    expect(decoded?.signedQuote).toEqual(signedQuote);
  });
});
