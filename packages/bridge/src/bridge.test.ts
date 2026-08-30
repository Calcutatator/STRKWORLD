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
  LocalBridgeStore,
  MAX_RESUME_RECORD_BYTES,
  MemoryBridgeStore,
  STRK_ON_STARKNET_ASSET_ID,
  loadSourceAssets,
  deserializeBridgeRecord,
  serializeBridgeRecord,
  validateSourceAddress,
  validateStarknetAddress,
  type CreateDepositInput,
  type OneClickClient,
  type BridgeStatus,
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

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

describe('BridgeService', () => {
  it('rejects an amount above the uint256 bound before requesting a quote', async () => {
    const client = new StubClient();
    const service = new BridgeService({
      client,
      store: new MemoryBridgeStore(),
      quoteVerifier: () => true,
      now: () => NOW,
    });

    await expect(service.createManualDeposit({
      source: SOURCE,
      amountIn: 1n << 256n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    })).rejects.toThrow('Bridge amount must be a positive uint256.');
    expect(client.quoteRequests).toHaveLength(0);
  });

  it('does not overwrite an imported record while its quote is pending', async () => {
    const quote = deferred<QuoteResponse>();
    const client = new StubClient();
    client.getQuote = async () => quote.promise;
    const service = new BridgeService({
      client,
      store: new MemoryBridgeStore(),
      quoteVerifier: () => true,
      now: () => NOW,
    });
    const evidenceSource = new BridgeService({
      client: new StubClient(),
      store: new MemoryBridgeStore(),
      quoteVerifier: () => true,
      now: () => NOW,
    });
    await evidenceSource.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });
    const importedEvidence = evidenceSource.exportResumeRecord();

    const creating = service.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });
    await Promise.resolve();
    service.importResumeRecord(importedEvidence);
    const importedExport = service.exportResumeRecord();
    quote.resolve(signedQuote);

    await expect(creating).rejects.toThrow(
      'An existing bridge deposit is available. Discard it before creating a new deposit.',
    );
    expect(service.exportResumeRecord()).toBe(importedExport);
  });

  it('allows only one concurrent manual or signed create to retain a record', async () => {
    const firstQuote = deferred<QuoteResponse>();
    const secondQuote = deferred<QuoteResponse>();
    const client = new StubClient();
    let quoteCall = 0;
    client.getQuote = async () => {
      quoteCall += 1;
      const next = quoteCall === 1 ? firstQuote : secondQuote;
      return next.promise;
    };
    const service = new BridgeService({
      client,
      store: new MemoryBridgeStore(),
      quoteVerifier: () => true,
      now: () => NOW,
    });

    const manual = service.createManualDeposit({
      source: { ...SOURCE, depositMode: 'manual' },
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });
    const signed = service.createSignedDeposit({
      source: { ...SOURCE, depositMode: 'signed' },
      amountIn: 2_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });
    await Promise.resolve();
    firstQuote.resolve(signedQuote);
    await expect(manual).resolves.toMatchObject({ amountIn: 1_000_000n });
    secondQuote.resolve({
      ...signedQuote,
      quoteRequest: {
        ...signedQuote.quoteRequest,
        amount: '2000000',
      },
      quote: {
        ...signedQuote.quote,
        amountIn: '2000000',
      },
    });

    await expect(signed).rejects.toThrow(
      'An existing bridge deposit is available. Discard it before creating a new deposit.',
    );
    expect(service.resume()).toMatchObject({
      amountIn: 1_000_000n,
      source: { depositMode: 'manual' },
    });
  });

  it('retains the source metadata captured when quote creation began', async () => {
    const quote = deferred<QuoteResponse>();
    const client = new StubClient();
    client.getQuote = async () => quote.promise;
    const service = new BridgeService({
      client,
      store: new MemoryBridgeStore(),
      quoteVerifier: () => true,
      now: () => NOW,
    });
    const input: CreateDepositInput = {
      source: { ...SOURCE },
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    };

    const creating = service.createManualDeposit(input);
    await Promise.resolve();
    input.source.symbol = 'MUTATED';
    input.source.decimals = 18;
    quote.resolve(signedQuote);

    await expect(creating).resolves.toMatchObject({
      source: { symbol: 'USDC', decimals: 6 },
    });
  });

  it('preserves an existing resumable deposit until it is explicitly discarded', async () => {
    for (const [existingMode, replacementMode] of [
      ['manual', 'signed'],
      ['signed', 'manual'],
    ] as const) {
      const client = new StubClient();
      const store = new MemoryBridgeStore();
      const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => NOW });
      const existingSource = { ...SOURCE, depositMode: existingMode };
      const replacementSource = { ...SOURCE, depositMode: replacementMode };
      const createExisting = existingMode === 'manual'
        ? service.createManualDeposit.bind(service)
        : service.createSignedDeposit.bind(service);
      const createReplacement = replacementMode === 'manual'
        ? service.createManualDeposit.bind(service)
        : service.createSignedDeposit.bind(service);

      const original = await createExisting({
        source: existingSource,
        amountIn: 1_000_000n,
        starknetRecipient: '0x123',
        refundAddress: request.refundTo,
      });
      const exportedBeforeReplacement = service.exportResumeRecord();

      await expect(createReplacement({
        source: replacementSource,
        amountIn: 1_000_000n,
        starknetRecipient: '0x123',
        refundAddress: request.refundTo,
      })).rejects.toThrow(/existing bridge deposit|discard/i);
      expect(service.resume()).toEqual(original);
      expect(service.exportResumeRecord()).toBe(exportedBeforeReplacement);

      service.discard();
      await expect(createReplacement({
        source: replacementSource,
        amountIn: 1_000_000n,
        starknetRecipient: '0x123',
        refundAddress: request.refundTo,
      })).resolves.toMatchObject({
        amountIn: 1_000_000n,
        source: { depositMode: replacementMode },
        starknetRecipient: '0x123',
      });
    }
  });

  it('does not resurrect discarded evidence when an older refresh settles late', async () => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => NOW });
    await service.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });
    let releaseStatus!: (value: GetExecutionStatusResponse) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    client.getExecutionStatus = async () => {
      markStarted();
      return new Promise<GetExecutionStatusResponse>((resolve) => { releaseStatus = resolve; });
    };

    const refreshing = service.refresh();
    await started;
    service.discard();
    releaseStatus(status('PROCESSING' as never));

    await expect(refreshing).resolves.toMatchObject({ leg: 'solver-settling' });
    expect(service.resume()).toBeNull();
  });

  it('does not let an older refresh overwrite replacement evidence', async () => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => NOW });
    await service.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });
    let releaseStatus!: (value: GetExecutionStatusResponse) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    client.getExecutionStatus = async () => {
      markStarted();
      return new Promise<GetExecutionStatusResponse>((resolve) => { releaseStatus = resolve; });
    };

    const refreshing = service.refresh();
    await started;
    service.discard();
    client.getQuote = async (value) => ({
      ...signedQuote,
      correlationId: 'corr-2',
      signature: 'replacement-signed-by-one-click',
      quoteRequest: value,
      quote: {
        ...signedQuote.quote,
        depositAddress: '0xreplacement-deposit',
        deadline: value.deadline,
      },
    });
    const replacement = await service.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });
    const replacementExport = service.exportResumeRecord();
    releaseStatus(status('PROCESSING' as never));

    await expect(refreshing).resolves.toMatchObject({ leg: 'solver-settling' });
    expect(service.resume()).toEqual(replacement);
    expect(service.exportResumeRecord()).toBe(replacementExport);
  });

  it('does not let an older watch timeout graft its evidence onto a replacement deposit', async () => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    let now = NOW;
    const service = new BridgeService({
      client,
      store,
      quoteVerifier: () => true,
      now: () => now,
      sleep: async () => { throw new Error('watch should stop before sleeping'); },
    });
    const original = await service.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });
    let releaseStatus!: (value: GetExecutionStatusResponse) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    client.getExecutionStatus = async () => {
      markStarted();
      return new Promise<GetExecutionStatusResponse>((resolve) => { releaseStatus = resolve; });
    };

    const watching = service.watch({ intervalMs: 10, maxActiveMs: 1 });
    await started;
    service.discard();
    now += 1;
    client.getQuote = async (value) => ({
      ...signedQuote,
      correlationId: 'corr-2',
      signature: 'replacement-signed-by-one-click',
      quoteRequest: value,
      quote: {
        ...signedQuote.quote,
        depositAddress: '0xreplacement-deposit',
        deadline: value.deadline,
      },
    });
    const replacement = await service.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });
    const replacementExport = service.exportResumeRecord();
    releaseStatus({
      ...status('PROCESSING' as never, {
        originChainTxHashes: [{ hash: '0xold-deposit', explorerUrl: 'https://example/tx' }],
      }),
      quoteResponse: original.signedQuote,
    });

    await expect(watching).resolves.toMatchObject({
      leg: 'solver-settling',
      depositTxHash: '0xold-deposit',
      pollingStopped: true,
    });
    expect(service.resume()).toEqual(replacement);
    expect(service.exportResumeRecord()).toBe(replacementExport);
  });

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

  it('accepts a settled amount when 1Click omits the optional destination hash', async () => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => NOW });
    await service.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });

    client.statuses.push(status('SUCCESS' as never, {
      amountOut: '1980000000000000000',
      destinationChainTxHashes: [],
    }));
    await expect(service.refresh()).resolves.toMatchObject({
      leg: 'settled',
      strkReceived: 1_980_000_000_000_000_000n,
      settlementTxHash: undefined,
    });
  });

  it('rejects a signed quote output above the uint256 upper bound', async () => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    client.getQuote = async () => ({
      ...signedQuote,
      quote: {
        ...signedQuote.quote,
        amountOut: (1n << 256n).toString(),
        minAmountOut: (1n << 256n).toString(),
      },
    });
    const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => NOW });

    await expect(service.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    })).rejects.toThrow('1Click returned invalid executable quote amounts.');
    expect(store.load()).toBeNull();
  });

  it.each(['amountOut', 'minAmountOut'] as const)('rejects a coercible signed quote %s before persistence', async (field) => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    client.getQuote = async () => ({
      ...signedQuote,
      quote: {
        ...signedQuote.quote,
        [field]: { length: 19, toString: () => '2000000000000000000' },
      },
    } as unknown as QuoteResponse);
    const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => NOW });

    await expect(service.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    })).rejects.toThrow('1Click returned invalid executable quote amounts.');
    expect(store.load()).toBeNull();
  });

  it.each([
    ['zero', '0'],
    ['negative', '-1'],
    ['fractional', '1.5'],
    ['exponential', '1e3'],
    ['oversized', '1'.repeat(79)],
  ])('rejects a SUCCESS status with a %s amountOut before settling', async (_label, amountOut) => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => NOW });
    await service.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });

    client.statuses.push(status('SUCCESS' as never, {
      amountOut,
      destinationChainTxHashes: [{ hash: '0xsettled', explorerUrl: 'https://example/tx' }],
    }));
    await expect(service.refresh()).rejects.toThrow('1Click returned invalid execution status data.');
    expect(store.load()?.status.leg).toBe('awaiting-deposit');
  });

  it.each([
    ['omitted', undefined],
    ['null', null],
  ])('rejects a SUCCESS status with %s amountOut', async (_label, amountOut) => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => NOW });
    await service.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });

    client.statuses.push(status('SUCCESS' as never, {
      ...(amountOut === undefined ? {} : { amountOut: amountOut as never }),
      destinationChainTxHashes: [],
    }));
    await expect(service.refresh()).rejects.toThrow('1Click returned invalid execution status data.');
    expect(store.load()?.status.leg).toBe('awaiting-deposit');
  });

  it('rejects a SUCCESS status with a non-array destination transaction list', async () => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => NOW });
    await service.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });

    client.statuses.push(status('SUCCESS' as never, {
      amountOut: '1980000000000000000',
      destinationChainTxHashes: null as never,
    }));
    await expect(service.refresh()).rejects.toThrow('1Click returned invalid execution status data.');
  });

  it('rejects a SUCCESS status whose surfaced destination entry has no hash', async () => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => NOW });
    await service.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });

    client.statuses.push(status('SUCCESS' as never, {
      amountOut: '1980000000000000000',
      destinationChainTxHashes: [{} as never],
    }));
    await expect(service.refresh()).rejects.toThrow('1Click returned invalid execution status data.');
  });

  it('rejects a SUCCESS status whose destination hash is inherited', async () => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => NOW });
    await service.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });

    const entry = Object.create({ hash: '0xinherited' }) as { explorerUrl: string };
    entry.explorerUrl = 'https://example/tx';
    client.statuses.push(status('SUCCESS' as never, {
      amountOut: '1980000000000000000',
      destinationChainTxHashes: [entry as never],
    }));
    await expect(service.refresh()).rejects.toThrow('1Click returned invalid execution status data.');
    expect(store.load()?.status.leg).toBe('awaiting-deposit');
  });

  it('rejects a SUCCESS status whose destination hash is an accessor', async () => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => NOW });
    await service.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });

    let accessed = false;
    const entry = {} as { explorerUrl: string; hash: string };
    Object.defineProperty(entry, 'hash', {
      configurable: true,
      get() {
        accessed = true;
        throw new Error('hash getter must not run');
      },
    });
    entry.explorerUrl = 'https://example/tx';
    client.statuses.push(status('SUCCESS' as never, {
      amountOut: '1980000000000000000',
      destinationChainTxHashes: [entry as never],
    }));
    await expect(service.refresh()).rejects.toThrow('1Click returned invalid execution status data.');
    expect(accessed).toBe(false);
    expect(store.load()?.status.leg).toBe('awaiting-deposit');
  });

  it.each([
    ['inherited', (response: GetExecutionStatusResponse) => {
      Reflect.deleteProperty(response, 'status');
      Object.setPrototypeOf(response, { status: 'SUCCESS' });
    }],
    ['accessor', (response: GetExecutionStatusResponse) => {
      Reflect.deleteProperty(response, 'status');
      Object.defineProperty(response, 'status', {
        configurable: true,
        get() { throw new Error('status getter must not run'); },
      });
    }],
  ] as const)('rejects a status response with an unowned %s status field', async (_label, mutate) => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => NOW });
    await service.createManualDeposit({ source: SOURCE, amountIn: 1_000_000n, starknetRecipient: '0x123', refundAddress: request.refundTo });
    const response = status('SUCCESS' as never, { amountOut: '1980000000000000000', destinationChainTxHashes: [{ hash: '0xsettled', explorerUrl: 'https://example/tx' }] });
    mutate(response);
    client.statuses.push(response);
    await expect(service.refresh()).rejects.toThrow('1Click returned invalid execution status data.');
    expect(store.load()?.status.leg).toBe('awaiting-deposit');
  });

  it('rejects a status response with inherited swap details', async () => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => NOW });
    await service.createManualDeposit({ source: SOURCE, amountIn: 1_000_000n, starknetRecipient: '0x123', refundAddress: request.refundTo });
    const response = status('SUCCESS' as never, { amountOut: '1980000000000000000', destinationChainTxHashes: [{ hash: '0xsettled', explorerUrl: 'https://example/tx' }] });
    const details = response.swapDetails;
    Reflect.deleteProperty(response, 'swapDetails');
    Object.setPrototypeOf(response, { swapDetails: details });
    client.statuses.push(response);
    await expect(service.refresh()).rejects.toThrow('1Click returned invalid execution status data.');
    expect(store.load()?.status.leg).toBe('awaiting-deposit');
  });

  it.each([
    ['negative createdAt', { createdAt: -1 }],
    ['fractional updatedAt', { updatedAt: NOW + 0.5 }],
    ['unsafe createdAt', { createdAt: Number.MAX_SAFE_INTEGER + 1 }],
  ] as const)('rejects persisted records with an invalid %s timestamp', async (_label, patch) => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => NOW });
    const record = await service.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });
    const malformed = { ...record, ...patch };
    const raw = store.serialize(malformed as never);

    expect(deserializeBridgeRecord(raw)).toBeNull();
    store.save(malformed as never);
    expect(service.resume()).toBeNull();
  });

  it.each([
    ['null', null],
    ['array', []],
    ['primitive', 42],
  ] as const)('rejects a status response with %s swap details', async (_label, swapDetails) => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => NOW });
    await service.createManualDeposit({ source: SOURCE, amountIn: 1_000_000n, starknetRecipient: '0x123', refundAddress: request.refundTo });
    const response = status('PENDING_DEPOSIT' as never);
    response.swapDetails = swapDetails as never;
    client.statuses.push(response);

    await expect(service.refresh()).rejects.toThrow('1Click returned invalid execution status data.');
    expect(store.load()?.status.leg).toBe('awaiting-deposit');
  });

  it('rejects a status response with inherited signed quote evidence', async () => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => NOW });
    await service.createManualDeposit({ source: SOURCE, amountIn: 1_000_000n, starknetRecipient: '0x123', refundAddress: request.refundTo });
    const response = status('PENDING_DEPOSIT' as never);
    const evidence = response.quoteResponse;
    Reflect.deleteProperty(response, 'quoteResponse');
    Object.setPrototypeOf(response, { quoteResponse: evidence });
    client.statuses.push(response);
    await expect(service.refresh()).rejects.toThrow('1Click returned invalid execution status data.');
    expect(store.load()?.status.leg).toBe('awaiting-deposit');
  });

  it('rejects an amountOut above the uint256 upper bound', async () => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => NOW });
    await service.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });

    client.statuses.push(status('SUCCESS' as never, {
      amountOut: (1n << 256n).toString(),
      destinationChainTxHashes: [],
    }));
    await expect(service.refresh()).rejects.toThrow('1Click returned invalid execution status data.');
  });

  it.each([
    ['INCOMPLETE_DEPOSIT', 'deposit-detected', false],
    ['REFUNDED', 'failed', true],
    ['FAILED', 'failed', true],
  ])('maps a valid %s response safely', async (providerStatus, leg, pollingStopped) => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => NOW });
    await service.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });

    client.statuses.push(status(providerStatus as never));
    await expect(service.refresh()).resolves.toMatchObject({ leg, pollingStopped });
  });

  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['whitespace', '   '],
    ['oversized', 'x'.repeat(257)],
    ['non-string', null],
  ])('rejects a SUCCESS status with a %s settlement hash', async (_label, hash) => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => NOW });
    await service.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });

    client.statuses.push(status('SUCCESS' as never, {
      amountOut: '1980000000000000000',
      destinationChainTxHashes: [{ hash: hash as never, explorerUrl: 'https://example/tx' }],
    }));
    await expect(service.refresh()).rejects.toThrow(/invalid execution status data/i);
    expect(store.load()?.status.leg).toBe('awaiting-deposit');
  });

  it.each([
    ['empty', ''],
    ['whitespace', ' 0xorigin '],
    ['oversized', 'x'.repeat(257)],
    ['undefined', undefined],
    ['non-string', null],
  ])('rejects a surfaced %s origin transaction hash', async (_label, hash) => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => NOW });
    await service.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });

    client.statuses.push(status('PROCESSING' as never, {
      originChainTxHashes: [{ hash: hash as never, explorerUrl: 'https://example/tx' }],
    }));
    await expect(service.refresh()).rejects.toThrow(/invalid execution status data/i);
    expect(store.load()?.status.leg).toBe('awaiting-deposit');
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

  it('does not resurrect discarded evidence when a transaction report settles late', async () => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => NOW });
    await service.createSignedDeposit({
      source: { ...SOURCE, depositMode: 'signed' },
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });
    let releaseReport!: (value: SubmitDepositTxResponse) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    client.submitDepositTx = async () => {
      markStarted();
      return new Promise<SubmitDepositTxResponse>((resolve) => { releaseReport = resolve; });
    };

    const reporting = service.reportDepositTransaction('0xorigin-tx');
    await started;
    service.discard();
    releaseReport(status('KNOWN_DEPOSIT_TX' as never) as unknown as SubmitDepositTxResponse);

    await expect(reporting).resolves.toMatchObject({ leg: 'deposit-detected' });
    expect(service.resume()).toBeNull();
  });

  it('does not let a late transaction report overwrite replacement evidence', async () => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => NOW });
    await service.createSignedDeposit({
      source: { ...SOURCE, depositMode: 'signed' },
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });
    let releaseReport!: (value: SubmitDepositTxResponse) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    client.submitDepositTx = async () => {
      markStarted();
      return new Promise<SubmitDepositTxResponse>((resolve) => { releaseReport = resolve; });
    };

    const reporting = service.reportDepositTransaction('0xorigin-tx');
    await started;
    service.discard();
    client.getQuote = async (value) => ({
      ...signedQuote,
      correlationId: 'corr-2',
      signature: 'replacement-signed-by-one-click',
      quoteRequest: value,
      quote: {
        ...signedQuote.quote,
        depositAddress: '0xreplacement-deposit',
        deadline: value.deadline,
      },
    });
    const replacement = await service.createSignedDeposit({
      source: { ...SOURCE, depositMode: 'signed' },
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });
    const replacementExport = service.exportResumeRecord();
    releaseReport(status('KNOWN_DEPOSIT_TX' as never) as unknown as SubmitDepositTxResponse);

    await expect(reporting).resolves.toMatchObject({ leg: 'deposit-detected' });
    expect(service.resume()).toEqual(replacement);
    expect(service.exportResumeRecord()).toBe(replacementExport);
  });

  it('does not let a late transaction report regress newer progress for the same evidence', async () => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => NOW });
    await service.createSignedDeposit({
      source: { ...SOURCE, depositMode: 'signed' },
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });
    let releaseReport!: (value: SubmitDepositTxResponse) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    client.submitDepositTx = async () => {
      markStarted();
      return new Promise<SubmitDepositTxResponse>((resolve) => { releaseReport = resolve; });
    };

    const reporting = service.reportDepositTransaction('0xorigin-tx');
    await started;
    client.statuses.push(status('SUCCESS' as never, {
      amountOut: '1980000000000000000',
      destinationChainTxHashes: [{ hash: '0xsettled' as never, explorerUrl: 'https://example/tx' }],
    }));
    await expect(service.refresh()).resolves.toMatchObject({ leg: 'settled' });
    const settled = service.resume();
    const settledExport = service.exportResumeRecord();
    releaseReport(status('KNOWN_DEPOSIT_TX' as never) as unknown as SubmitDepositTxResponse);

    await expect(reporting).resolves.toMatchObject({ leg: 'deposit-detected' });
    expect(service.resume()).toEqual(settled);
    expect(service.exportResumeRecord()).toBe(settledExport);
  });

  it('does not let a late refresh regress newer transaction-report progress for the same evidence', async () => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => NOW });
    await service.createSignedDeposit({
      source: { ...SOURCE, depositMode: 'signed' },
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });
    let releaseRefresh!: (value: GetExecutionStatusResponse) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    client.getExecutionStatus = async () => {
      markStarted();
      return new Promise<GetExecutionStatusResponse>((resolve) => { releaseRefresh = resolve; });
    };

    const refreshing = service.refresh();
    await started;
    await expect(service.reportDepositTransaction('0xorigin-tx')).resolves.toMatchObject({
      leg: 'deposit-detected',
    });
    const detected = service.resume();
    const detectedExport = service.exportResumeRecord();
    releaseRefresh(status('PENDING_DEPOSIT' as never));

    await expect(refreshing).resolves.toMatchObject({ leg: 'awaiting-deposit' });
    expect(service.resume()).toEqual(detected);
    expect(service.exportResumeRecord()).toBe(detectedExport);
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

  it.each([
    ['null', null],
    ['array', []],
    ['primitive', 'malformed'],
    ['nested quote', { ...signedQuote, quote: null }],
  ] as const)('rejects a %s status quote response with the generic execution-status error', async (_label, quoteResponse) => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => NOW });
    await service.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });
    const before = store.load();
    client.statuses.push({
      ...status('PENDING_DEPOSIT' as never),
      quoteResponse: quoteResponse as never,
    });

    await expect(service.refresh()).rejects.toThrow('1Click returned invalid execution status data.');
    expect(store.load()).toEqual(before);
  });

  it('rejects a coercible execution status before mapping provider progress', async () => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => NOW });
    await service.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });
    const before = store.load();
    client.statuses.push({
      ...status('SUCCESS' as never, {
        amountOut: '2000000000000000000',
        destinationChainTxHashes: [{ hash: '0xdestination', explorerUrl: '' }],
      }),
      status: { toString: () => 'SUCCESS' },
    } as unknown as GetExecutionStatusResponse);

    await expect(service.refresh()).rejects.toThrow('1Click returned invalid execution status data.');
    expect(store.load()).toEqual(before);
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

  it('rejects coercible signed quote evidence before persistence', async () => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    client.getQuote = async () => ({
      ...signedQuote,
      timestamp: { toString: () => signedQuote.timestamp },
    } as unknown as QuoteResponse);
    const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => NOW });

    await expect(service.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    })).rejects.toThrow('1Click returned invalid signed quote data.');
    expect(store.load()).toBeNull();
  });

  it('rejects a coercible origin transaction hash before notifying 1Click', async () => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => NOW });
    await service.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });

    await expect(service.reportDepositTransaction({
      length: 0,
      toString: () => '0xorigin-tx',
    } as unknown as string)).rejects.toThrow('The origin deposit transaction hash is invalid.');
    expect(client.depositRequests).toHaveLength(0);
  });

  it('rejects a signed quote with a whitespace-only deposit address', async () => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    client.getQuote = async () => ({
      ...signedQuote,
      quote: { ...signedQuote.quote, depositAddress: '   ' },
    });
    const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => NOW });

    await expect(service.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    })).rejects.toThrow(/deposit address/i);
    expect(store.load()).toBeNull();
  });

  it('rejects a coercible deposit memo before retaining signed quote evidence', async () => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    client.getQuote = async () => ({
      ...signedQuote,
      quote: { ...signedQuote.quote, depositMemo: { toString: () => 'memo' } },
    } as unknown as QuoteResponse);
    const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => NOW });

    await expect(service.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    })).rejects.toThrow('1Click returned invalid signed quote data.');
    expect(store.load()).toBeNull();
  });

  it('rejects a whitespace-only deposit memo before retaining signed quote evidence', async () => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    client.getQuote = async () => ({
      ...signedQuote,
      quote: { ...signedQuote.quote, depositMemo: '   ' },
    });
    const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => NOW });

    await expect(service.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    })).rejects.toThrow('1Click returned invalid signed quote data.');
    expect(store.load()).toBeNull();
  });

  it('rejects a coercible Near sender account before notifying 1Click', async () => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => NOW });
    await service.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });

    await expect(service.reportDepositTransaction(
      '0xorigin-tx',
      { toString: () => 'alice.near' } as unknown as string,
    )).rejects.toThrow('The Near sender account is invalid.');
    expect(client.depositRequests).toHaveLength(0);
  });

  it('rejects a whitespace-bearing Near sender account before notifying 1Click', async () => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => NOW });
    await service.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });

    await expect(service.reportDepositTransaction('0xorigin-tx', 'alice near'))
      .rejects.toThrow('The Near sender account is invalid.');
    expect(client.depositRequests).toHaveLength(0);
  });

  it('rejects a signed quote with an overlong deposit address', async () => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    client.getQuote = async () => ({
      ...signedQuote,
      quote: { ...signedQuote.quote, depositAddress: 'x'.repeat(257) },
    });
    const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => NOW });

    await expect(service.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    })).rejects.toThrow(/deposit address/i);
    expect(store.load()).toBeNull();
  });

  it('rejects accessor-backed signed quote fields without invoking the provider getter', async () => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    let getterCalls = 0;
    const quote = Object.create(signedQuote.quote) as typeof signedQuote.quote;
    Object.defineProperty(quote, 'depositAddress', {
      configurable: true,
      get: () => {
        getterCalls += 1;
        return signedQuote.quote.depositAddress;
      },
    });
    client.getQuote = async () => ({ ...signedQuote, quote });
    const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => NOW });

    await expect(service.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    })).rejects.toThrow('1Click returned invalid signed quote data.');
    expect(getterCalls).toBe(0);
    expect(store.load()).toBeNull();
  });

  it('rejects inherited required signed quote fields before persistence', async () => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    const quote = Object.create(signedQuote.quote) as typeof signedQuote.quote;
    client.getQuote = async () => ({ ...signedQuote, quote });
    const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => NOW });

    await expect(service.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    })).rejects.toThrow('1Click returned invalid signed quote data.');
    expect(store.load()).toBeNull();
  });

  it('rejects a signed quote whose executable amounts do not match the request', async () => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    client.getQuote = async () => ({
      ...signedQuote,
      quote: { ...signedQuote.quote, amountIn: '999999', amountOut: '0', minAmountOut: '0' },
    });
    const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => NOW });

    await expect(service.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    })).rejects.toThrow(/amount/i);
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

  it('stops active polling when the wall clock rolls backwards', async () => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    let now = NOW;
    let rollback = false;
    let sleeps = 0;
    const service = new BridgeService({
      client,
      store,
      quoteVerifier: () => true,
      now: () => (rollback ? --now : NOW),
      sleep: async () => {
        sleeps += 1;
        if (sleeps >= 3) throw new Error('polling did not honor its active bound');
      },
    });
    await service.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });
    rollback = true;
    client.statuses.push(
      status('PENDING_DEPOSIT' as never),
      status('PENDING_DEPOSIT' as never),
      status('PENDING_DEPOSIT' as never),
    );

    await expect(service.watch({ intervalMs: 10, maxActiveMs: 20 })).resolves.toMatchObject({
      leg: 'awaiting-deposit',
      pollingStopped: true,
    });
  });

  it('does not lose active polling time when the wall clock oscillates', async () => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    let watching = false;
    let watchRead = 0;
    let sleeps = 0;
    const watchTimes = [
      NOW,
      NOW + 5, NOW + 5, NOW + 5,
      NOW - 5, NOW - 5, NOW - 5,
      NOW + 5, NOW + 5, NOW + 5,
    ];
    const service = new BridgeService({
      client,
      store,
      quoteVerifier: () => true,
      now: () => watching ? watchTimes[Math.min(watchRead++, watchTimes.length - 1)]! : NOW,
      sleep: async () => {
        sleeps += 1;
        if (sleeps >= 3) throw new Error('oscillation erased the active polling budget');
      },
    });
    await service.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });
    watching = true;
    client.statuses.push(
      status('PENDING_DEPOSIT' as never),
      status('PENDING_DEPOSIT' as never),
      status('PENDING_DEPOSIT' as never),
    );

    await expect(service.watch({ intervalMs: 10, maxActiveMs: 20 })).resolves.toMatchObject({
      leg: 'awaiting-deposit',
      pollingStopped: true,
    });
    expect(sleeps).toBe(2);
  });

  it('uses the exact remaining active budget for the final polling interval', async () => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    const delays: number[] = [];
    const service = new BridgeService({
      client,
      store,
      quoteVerifier: () => true,
      now: () => NOW,
      sleep: async (ms) => { delays.push(ms); },
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
      status('PENDING_DEPOSIT' as never),
    );

    await expect(service.watch({ intervalMs: 7, maxActiveMs: 20 })).resolves.toMatchObject({
      leg: 'awaiting-deposit',
      pollingStopped: true,
    });
    expect(delays).toEqual([7, 7, 6]);
  });

  it.each([2_147_483_647, 2_147_483_648])(
    'keeps a requested polling sleep of %s within the Node timer ceiling',
    async (requestedDelay) => {
      const client = new StubClient();
      const store = new MemoryBridgeStore();
      const delays: number[] = [];
      const stopped = new Error('stop after observing the first polling sleep');
      const service = new BridgeService({
        client,
        store,
        quoteVerifier: () => true,
        now: () => NOW,
        sleep: async (ms) => {
          delays.push(ms);
          throw stopped;
        },
      });
      await service.createManualDeposit({
        source: SOURCE,
        amountIn: 1_000_000n,
        starknetRecipient: '0x123',
        refundAddress: request.refundTo,
      });
      client.statuses.push(status('PENDING_DEPOSIT' as never));

      await expect(service.watch({
        intervalMs: requestedDelay,
        maxActiveMs: requestedDelay,
      })).rejects.toBe(stopped);
      expect(delays).toEqual([2_147_483_647]);
    },
  );

  it('counts capped sleeps toward a large active window through clock rollback', async () => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    const delays: number[] = [];
    let now = NOW;
    const service = new BridgeService({
      client,
      store,
      quoteVerifier: () => true,
      now: () => now,
      sleep: async (ms) => {
        delays.push(ms);
        now -= 1;
      },
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

    await expect(service.watch({
      intervalMs: 2_147_483_648,
      maxActiveMs: 2_147_483_648,
    })).resolves.toMatchObject({
      leg: 'awaiting-deposit',
      pollingStopped: true,
    });
    expect(delays).toEqual([2_147_483_647, 1]);
  });

  it('propagates an abort without rewriting the persisted pending status', async () => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    const controller = new AbortController();
    const reason = new Error('stop watching');
    const service = new BridgeService({
      client,
      store,
      quoteVerifier: () => true,
      now: () => NOW,
      sleep: async (_ms, signal) => {
        controller.abort(reason);
        throw signal?.reason;
      },
    });
    await service.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });
    client.statuses.push(status('PENDING_DEPOSIT' as never));

    await expect(service.watch({ intervalMs: 10, maxActiveMs: 20, signal: controller.signal }))
      .rejects.toBe(reason);
    expect(store.load()?.status).toMatchObject({
      leg: 'awaiting-deposit',
      pollingStopped: false,
    });
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
    second.discard();
    expect(() => second.importResumeRecord(
      exported.replace('signed-by-one-click', 'tampered-signature'),
    )).toThrow(/signature/i);
  });

  it.each([
    ['older valid evidence', (raw: string) => {
      const record = deserializeBridgeRecord(raw)!;
      return serializeBridgeRecord({ ...record, updatedAt: NOW - 1 });
    }],
    ['equally recent valid evidence', (raw: string) => {
      const record = deserializeBridgeRecord(raw)!;
      return serializeBridgeRecord({ ...record, updatedAt: NOW });
    }],
    ['later valid evidence', (raw: string) => {
      const record = deserializeBridgeRecord(raw)!;
      return serializeBridgeRecord({ ...record, updatedAt: NOW + 1 });
    }],
    ['malformed evidence', () => '{not-json'],
    ['tampered evidence', (raw: string) => raw.replace(
      'signed-by-one-click',
      'tampered-signature',
    )],
  ])('requires an explicit discard before importing %s', async (_label, importedEvidence) => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    const service = new BridgeService({
      client,
      store,
      quoteVerifier: () => true,
      now: () => NOW,
    });
    await service.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });
    const staleExport = service.exportResumeRecord();
    client.statuses.push(status('SUCCESS' as never, {
      amountOut: '999000',
      destinationChainTxHashes: [{ hash: '0xsettled', explorerUrl: 'https://example/tx' }],
    }));
    await service.refresh();
    const retainedRecord = service.resume();
    const retainedExport = service.exportResumeRecord();

    expect(() => service.importResumeRecord(importedEvidence(staleExport))).toThrow(
      'An existing bridge deposit is available. Discard it before importing another record.',
    );
    expect(service.resume()).toEqual(retainedRecord);
    expect(service.resume()?.status).toMatchObject({
      leg: 'settled',
      strkReceived: 999_000n,
      settlementTxHash: '0xsettled',
    });
    expect(service.exportResumeRecord()).toBe(retainedExport);
  });
});

describe('source registry and refund validation', () => {
  it('falls back when the live token registry has a malformed response shape', async () => {
    await expect(loadSourceAssets({
      getTokens: async () => null as never,
    })).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        assetId: 'nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near',
        availability: 'fallback',
      }),
    ]));
  });

  it('ignores malformed entries in an otherwise valid token registry response', async () => {
    const assets = await loadSourceAssets({
      getTokens: async () => [null, 'not-an-entry'] as never,
    });
    expect(assets).toHaveLength(6);
    expect(assets.every((asset) => asset.availability === 'fallback')).toBe(true);
  });

  it('ignores coercible live token metadata instead of publishing non-string assets', async () => {
    const coercibleAsset = { toString: () => 'nep141:coercible.omft.near' };
    const coercibleSymbol = { toString: () => 'COERCIBLE' };
    const coercibleBlockchain = { toString: () => 'arb' };
    const assets = await loadSourceAssets({
      getTokens: async () => [{
        assetId: coercibleAsset,
        symbol: coercibleSymbol,
        decimals: 6,
        blockchain: coercibleBlockchain,
      }] as unknown as TokenResponse[],
    });

    expect(assets).toHaveLength(6);
    expect(assets.some((asset) => asset.assetId === coercibleAsset)).toBe(false);
  });

  it('ignores live token metadata supplied only through inheritance', async () => {
    const inherited = Object.create({
      assetId: 'nep141:inherited.omft.near',
      symbol: 'INHERITED',
      decimals: 6,
      blockchain: 'arb',
    }) as TokenResponse;
    const assets = await loadSourceAssets({ getTokens: async () => [inherited] });

    expect(assets).toHaveLength(6);
    expect(assets.some((asset) => asset.assetId === 'nep141:inherited.omft.near')).toBe(false);
  });

  it('ignores live token metadata containing only whitespace', async () => {
    const assets = await loadSourceAssets({
      getTokens: async () => [{
        assetId: '   ',
        symbol: '\t',
        decimals: 6,
        blockchain: 'arb',
      }] as TokenResponse[],
    });

    expect(assets).toHaveLength(6);
    expect(assets.some((asset) => asset.assetId.trim() === '')).toBe(false);
  });

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

  it('keeps every currently supported non-Starknet chain family available', async () => {
    const live = [
      ['near', 'NEAR'],
      ['btc', 'BTC'],
      ['sui', 'SUI'],
      ['aptos', 'APT'],
      ['hypercore', 'USDC'],
      ['starknet', 'ETH'],
    ].map(([blockchain, symbol], index) => ({
      assetId: `nep141:source-${index}.omft.near`,
      symbol,
      decimals: 8,
      blockchain,
      price: 1,
      priceUpdatedAt: '2026-08-16T12:00:00Z',
    })) as TokenResponse[];
    const assets = await loadSourceAssets({ getTokens: async () => live });

    expect(assets).toEqual(expect.arrayContaining([
      expect.objectContaining({ chainName: 'near' }),
      expect.objectContaining({ chainName: 'bitcoin' }),
      expect.objectContaining({ chainName: 'sui' }),
      expect.objectContaining({ chainName: 'aptos' }),
      expect.objectContaining({ chainName: 'hypercore' }),
    ]));
    expect(assets.some((asset) => String(asset.chainName) === 'starknet')).toBe(false);
  });

  it('uses chain-specific shape checks for irreversible refund addresses', () => {
    expect(validateSourceAddress('arbitrum', request.refundTo)).toEqual({ ok: true });
    expect(validateSourceAddress('arbitrum', '0x123').ok).toBe(false);
    expect(validateSourceAddress('stellar', `G${'A'.repeat(55)}`)).toEqual({ ok: true });
    expect(validateSourceAddress('near', 'alice.near')).toEqual({ ok: true });
    expect(validateSourceAddress('bitcoin', `bc1q${'a'.repeat(38)}`)).toEqual({ ok: true });
    expect(validateSourceAddress('sui', `0x${'a'.repeat(64)}`)).toEqual({ ok: true });
    expect(validateSourceAddress('arbitrum', `0x${'0'.repeat(40)}`).ok).toBe(false);
    expect(validateStarknetAddress(`0x${'f'.repeat(64)}`).ok).toBe(false);
  });

  it('rejects coercible address inputs instead of treating them as strings', () => {
    const coercible = { trim: () => '0x123' } as unknown as string;
    expect(validateStarknetAddress(coercible).ok).toBe(false);
    expect(validateSourceAddress('arbitrum', coercible).ok).toBe(false);
  });
});

describe('bridge persistence', () => {
  it('persists a complete signed quote across LocalBridgeStore instances and clears corrupt storage', async () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
    const client = new StubClient();
    const first = new BridgeService({
      client,
      store: new LocalBridgeStore(storage),
      quoteVerifier: () => true,
      now: () => NOW,
    });
    const created = await first.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });

    const second = new LocalBridgeStore(storage);
    expect(second.load()).toEqual(created);
    expect(second.load()?.signedQuote).toEqual(signedQuote);

    values.set('strkworld.bridge.inbound.v1', '{not-json');
    expect(second.load()).toBeNull();
    expect(values.has('strkworld.bridge.inbound.v1')).toBe(false);
  });

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

  it.each([
    ['whitespace-only', '   '],
    ['overlong', 'x'.repeat(257)],
    ['non-string', 42],
  ])('rejects persisted records with a %s deposit address', (_label, depositAddress) => {
    const store = new MemoryBridgeStore();
    const malformed = {
      v: 1 as const,
      createdAt: NOW,
      updatedAt: NOW,
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
      signedQuote: {
        ...signedQuote,
        quote: { ...signedQuote.quote, depositAddress: depositAddress as never },
      },
      status: { leg: 'awaiting-deposit' as const, message: 'pending', pollingStopped: false },
    };

    expect(store.deserialize(store.serialize(malformed))).toBeNull();
  });

  it.each([
    ['string', '7'],
    ['number', 7],
    ['object', {}],
  ] as const)('ignores an inherited %s bigint marker while reviving own wrappers', async (_label, inheritedMarker) => {
    const client = new StubClient();
    const service = new BridgeService({
      client,
      store: new MemoryBridgeStore(),
      quoteVerifier: () => true,
      now: () => NOW,
    });
    const record = await service.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });
    const encoded = serializeBridgeRecord(record);
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, '$strkworldBigInt');
    Object.defineProperty(Object.prototype, '$strkworldBigInt', {
      value: inheritedMarker,
      configurable: true,
    });
    try {
      const decoded = deserializeBridgeRecord(encoded);
      expect(decoded).toEqual(record);
      expect(decoded?.amountIn).toBe(1_000_000n);
    } finally {
      if (previous) Object.defineProperty(Object.prototype, '$strkworldBigInt', previous);
      else delete (Object.prototype as Record<string, unknown>).$strkworldBigInt;
    }
  });

  it.each([
    ['depositTxHash', {}],
    ['settlementTxHash', 42],
    ['strkReceived', '7'],
  ] as const)('ignores an inherited optional status field %s while retaining signed evidence', async (field, inheritedValue) => {
    const client = new StubClient();
    const service = new BridgeService({
      client,
      store: new MemoryBridgeStore(),
      quoteVerifier: () => true,
      now: () => NOW,
    });
    const record = await service.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });
    const encoded = serializeBridgeRecord(record);
    const values = new Map<string, string>([['strkworld.bridge.inbound.v1', encoded]]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    };
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, field);
    Object.defineProperty(Object.prototype, field, {
      value: inheritedValue,
      configurable: true,
    });
    try {
      expect(deserializeBridgeRecord(encoded)).toEqual(record);
      expect(new LocalBridgeStore(storage).load()).toEqual(record);
      expect(values.has('strkworld.bridge.inbound.v1')).toBe(true);
    } finally {
      if (previous) Object.defineProperty(Object.prototype, field, previous);
      else delete (Object.prototype as Record<string, unknown>)[field];
    }
  });

  it('rejects a persisted record whose required status is inherited', async () => {
    const client = new StubClient();
    const service = new BridgeService({
      client,
      store: new MemoryBridgeStore(),
      quoteVerifier: () => true,
      now: () => NOW,
    });
    const record = await service.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });
    const parsed = JSON.parse(serializeBridgeRecord(record)) as Record<string, unknown>;
    delete parsed.status;
    const raw = JSON.stringify(parsed);
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'status');
    Object.defineProperty(Object.prototype, 'status', {
      value: record.status,
      configurable: true,
    });
    try {
      expect(deserializeBridgeRecord(raw)).toBeNull();
    } finally {
      if (previous) Object.defineProperty(Object.prototype, 'status', previous);
      else delete (Object.prototype as Record<string, unknown>).status;
    }
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

  it('rejects oversized imported resume records before parsing them', () => {
    expect(deserializeBridgeRecord(' '.repeat(MAX_RESUME_RECORD_BYTES + 1))).toBeNull();
  });

  it.each([
    ['null', null],
    ['array', []],
    ['primitive', 'malformed'],
    ['invalid leg', { leg: 'unknown' }],
    ['non-string message', { leg: 'awaiting-deposit', message: 42 }],
    ['non-boolean polling flag', { leg: 'awaiting-deposit', message: 'waiting', pollingStopped: 'false' }],
    ['unknown status field', { leg: 'awaiting-deposit', message: 'waiting', pollingStopped: false, unexpected: 'forged' }],
    ['non-string deposit hash', { leg: 'deposit-detected', message: 'detected', pollingStopped: true, depositTxHash: 42 }],
    ['non-string settlement hash', { leg: 'settled', message: 'settled', pollingStopped: true, settlementTxHash: {} }],
    ['non-bigint received amount', { leg: 'settled', message: 'settled', pollingStopped: true, strkReceived: '1' }],
    ['negative received amount', { leg: 'settled', message: 'settled', pollingStopped: true, strkReceived: -1n }],
    ['deposit hash on quoted leg', { leg: 'quoted', message: 'quoted', pollingStopped: false, depositTxHash: '0xorigin' }],
    ['deposit hash on awaiting leg', { leg: 'awaiting-deposit', message: 'waiting', pollingStopped: false, depositTxHash: '0xorigin' }],
    ['received amount on a pending leg', { leg: 'awaiting-deposit', message: 'waiting', pollingStopped: false, strkReceived: 1n }],
    ['settlement hash on a pending leg', { leg: 'awaiting-deposit', message: 'waiting', pollingStopped: false, settlementTxHash: '0xdestination' }],
  ] as const)('rejects a persisted status with %s', async (_label, malformedStatus) => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => NOW });
    const record = await service.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });
    const raw = store.serialize({ ...record, status: malformedStatus as never });

    expect(deserializeBridgeRecord(raw)).toBeNull();
    store.save({ ...record, status: malformedStatus as never });
    expect(service.resume()).toBeNull();
  });

  it('rejects a persisted record with an unknown root field', async () => {
    const client = new StubClient();
    const store = new MemoryBridgeStore();
    const service = new BridgeService({ client, store, quoteVerifier: () => true, now: () => NOW });
    const record = await service.createManualDeposit({
      source: SOURCE,
      amountIn: 1_000_000n,
      starknetRecipient: '0x123',
      refundAddress: request.refundTo,
    });
    const raw = store.serialize({ ...record, unexpected: 'forged' } as never);

    expect(deserializeBridgeRecord(raw)).toBeNull();
    store.save({ ...record, unexpected: 'forged' } as never);
    expect(service.resume()).toBeNull();
  });

  it('round-trips every valid bridge status shape', async () => {
    const validStatuses: BridgeStatus[] = [
      { leg: 'quoted', message: 'quoted', pollingStopped: false },
      { leg: 'awaiting-deposit', message: 'waiting', pollingStopped: false },
      { leg: 'deposit-detected', depositTxHash: '0xorigin', message: 'detected', pollingStopped: false },
      { leg: 'solver-settling', depositTxHash: '0xorigin', message: 'settling', pollingStopped: false },
      { leg: 'settled', depositTxHash: '0xorigin', settlementTxHash: '0xdestination', strkReceived: 1n, message: 'settled', pollingStopped: true },
      { leg: 'failed', message: 'failed', pollingStopped: true },
      { leg: 'expired', message: 'expired', pollingStopped: true },
    ];
    for (const status of validStatuses) {
      const record = {
        v: 1 as const,
        createdAt: NOW,
        updatedAt: NOW,
        source: SOURCE,
        amountIn: 1_000_000n,
        starknetRecipient: '0x123',
        refundAddress: request.refundTo,
        signedQuote,
        status,
      };
      expect(deserializeBridgeRecord(serializeBridgeRecord(record))).toEqual(record);
    }
  });
});
