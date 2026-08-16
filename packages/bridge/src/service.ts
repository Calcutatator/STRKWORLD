import type {
  GetExecutionStatusResponse,
  QuoteRequest,
  QuoteResponse,
} from '@defuse-protocol/one-click-sdk-typescript';
import { verifyQuoteSignature } from '@defuse-protocol/one-click-sdk-typescript';
import { validateSourceAddress, validateStarknetAddress } from './address-validation.js';
import type { OneClickClient } from './client.js';
import type { BridgeStore } from './persistence.js';
import { STRK_ON_STARKNET_ASSET_ID } from './source-assets.js';
import type { BridgeRecord, BridgeStatus, SourceAsset } from './types.js';

export const DEFAULT_SLIPPAGE_BPS = 100;
export const QUOTE_DEADLINE_MS = 30 * 60 * 1_000;

export interface CreateManualDepositInput {
  source: SourceAsset;
  amountIn: bigint;
  starknetRecipient: string;
  refundAddress: string;
  slippageBps?: number;
}

interface BridgeServiceOptions {
  client: OneClickClient;
  store: BridgeStore;
  now?: () => number;
  quoteVerifier?: (quote: QuoteResponse) => boolean;
}

export class BridgeService {
  private readonly client: OneClickClient;
  private readonly store: BridgeStore;
  private readonly now: () => number;
  private readonly quoteVerifier: (quote: QuoteResponse) => boolean;

  constructor(options: BridgeServiceOptions) {
    this.client = options.client;
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.quoteVerifier = options.quoteVerifier ?? verifyQuoteSignature;
  }

  async createManualDeposit(input: CreateManualDepositInput): Promise<BridgeRecord> {
    validateInput(input);
    const deadline = new Date(this.now() + QUOTE_DEADLINE_MS).toISOString();
    const request = {
      dry: false,
      ...(input.source.chainName === 'stellar' ? { depositMode: 'MEMO' } : {}),
      swapType: 'EXACT_INPUT',
      slippageTolerance: input.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
      originAsset: input.source.assetId,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: STRK_ON_STARKNET_ASSET_ID,
      amount: input.amountIn.toString(),
      refundTo: input.refundAddress,
      refundType: 'ORIGIN_CHAIN',
      recipient: input.starknetRecipient,
      recipientType: 'DESTINATION_CHAIN',
      deadline,
    } as QuoteRequest;

    const signedQuote = await this.client.getQuote(request);
    assertSignedQuote(signedQuote, input);
    if (!this.quoteVerifier(signedQuote)) {
      throw new Error('1Click quote signature verification failed.');
    }
    const now = this.now();
    const record: BridgeRecord = {
      v: 1,
      createdAt: now,
      updatedAt: now,
      source: { ...input.source },
      amountIn: input.amountIn,
      starknetRecipient: input.starknetRecipient,
      refundAddress: input.refundAddress,
      signedQuote,
      status: {
        leg: 'awaiting-deposit',
        message: signedQuote.quote.depositMemo
          ? 'Send the exact amount with both the deposit address and memo.'
          : 'Send the exact amount to the deposit address.',
        pollingStopped: false,
      },
    };
    this.store.save(record);
    return record;
  }

  resume(): BridgeRecord | null {
    return this.store.load();
  }

  async refresh(): Promise<BridgeStatus> {
    const record = this.store.load();
    if (!record) throw new Error('No bridge deposit is available to resume.');
    const raw = await this.client.getExecutionStatus(
      record.signedQuote.quote.depositAddress!,
      record.signedQuote.quote.depositMemo,
    );
    const status = mapStatus(raw);
    this.store.save({ ...record, status, updatedAt: this.now() });
    return status;
  }

  discard(): void {
    this.store.clear();
  }
}

function validateInput(input: CreateManualDepositInput): void {
  if (input.amountIn <= 0n) throw new Error('Bridge amount must be positive.');
  const slippage = input.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  if (!Number.isInteger(slippage) || slippage < 1 || slippage > 1_000) {
    throw new Error('Bridge slippage must be between 1 and 1000 basis points.');
  }
  const recipient = validateStarknetAddress(input.starknetRecipient);
  if (!recipient.ok) throw new Error(recipient.hint);
  const refund = validateSourceAddress(input.source.chainName, input.refundAddress);
  if (!refund.ok) throw new Error(refund.hint);
}

function assertSignedQuote(response: QuoteResponse, input: CreateManualDepositInput): void {
  if (!response.signature || !response.timestamp || !response.correlationId) {
    throw new Error('1Click returned no signed quote dispute evidence.');
  }
  if (!response.quote.depositAddress) throw new Error('1Click returned no deposit address.');
  if (response.quoteRequest.destinationAsset !== STRK_ON_STARKNET_ASSET_ID) {
    throw new Error('1Click quote destination was not Starknet STRK.');
  }
  if (
    response.quoteRequest.originAsset !== input.source.assetId ||
    response.quoteRequest.amount !== input.amountIn.toString() ||
    response.quoteRequest.recipient !== input.starknetRecipient ||
    response.quoteRequest.refundTo !== input.refundAddress
  ) {
    throw new Error('1Click signed quote did not match the requested route.');
  }
}

function mapStatus(raw: GetExecutionStatusResponse): BridgeStatus {
  switch (String(raw.status)) {
    case 'PENDING_DEPOSIT':
      return { leg: 'awaiting-deposit', message: 'Waiting for the origin deposit.', pollingStopped: false };
    case 'KNOWN_DEPOSIT_TX':
    case 'INCOMPLETE_DEPOSIT':
      return {
        leg: 'deposit-detected',
        depositTxHash: raw.swapDetails.originChainTxHashes[0]?.hash,
        message: String(raw.status) === 'INCOMPLETE_DEPOSIT'
          ? 'A deposit was detected but is below the quoted amount.'
          : 'Deposit detected; waiting for the solver.',
        pollingStopped: false,
      };
    case 'PROCESSING':
      return {
        leg: 'solver-settling',
        depositTxHash: raw.swapDetails.originChainTxHashes[0]?.hash,
        message: 'The solver is delivering STRK to Starknet.',
        pollingStopped: false,
      };
    case 'SUCCESS':
      return {
        leg: 'settled',
        depositTxHash: raw.swapDetails.originChainTxHashes[0]?.hash,
        settlementTxHash: raw.swapDetails.destinationChainTxHashes[0]?.hash,
        strkReceived: raw.swapDetails.amountOut ? BigInt(raw.swapDetails.amountOut) : undefined,
        message: 'STRK arrived publicly. Shielding is the separate next step.',
        pollingStopped: true,
      };
    case 'REFUNDED':
      return {
        leg: 'failed',
        depositTxHash: raw.swapDetails.originChainTxHashes[0]?.hash,
        message: 'The bridge did not settle and 1Click reports a refund.',
        pollingStopped: true,
      };
    case 'FAILED':
    default:
      return {
        leg: 'failed',
        message: 'The bridge could not complete. Keep the signed quote for support.',
        pollingStopped: true,
      };
  }
}
