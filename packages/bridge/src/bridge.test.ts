import { describe, expect, it } from 'vitest';
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
const NOW = Date.parse('2026-08-16T12:00:00Z');

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
  depositRequests: SubmitDepositTxRequest[] = [];
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

  async submitDepositTx(value: SubmitDepositTxRequest): Promise<SubmitDepositTxResponse> {
    this.depositRequests.push(value);
    return status('KNOWN_DEPOSIT_TX' as never) as unknown as SubmitDepositTxResponse;
  }
}

describe('BridgeService', () => {
  it('creates only inbound exact-input quotes to Starknet STRK and retains the signed response', async () => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => NOW });

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
    const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => NOW });
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

  it('supports a wallet-signed origin deposit and reports its transaction to 1Click', async () => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => NOW });
    await service.createSignedDeposit({
      source: { ...SOURCE, depositMode: 'signed' },
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });
    await expect(service.reportDepositTransaction('0xorigin-tx')).resolves.toMatchObject({
      leg: 'deposit-detected',
    });
    expect(client.depositRequests).toEqual([{
      txHash: '0xorigin-tx', depositAddress: '0xdeposit',
    }]);
  });

  it('rejects a status response bound to a different signed quote', async () => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => NOW });
    await service.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });
    client.statuses.push({
      ...status('SUCCESS' as never),
      quoteResponse: {
        ...signedQuote,
        correlationId: 'different-quote',
      },
    });
    await expect(service.refresh()).rejects.toThrow(/persisted signed quote/i);
    expect(store.load()?.status.leg).toBe('awaiting-deposit');
  });

  it('rejects a quote that omits its deposit address or signed dispute evidence', async () => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    client.getQuote = async () => ({ ...signedQuote, signature: '', quote: { ...signedQuote.quote, depositAddress: undefined } });
    const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => NOW });
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
    const service = new BridgeService({ client, store, quoteVerifier: () => false, now: () => NOW });
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

  it('stops active polling without marking a still-pending manual deposit as failed', async () => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    let now = NOW;
    const service = new BridgeService({
      client,
      store,
      quoteVerifier: () => true,
      now: () => now,
      sleep: async (ms) => { now += ms; },
    });
    await service.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });
    client.statuses.push(
      status('PENDING_DEPOSIT' as never),
      status('PENDING_DEPOSIT' as never),
      status('PENDING_DEPOSIT' as never),
    );
    const updates: string[] = [];
    await expect(service.watch({
      intervalMs: 10,
      maxActiveMs: 20,
      onUpdate: (value) => updates.push(value.leg),
    })).resolves.toMatchObject({
      leg: 'awaiting-deposit',
      pollingStopped: true,
      message: expect.stringMatching(/resume later/i),
    });
    expect(updates).toEqual(['awaiting-deposit', 'awaiting-deposit', 'awaiting-deposit']);
    expect(store.load()?.status).toMatchObject({ leg: 'awaiting-deposit', pollingStopped: true });
  });

  it('marks an unfunded quote expired only after checking the provider status', async () => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    let now = NOW;
    const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => now });
    await service.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });
    now = Date.parse(request.deadline);
    client.statuses.push(status('PENDING_DEPOSIT' as never));
    await expect(service.refresh()).resolves.toMatchObject({
      leg: 'expired',
      pollingStopped: true,
    });
  });

  it('exports signed resume evidence and safely imports it on another device', async () => {
    const client = new StubClient();
    const first = new BridgeService({
      client,
      store: new MemoryBridgeStore(),
      quoteVerifier: (quote) => quote.signature === 'signed-by-one-click',
      now: () => NOW,
    });
    await first.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });
    const exported = first.exportResumeRecord();

    const secondStore = new MemoryBridgeStore();
    const second = new BridgeService({
      client,
      store: secondStore,
      quoteVerifier: (quote) => quote.signature === 'signed-by-one-click',
      now: () => NOW + 1_000,
    });
    expect(second.importResumeRecord(exported)).toMatchObject({
      amountIn: 1_000_000n,
      status: { leg: 'awaiting-deposit', pollingStopped: true },
    });
    expect(second.resume()?.signedQuote).toEqual(signedQuote);
    expect(() => second.importResumeRecord(
      exported.replace('signed-by-one-click', 'tampered-signature'),
    )).toThrow(/signature/i);
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

  it('drops malformed live token metadata instead of applying the wrong decimal scale', async () => {
    const assets = await loadSourceAssets({
      getTokens: async () => [{
        assetId: 'nep141:broken.omft.near',
        symbol: 'BROKEN',
        decimals: 999,
        blockchain: 'arb',
        price: 1,
        priceUpdatedAt: '2026-08-16T12:00:00Z',
      }] as TokenResponse[],
    });
    expect(assets.some((asset) => asset.assetId === 'nep141:broken.omft.near')).toBe(false);
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
    const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => NOW });
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

  it('does not silently delete old signed dispute evidence', () => {
    const store = new MemoryBridgeStore();
    const old = {
      v: 1 as const,
      createdAt: 1,
      updatedAt: 2,
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
      signedQuote,
      status: { leg: 'settled' as const, message: 'done', pollingStopped: true },
    };
    expect(store.deserialize(store.serialize(old))).toEqual(old);
  });
});
