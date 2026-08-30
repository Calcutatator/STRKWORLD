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
  isUsableDepositAddress,
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
    const stableInput: CreateDepositInput = {
      ...input,
      source: { ...input.source },
    };
    if (this.resume()) {
      throw new Error('An existing bridge deposit is available. Discard it before creating a new deposit.');
    }
    validateInput(stableInput);
    const deadline = new Date(this.now() + QUOTE_DEADLINE_MS).toISOString();
    const request = {
      dry: false,
      ...(stableInput.source.chainName === 'stellar' ? { depositMode: 'MEMO' } : {}),
      swapType: 'EXACT_INPUT',
      slippageTolerance: stableInput.slippageBps ?? DEFAULT_SLIPPAGE_BPS,
      originAsset: stableInput.source.assetId,
      depositType: 'ORIGIN_CHAIN',
      destinationAsset: STRK_ON_STARKNET_ASSET_ID,
      amount: stableInput.amountIn.toString(),
      refundTo: stableInput.refundAddress,
      refundType: 'ORIGIN_CHAIN',
      recipient: stableInput.starknetRecipient,
      recipientType: 'DESTINATION_CHAIN',
      deadline,
    } as QuoteRequest;

    const signedQuote = await this.client.getQuote(request);
    assertSignedQuote(signedQuote, stableInput, request);
    if (!this.quoteVerifier(signedQuote)) {
      throw new Error('1Click quote signature verification failed.');
    }
    if (this.resume()) {
      throw new Error('An existing bridge deposit is available. Discard it before creating a new deposit.');
    }
    const now = this.now();
    const record: BridgeRecord = {
      v: 1,
      createdAt: now,
      updatedAt: now,
      source: { ...stableInput.source },
      amountIn: stableInput.amountIn,
      starknetRecipient: stableInput.starknetRecipient,
      refundAddress: stableInput.refundAddress,
      signedQuote,
      status: {
        leg: 'awaiting-deposit',
        message: stableInput.source.depositMode === 'signed'
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
    if (typeof txHash !== 'string' || txHash.length === 0 || txHash.length > 256 || /\s/.test(txHash)) {
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
    if (retained && samePersistedVersion(retained, record)) {
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
    return (await this.refreshRecord(record)).status;
  }

  private async refreshRecord(record: BridgeRecord): Promise<{
    status: BridgeStatus;
    persisted: BridgeRecord | null;
  }> {
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
    if (retained && samePersistedVersion(retained, record)) {
      const persisted = { ...retained, status, updatedAt: this.now() };
      this.store.save(persisted);
      return { status, persisted };
    }
    return { status, persisted: null };
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
    let owned = this.resume();
    if (!owned) throw new Error('No bridge deposit is available to resume.');
    let maxWallElapsed = 0;
    let scheduledSleepMs = 0;
    for (;;) {
      throwIfAborted(options.signal);
      const retained = this.resume();
      if (!retained || !samePersistedVersion(retained, owned)) {
        return stoppedPollingStatus(owned.status);
      }
      const refreshed = await this.refreshRecord(owned);
      const status = refreshed.status;
      options.onUpdate?.(status);
      if (status.pollingStopped) return status;
      if (!refreshed.persisted) return stoppedPollingStatus(status);
      owned = refreshed.persisted;

      const current = this.resume();
      if (!current || !samePersistedVersion(current, owned)) {
        return stoppedPollingStatus(status);
      }

      maxWallElapsed = Math.max(maxWallElapsed, this.now() - startedAt);
      const elapsed = Math.max(0, maxWallElapsed, scheduledSleepMs);
      if (elapsed >= maxActiveMs) return this.stopActivePolling(status, owned);
      const delay = Math.min(intervalMs, maxActiveMs - elapsed, MAX_TIMER_DELAY_MS);
      scheduledSleepMs += delay;
      await this.sleep(delay, options.signal);
    }
  }

  discard(): void {
    this.store.clear();
  }

  private stopActivePolling(status: BridgeStatus, owned: BridgeRecord): BridgeStatus {
    const stopped = stoppedPollingStatus(status);
    const retained = this.resume();
    if (retained && samePersistedVersion(retained, owned)) {
      this.store.save({ ...retained, status: stopped, updatedAt: this.now() });
    }
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

  private verifyStatusQuote(
    raw: {
      quoteResponse: QuoteResponse;
      status: unknown;
      swapDetails: GetExecutionStatusResponse['swapDetails'];
    },
    record: BridgeRecord,
  ): void {
    if (
      !isRecord(raw) ||
      !hasOwnDataProperty(raw, 'quoteResponse') ||
      !hasOwnDataProperty(raw, 'status') ||
      !hasOwnDataProperty(raw, 'swapDetails') ||
      typeof raw.status !== 'string' ||
      !isStatusQuoteResponse(raw.quoteResponse)
    ) throw invalidExecutionStatus();
    const quoteResponse = raw.quoteResponse;
    if (
      quoteResponse.correlationId !== record.signedQuote.correlationId ||
      quoteResponse.signature !== record.signedQuote.signature
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
    assertSignedQuote(quoteResponse, input, record.signedQuote.quoteRequest);
    if (!this.quoteVerifier(quoteResponse)) {
      throw new Error('1Click status quote signature verification failed.');
    }
  }
}

function stoppedPollingStatus(status: BridgeStatus): BridgeStatus {
  return {
    ...status,
    pollingStopped: true,
    message: 'The deposit is still pending. Active polling stopped; you can leave and resume later.',
  };
}

function samePersistedVersion(left: BridgeRecord, right: BridgeRecord): boolean {
  return serializeBridgeRecord(left) === serializeBridgeRecord(right);
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
  if (input.amountIn <= 0n || input.amountIn > MAX_BASE_UNIT_AMOUNT) {
    throw new Error('Bridge amount must be a positive uint256.');
  }
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
  if (!hasSignedQuoteShape(response)) {
    throw new Error('1Click returned invalid signed quote data.');
  }
  if (!response.signature || !response.timestamp || !response.correlationId) {
    throw new Error('1Click returned no signed quote dispute evidence.');
  }
  if (!Number.isFinite(Date.parse(response.timestamp))) {
    throw new Error('1Click returned an invalid signed quote timestamp.');
  }
  if (!isUsableDepositAddress(response.quote.depositAddress)) {
    throw new Error('1Click returned an invalid deposit address.');
  }
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
  if (!first || typeof first !== 'object' || Array.isArray(first)) {
    throw invalidExecutionStatus();
  }
  const hash = Object.getOwnPropertyDescriptor(first, 'hash');
  if (!hash || !('value' in hash)) throw invalidExecutionStatus();
  return boundedTransactionHash(hash.value);
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

function isStatusQuoteResponse(value: unknown): value is QuoteResponse {
  if (!isRecord(value)) return false;
  const response = value as { quote?: unknown; quoteRequest?: unknown };
  return Boolean(
    isRecord(response.quote) && isRecord(response.quoteRequest),
  );
}

function hasSignedQuoteShape(value: unknown): value is QuoteResponse {
  if (
    !isRecord(value) ||
    !hasOwnDataProperties(value, ['signature', 'timestamp', 'correlationId', 'quote', 'quoteRequest']) ||
    !isRecord(value.quote) ||
    !isRecord(value.quoteRequest) ||
    !hasOwnDataProperties(value.quote, [
      'depositAddress', 'deadline', 'amountIn', 'amountOut', 'minAmountOut', 'timeEstimate',
    ]) ||
    !hasOwnDataProperties(value.quoteRequest, [
      'slippageTolerance', 'destinationAsset', 'originAsset', 'amount', 'recipient',
      'refundTo', 'deadline', 'swapType', 'depositType', 'refundType', 'recipientType',
      'dry',
    ])
  ) return false;
  if ('depositMemo' in value.quote && !hasOwnDataProperty(value.quote, 'depositMemo')) return false;
  if (
    hasOwnDataProperty(value.quote, 'depositMemo') &&
    value.quote.depositMemo !== undefined &&
    typeof value.quote.depositMemo !== 'string'
  ) return false;
  if ('depositMode' in value.quoteRequest && !hasOwnDataProperty(value.quoteRequest, 'depositMode')) return false;
  return true;
}

function hasOwnDataProperties(value: unknown, keys: readonly PropertyKey[]): value is Record<string, unknown> {
  return isRecord(value) && keys.every((key) => hasOwnDataProperty(value, key));
}

function hasOwnDataProperty(value: object, key: PropertyKey): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return Boolean(descriptor && 'value' in descriptor);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
