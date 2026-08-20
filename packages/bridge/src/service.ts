import type {
  GetExecutionStatusResponse,
  QuoteRequest,
  QuoteResponse,
} from '@defuse-protocol/one-click-sdk-typescript';
import { verifyQuoteSignature } from '@defuse-protocol/one-click-sdk-typescript';
import { validateSourceAddress, validateStarknetAddress } from './address-validation.js';
import type { OneClickClient } from './client.js';
import {
  deserializeBridgeRecord,
  serializeBridgeRecord,
  type BridgeStore,
} from './persistence.js';
import { STRK_ON_STARKNET_ASSET_ID } from './source-assets.js';
import type { BridgeRecord, BridgeStatus, SourceAsset } from './types.js';

export const DEFAULT_SLIPPAGE_BPS = 100;
export const QUOTE_DEADLINE_MS = 30 * 60 * 1_000;

const MAX_TRANSACTION_HASH_LENGTH = 256;
const MAX_BASE_UNIT_AMOUNT_DIGITS = 78;
const MAX_BASE_UNIT_AMOUNT = (1n << 256n) - 1n;
const INVALID_EXECUTION_STATUS_MESSAGE = '1Click returned invalid execution status data.';

export interface CreateDepositInput {
  source: SourceAsset;
  amountIn: bigint;
  starknetRecipient: string;
  refundAddress: string;
  slippageBps?: number;
}

/** @deprecated Use `CreateDepositInput`; retained for the first shell adapter. */
export type CreateManualDepositInput = CreateDepositInput;

interface BridgeServiceOptions {
  client: OneClickClient;
  store: BridgeStore;
  now?: () => number;
  quoteVerifier?: (quote: QuoteResponse) => boolean;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface WatchDepositOptions {
  signal?: AbortSignal;
  /** Manual deposits default to a deliberately slower poll than wallet-signed deposits. */
  intervalMs?: number;
  /** Stop active polling after this period; the persisted deposit remains resumable. */
  maxActiveMs?: number;
  onUpdate?: (status: BridgeStatus) => void;
}

export const MANUAL_POLL_INTERVAL_MS = 10_000;
export const MAX_ACTIVE_POLLING_MS = 10 * 60 * 1_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export class BridgeService {
  private readonly client: OneClickClient;
  private readonly store: BridgeStore;
  private readonly now: () => number;
  private readonly quoteVerifier: (quote: QuoteResponse) => boolean;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;

  constructor(options: BridgeServiceOptions) {
    this.client = options.client;
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.quoteVerifier = options.quoteVerifier ?? verifyQuoteSignature;
    this.sleep = options.sleep ?? abortableSleep;
  }

  async createManualDeposit(input: CreateDepositInput): Promise<BridgeRecord> {
    if (input.source.depositMode !== 'manual') {
      throw new Error('Manual bridge creation requires a manual source asset.');
    }
    return this.createDeposit(input);
  }

  async createSignedDeposit(input: CreateDepositInput): Promise<BridgeRecord> {
    if (input.source.depositMode !== 'signed') {
      throw new Error('Signed bridge creation requires a wallet-signable source asset.');
    }
    return this.createDeposit(input);
  }

  private async createDeposit(input: CreateDepositInput): Promise<BridgeRecord> {
    if (this.resume()) {
      throw new Error('An existing bridge deposit is available. Discard it before creating a new deposit.');
    }
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
    assertSignedQuote(signedQuote, input, request);
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
        message: input.source.depositMode === 'signed'
          ? 'Approve the exact origin deposit in your connected wallet.'
          : signedQuote.quote.depositMemo
            ? 'Send the exact amount with both the deposit address and memo.'
            : 'Send the exact amount to the deposit address.',
        pollingStopped: false,
      },
    };
    this.store.save(record);
    return record;
  }

  /** Notify 1Click after an origin-wallet adapter broadcasts the deposit. */
  async reportDepositTransaction(
    txHash: string,
    nearSenderAccount?: string,
  ): Promise<BridgeStatus> {
    if (!txHash || txHash.length > 256 || /\s/.test(txHash)) {
      throw new Error('The origin deposit transaction hash is invalid.');
    }
    const record = this.resume();
    if (!record) throw new Error('No bridge deposit is available to resume.');
    const raw = await this.client.submitDepositTx({
      txHash,
      depositAddress: record.signedQuote.quote.depositAddress!,
      ...(nearSenderAccount ? { nearSenderAccount } : {}),
      ...(record.signedQuote.quote.depositMemo
        ? { memo: record.signedQuote.quote.depositMemo }
        : {}),
    });
    this.verifyStatusQuote(raw, record);
    const status = mapStatus(raw);
    const retained = this.resume();
    if (retained && sameSignedEvidence(retained, record)) {
      this.store.save({ ...retained, status, updatedAt: this.now() });
    }
    return status;
  }

  resume(): BridgeRecord | null {
    const record = this.store.load();
    if (!record) return null;
    try {
      this.verifyRecord(record);
      return record;
    } catch {
      return null;
    }
  }

  /** Export contains addresses and timing. The shell must label it sensitive. */
  exportResumeRecord(): string {
    const record = this.resume();
    if (!record) throw new Error('No bridge deposit is available to export.');
    return serializeBridgeRecord(record);
  }

  /** Import signed evidence, reverify it, and reset display state until refreshed. */
  importResumeRecord(serialized: string): BridgeRecord {
    if (this.resume()) {
      throw new Error('An existing bridge deposit is available. Discard it before importing another record.');
    }
    const decoded = deserializeBridgeRecord(serialized);
    if (!decoded) throw new Error('The bridge resume record is invalid.');
    this.verifyRecord(decoded);
    const restored: BridgeRecord = {
      ...decoded,
      updatedAt: this.now(),
      status: {
        leg: 'awaiting-deposit',
        message: 'Resume record imported. Checking the signed deposit with 1Click.',
        pollingStopped: true,
      },
    };
    this.store.save(restored);
    return restored;
  }

  async refresh(): Promise<BridgeStatus> {
    const record = this.resume();
    if (!record) throw new Error('No bridge deposit is available to resume.');
    const raw = await this.client.getExecutionStatus(
      record.signedQuote.quote.depositAddress!,
      record.signedQuote.quote.depositMemo,
    );
    this.verifyStatusQuote(raw, record);
    let status = mapStatus(raw);
    if (status.leg === 'awaiting-deposit' && quoteExpired(record, this.now())) {
      status = {
        leg: 'expired',
        message: 'The deposit quote expired before 1Click detected funds. Create a new quote.',
        pollingStopped: true,
      };
    }
    const retained = this.resume();
    if (retained && sameSignedEvidence(retained, record)) {
      this.store.save({ ...retained, status, updatedAt: this.now() });
    }
    return status;
  }

  /** Poll a resumable deposit without converting a local timeout into a failure. */
  async watch(options: WatchDepositOptions = {}): Promise<BridgeStatus> {
    const intervalMs = options.intervalMs ?? MANUAL_POLL_INTERVAL_MS;
    const maxActiveMs = options.maxActiveMs ?? MAX_ACTIVE_POLLING_MS;
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
      throw new Error('Bridge polling interval must be a positive integer.');
    }
    if (!Number.isSafeInteger(maxActiveMs) || maxActiveMs <= 0) {
      throw new Error('Bridge active-polling window must be a positive integer.');
    }
    const startedAt = this.now();
    let maxWallElapsed = 0;
    let scheduledSleepMs = 0;
    for (;;) {
      throwIfAborted(options.signal);
      const status = await this.refresh();
      options.onUpdate?.(status);
      if (status.pollingStopped) return status;

      maxWallElapsed = Math.max(maxWallElapsed, this.now() - startedAt);
      const elapsed = Math.max(0, maxWallElapsed, scheduledSleepMs);
      if (elapsed >= maxActiveMs) return this.stopActivePolling(status);
      const delay = Math.min(intervalMs, maxActiveMs - elapsed, MAX_TIMER_DELAY_MS);
      scheduledSleepMs += delay;
      await this.sleep(delay, options.signal);
    }
  }

  discard(): void {
    this.store.clear();
  }

  private stopActivePolling(status: BridgeStatus): BridgeStatus {
    const record = this.resume();
    if (!record) throw new Error('No bridge deposit is available to resume.');
    const stopped: BridgeStatus = {
      ...status,
      pollingStopped: true,
      message: 'The deposit is still pending. Active polling stopped; you can leave and resume later.',
    };
    this.store.save({ ...record, status: stopped, updatedAt: this.now() });
    return stopped;
  }

  private verifyRecord(record: BridgeRecord): void {
    const input: CreateDepositInput = {
      source: record.source,
      amountIn: record.amountIn,
      starknetRecipient: record.starknetRecipient,
      refundAddress: record.refundAddress,
      slippageBps: record.signedQuote.quoteRequest.slippageTolerance,
    };
    validateInput(input);
    assertSignedQuote(record.signedQuote, input, record.signedQuote.quoteRequest);
    if (!this.quoteVerifier(record.signedQuote)) {
      throw new Error('1Click quote signature verification failed.');
    }
  }

  private verifyStatusQuote(raw: { quoteResponse: QuoteResponse }, record: BridgeRecord): void {
    if (
      raw.quoteResponse.correlationId !== record.signedQuote.correlationId ||
      raw.quoteResponse.signature !== record.signedQuote.signature
    ) {
      throw new Error('1Click status did not match the persisted signed quote.');
    }
    const input: CreateDepositInput = {
      source: record.source,
      amountIn: record.amountIn,
      starknetRecipient: record.starknetRecipient,
      refundAddress: record.refundAddress,
      slippageBps: record.signedQuote.quoteRequest.slippageTolerance,
    };
    assertSignedQuote(raw.quoteResponse, input, record.signedQuote.quoteRequest);
    if (!this.quoteVerifier(raw.quoteResponse)) {
      throw new Error('1Click status quote signature verification failed.');
    }
  }
}

function sameSignedEvidence(left: BridgeRecord, right: BridgeRecord): boolean {
  return left.signedQuote.correlationId === right.signedQuote.correlationId &&
    left.signedQuote.signature === right.signedQuote.signature &&
    left.signedQuote.timestamp === right.signedQuote.timestamp;
}

function validateInput(input: CreateDepositInput): void {
  if (
    !input.source.assetId ||
    !input.source.symbol ||
    !Number.isSafeInteger(input.source.decimals) ||
    input.source.decimals < 0 ||
    input.source.decimals > 36
  ) {
    throw new Error('The source asset metadata is invalid.');
  }
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

function assertSignedQuote(
  response: QuoteResponse,
  input: CreateDepositInput,
  request: QuoteRequest,
): void {
  if (!response.signature || !response.timestamp || !response.correlationId) {
    throw new Error('1Click returned no signed quote dispute evidence.');
  }
  if (!Number.isFinite(Date.parse(response.timestamp))) {
    throw new Error('1Click returned an invalid signed quote timestamp.');
  }
  if (!response.quote.depositAddress) throw new Error('1Click returned no deposit address.');
  if (
    !response.quote.deadline ||
    response.quote.deadline !== request.deadline ||
    !Number.isFinite(Date.parse(response.quote.deadline))
  ) {
    throw new Error('1Click returned an invalid quote deadline.');
  }
  if (
    !Number.isSafeInteger(response.quoteRequest.slippageTolerance) ||
    response.quoteRequest.slippageTolerance < 1 ||
    response.quoteRequest.slippageTolerance > 1_000
  ) {
    throw new Error('1Click returned invalid quote slippage.');
  }
  if (response.quoteRequest.destinationAsset !== STRK_ON_STARKNET_ASSET_ID) {
    throw new Error('1Click quote destination was not Starknet STRK.');
  }
  if (
    response.quote.amountIn !== input.amountIn.toString() ||
    !isPositiveDecimal(response.quote.amountOut) ||
    !isPositiveDecimal(response.quote.minAmountOut) ||
    BigInt(response.quote.minAmountOut) > BigInt(response.quote.amountOut) ||
    !Number.isFinite(response.quote.timeEstimate) ||
    response.quote.timeEstimate < 0
  ) {
    throw new Error('1Click returned invalid executable quote amounts.');
  }
  if (
    response.quoteRequest.originAsset !== input.source.assetId ||
    response.quoteRequest.amount !== input.amountIn.toString() ||
    response.quoteRequest.recipient !== input.starknetRecipient ||
    response.quoteRequest.refundTo !== input.refundAddress ||
    response.quoteRequest.deadline !== request.deadline ||
    response.quoteRequest.swapType !== 'EXACT_INPUT' ||
    response.quoteRequest.depositType !== 'ORIGIN_CHAIN' ||
    response.quoteRequest.refundType !== 'ORIGIN_CHAIN' ||
    response.quoteRequest.recipientType !== 'DESTINATION_CHAIN' ||
    response.quoteRequest.slippageTolerance !== request.slippageTolerance ||
    response.quoteRequest.depositMode !== request.depositMode ||
    response.quoteRequest.dry !== false
  ) {
    throw new Error('1Click signed quote did not match the requested route.');
  }
}

function isPositiveDecimal(value: string): boolean {
  return /^[1-9][0-9]*$/.test(value);
}

function quoteExpired(record: BridgeRecord, now: number): boolean {
  const rawDeadline = record.signedQuote.quote.deadline;
  if (!rawDeadline) return false;
  const deadline = Date.parse(rawDeadline);
  return Number.isFinite(deadline) && now >= deadline;
}

function mapStatus(raw: {
  status: string;
  swapDetails: GetExecutionStatusResponse['swapDetails'];
}): BridgeStatus {
  switch (String(raw.status)) {
    case 'PENDING_DEPOSIT':
      return { leg: 'awaiting-deposit', message: 'Waiting for the origin deposit.', pollingStopped: false };
    case 'KNOWN_DEPOSIT_TX':
    case 'INCOMPLETE_DEPOSIT':
      return {
        leg: 'deposit-detected',
        depositTxHash: firstTransactionHash(raw.swapDetails.originChainTxHashes),
        message: String(raw.status) === 'INCOMPLETE_DEPOSIT'
          ? 'A deposit was detected but is below the quoted amount.'
          : 'Deposit detected; waiting for the solver.',
        pollingStopped: false,
      };
    case 'PROCESSING':
      return {
        leg: 'solver-settling',
        depositTxHash: firstTransactionHash(raw.swapDetails.originChainTxHashes),
        message: 'The solver is delivering STRK to Starknet.',
        pollingStopped: false,
      };
    case 'SUCCESS':
      {
        const strkReceived = parseSettlementAmount(raw.swapDetails.amountOut);
        const settlementTxHash = firstTransactionHash(
          raw.swapDetails.destinationChainTxHashes,
        );
        return {
          leg: 'settled',
          depositTxHash: firstTransactionHash(raw.swapDetails.originChainTxHashes),
          settlementTxHash,
          strkReceived,
          message: 'STRK arrived publicly. Shielding is the separate next step.',
          pollingStopped: true,
        };
      }
    case 'REFUNDED':
      return {
        leg: 'failed',
        depositTxHash: firstTransactionHash(raw.swapDetails.originChainTxHashes),
        message: 'The bridge did not settle and 1Click reports a refund.',
        pollingStopped: true,
      };
    case 'FAILED':
      return {
        leg: 'failed',
        message: 'The bridge could not complete. Keep the signed quote for support.',
        pollingStopped: true,
      };
    default:
      throw new Error('1Click returned an unknown execution status.');
  }
}

function firstTransactionHash(entries: unknown): string | undefined {
  if (!Array.isArray(entries)) throw invalidExecutionStatus();
  const first = entries[0];
  if (first === undefined) return undefined;
  if (!first || typeof first !== 'object' || !('hash' in first)) {
    throw invalidExecutionStatus();
  }
  return boundedTransactionHash(first.hash);
}

function boundedTransactionHash(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_TRANSACTION_HASH_LENGTH ||
    /\s/.test(value)
  ) {
    throw invalidExecutionStatus();
  }
  return value;
}

function parseSettlementAmount(value: unknown): bigint {
  if (
    typeof value !== 'string' ||
    !/^[1-9][0-9]*$/.test(value) ||
    value.length > MAX_BASE_UNIT_AMOUNT_DIGITS
  ) {
    throw invalidExecutionStatus();
  }
  const amount = BigInt(value);
  if (amount > MAX_BASE_UNIT_AMOUNT) throw invalidExecutionStatus();
  return amount;
}

function invalidExecutionStatus(): Error {
  return new Error(INVALID_EXECUTION_STATUS_MESSAGE);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    throwIfAborted(signal);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
