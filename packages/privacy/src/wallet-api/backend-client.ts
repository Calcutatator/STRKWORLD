import { PrivacyError, type PrivacyErrorKind, type TxResult } from '../types.js';
import type { PoolConfig } from '../operations.js';
import type {
  PoolReadClient,
  PrivateSubmissionGateway,
  PreparedPrivateSwap,
  RelayFeeQuote,
} from './types.js';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
const STARK_FIELD_PRIME = (1n << 251n) + 17n * (1n << 192n) + 1n;
const MAX_UINT256 = (1n << 256n) - 1n;

/** Browser client for the narrow, no-logging backend API. */
export class BackendPrivacyClient implements PoolReadClient, PrivateSubmissionGateway {
  private readonly baseUrl: string;
  private readonly fetcher: FetchLike;

  constructor(
    baseUrl: string,
    fetcher?: FetchLike,
  ) {
    if (typeof baseUrl !== 'string' || baseUrl.trim().length === 0) {
      throw new PrivacyError('unknown', 'The private service URL is invalid.');
    }
    this.baseUrl = baseUrl;
    // Window fetch is a Web IDL method and rejects a non-Window receiver.
    // Calling it through this object's property would bind `this` to the
    // client, so retain injected fakes unchanged and bind the browser default
    // to the global receiver at the boundary.
    this.fetcher = fetcher ?? globalThis.fetch.bind(globalThis);
  }

  async config(signal?: AbortSignal): Promise<PoolConfig> {
    const value = await this.post('/v1/rpc/pool-config', { v: 1 }, signal);
    throwIfAborted(signal);
    const record = asRecord(value);
    return Object.freeze({
      feeAmount: asUint256(ownField(record, 'feeAmount')),
      feeToken: asFelt(ownField(record, 'feeToken')),
      proofValidityBlocks: asIntegerAtLeast(ownField(record, 'proofValidityBlocks'), 1),
      noteMaturityBlocks: asIntegerAtLeast(ownField(record, 'noteMaturityBlocks'), 0),
    });
  }

  async publicKey(address: string, signal?: AbortSignal): Promise<string> {
    if (typeof address !== 'string' || !isNonzeroFelt(address)) {
      throw new PrivacyError('unknown', 'The public-key address is invalid.');
    }
    const raw = await this.post('/v1/rpc/public-key', { v: 1, address }, signal);
    throwIfAborted(signal);
    const value = asRecord(raw);
    return asString(ownField(value, 'publicKey'));
  }

  async estimate(input: Parameters<PrivateSubmissionGateway['estimate']>[0]): Promise<RelayFeeQuote> {
    if (
      (input.route !== 'transfer' && input.route !== 'unshield')
      || typeof input.feeToken !== 'string'
      || !isNonzeroFelt(input.feeToken)
      || typeof input.operationToken !== 'string'
      || !isNonzeroFelt(input.operationToken)
    ) {
      throw new PrivacyError('unknown', 'The relay estimate request is invalid.');
    }
    const raw = await this.post('/v1/private/fees', {
      v: 1,
      route: input.route,
      feeToken: input.feeToken,
      operationToken: input.operationToken,
    }, input.signal);
    throwIfAborted(input.signal);
    const value = asRecord(raw);
    return Object.freeze({
      token: asString(ownField(value, 'token')),
      recipient: asString(ownField(value, 'recipient')),
      amount: asDecimalBigInt(ownField(value, 'amount')),
      authorization: asString(ownField(value, 'authorization')),
      expiresAtBlock: asInteger(ownField(value, 'expiresAtBlock')),
    });
  }

  async submit(input: Parameters<PrivateSubmissionGateway['submit']>[0]): Promise<TxResult> {
    if (
      !['transfer', 'unshield', 'swap'].includes(input.route)
      || !input.artifact
      || typeof input.artifact !== 'object'
      || Array.isArray(input.artifact)
      || typeof input.feeAuthorization !== 'string'
      || input.feeAuthorization.trim().length === 0
      || !Number.isSafeInteger(input.proofValidityBlocks)
      || input.proofValidityBlocks <= 0
    ) {
      throw new PrivacyError('unknown', 'The private submission request is invalid.');
    }
    const value = asRecord(await this.post('/v1/private/submissions', {
      v: 1,
      route: input.route,
      artifact: input.artifact,
      feeAuthorization: input.feeAuthorization,
      proofValidityBlocks: input.proofValidityBlocks,
    }, input.signal, 'submission-uncertain'));
    const transactionHash = asString(ownField(value, 'transactionHash'));
    if (!isNonzeroFelt(transactionHash)) {
      throw new PrivacyError('unknown', 'The private service returned an invalid response.');
    }
    const result = Object.freeze({ transactionHash });
    try {
      input.onAccepted?.(result);
    } catch {
      // Acceptance observers cannot turn a validated accepted transaction
      // back into a rejected promise and invite an unsafe retry.
    }
    return result;
  }

  async prepareSwap(
    input: NonNullable<PrivateSubmissionGateway['prepareSwap']> extends (...args: infer A) => unknown
      ? A[0]
      : never,
  ): Promise<PreparedPrivateSwap> {
    if (
      typeof input.sellToken !== 'string'
      || !isNonzeroFelt(input.sellToken)
      || typeof input.buyToken !== 'string'
      || !isNonzeroFelt(input.buyToken)
      || typeof input.sellAmount !== 'bigint'
      || input.sellAmount <= 0n
      || typeof input.minAmountOut !== 'bigint'
      || input.minAmountOut <= 0n
      || !Number.isSafeInteger(input.slippageBps)
      || input.slippageBps <= 0
    ) {
      throw new PrivacyError('unknown', 'The swap-prepare request is invalid.');
    }
    const raw = await this.post('/v1/private/swaps/prepare', {
      v: 1,
      sellToken: input.sellToken,
      buyToken: input.buyToken,
      sellAmount: input.sellAmount.toString(),
      minAmountOut: input.minAmountOut.toString(),
      slippageBps: input.slippageBps,
    }, input.signal);
    throwIfAborted(input.signal);
    const value = asRecord(raw);
    const fee = asRecord(ownField(value, 'fee'));
    const rawCalls = asArray(ownField(value, 'executorCalls'));
    const executorCalls = rawCalls.map((raw) => {
      const call = asRecord(raw);
      return Object.freeze({
        contractAddress: asString(ownField(call, 'contractAddress')),
        entrypoint: asString(ownField(call, 'entrypoint')),
        calldata: Object.freeze(asArray(ownField(call, 'calldata')).map(asString)) as string[],
      });
    });
    return Object.freeze({
      quoteId: asNonEmptyString(ownField(value, 'quoteId')),
      buyAmount: asPositiveDecimalBigInt(ownField(value, 'buyAmount')),
      expiresAt: asInteger(ownField(value, 'expiresAt')),
      chainId: asString(ownField(value, 'chainId')),
      executorAddress: asString(ownField(value, 'executorAddress')),
      executorCalls: Object.freeze(executorCalls) as PreparedPrivateSwap['executorCalls'],
      fee: Object.freeze({
        token: asString(ownField(fee, 'token')),
        recipient: asString(ownField(fee, 'recipient')),
        amount: asDecimalBigInt(ownField(fee, 'amount')),
        authorization: asString(ownField(fee, 'authorization')),
        expiresAtBlock: asInteger(ownField(fee, 'expiresAtBlock')),
      }),
    });
  }

  private async post(
    path: string,
    body: unknown,
    signal?: AbortSignal,
    transportFailureKind: PrivacyErrorKind = 'unreachable',
  ): Promise<unknown> {
    throwIfAborted(signal);
    let pendingResponse: Promise<Response>;
    try {
      pendingResponse = this.fetcher(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      throw new PrivacyError('unreachable', 'The private service could not be reached.', error);
    }
    let response: Response;
    try {
      response = await pendingResponse;
    } catch (error) {
      // Once a private submission has been dispatched, a missing response is
      // authoritative uncertainty even if the caller cancels concurrently.
      // Reclassifying it as cancellation would make an accepted transaction
      // look safely retryable.
      if (transportFailureKind !== 'submission-uncertain' && signal?.aborted) throwIfAborted(signal);
      throw new PrivacyError(
        transportFailureKind,
        transportFailureKind === 'submission-uncertain'
          ? 'The private submission response was lost.'
          : 'The private service could not be reached.',
        error,
      );
    }
    if (!ownResponseOk(response)) {
      const status = ownResponseStatus(response);
      let failure: unknown;
      try {
        failure = await response.json();
      } catch (error) {
        if (transportFailureKind === 'submission-uncertain') {
          throw new PrivacyError('submission-uncertain', 'The private submission response was lost.', error);
        }
        failure = null;
      }
      const message = readErrorMessage(failure);
      throw new PrivacyError(
        status === 503 ? 'unreachable' : 'unknown',
        message ?? 'The private service rejected the request.',
      );
    }
    try {
      return await response.json();
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new PrivacyError('unknown', 'The private service returned an invalid response.', error);
      }
      throw new PrivacyError(
        transportFailureKind,
        transportFailureKind === 'submission-uncertain'
          ? 'The private submission response was lost.'
          : 'The private service response was lost.',
        error,
      );
    }
  }
}

function ownResponseOk(response: Response): boolean {
  try {
    if (response instanceof Response) return response.ok;
  } catch {
    // Continue into descriptor-only validation for malformed implementations.
  }
  let current: object | null = response;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, 'ok');
    if (descriptor) {
      if ('value' in descriptor && typeof descriptor.value === 'boolean') return descriptor.value;
      break;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  throw new PrivacyError('unknown', 'The private service returned an invalid response.');
}

function ownResponseStatus(response: Response): number {
  try {
    if (response instanceof Response) return response.status;
  } catch {
    // Continue into descriptor-only validation for malformed implementations.
  }
  let current: object | null = response;
  while (current !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(current, 'status');
    if (descriptor) {
      if ('value' in descriptor && typeof descriptor.value === 'number') return descriptor.value;
      break;
    }
    current = Object.getPrototypeOf(current) as object | null;
  }
  throw new PrivacyError('unknown', 'The private service returned an invalid response.');
}

function readErrorMessage(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const descriptor = Object.getOwnPropertyDescriptor(value, 'message');
  return descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
    ? descriptor.value
    : null;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new PrivacyError('user-rejected', 'Operation cancelled.', signal.reason);
}

function isNonzeroFelt(value: string): boolean {
  return /^0x[0-9a-fA-F]{1,64}$/.test(value)
    && BigInt(value) > 0n
    && BigInt(value) < STARK_FIELD_PRIME;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PrivacyError('unknown', 'The private service returned an invalid response.');
  }
  return value as Record<string, unknown>;
}

function ownField(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !('value' in descriptor)) {
    throw new PrivacyError('unknown', 'The private service returned an invalid response.');
  }
  return descriptor.value;
}

function asUint256(value: unknown): bigint {
  const text = asString(value);
  if (!/^\d+$/.test(text)) {
    throw new PrivacyError('unknown', 'The private service returned an invalid response.');
  }
  let parsed: bigint;
  try {
    parsed = BigInt(text);
  } catch {
    throw new PrivacyError('unknown', 'The private service returned an invalid response.');
  }
  if (parsed < 0n || parsed > MAX_UINT256) {
    throw new PrivacyError('unknown', 'The private service returned an invalid response.');
  }
  return parsed;
}

function asFelt(value: unknown): string {
  const text = asString(value);
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(text)) {
    throw new PrivacyError('unknown', 'The private service returned an invalid response.');
  }
  let parsed: bigint;
  try {
    parsed = BigInt(text);
  } catch {
    throw new PrivacyError('unknown', 'The private service returned an invalid response.');
  }
  if (parsed >= STARK_FIELD_PRIME) {
    throw new PrivacyError('unknown', 'The private service returned an invalid response.');
  }
  return text;
}

function asDecimalBigInt(value: unknown): bigint {
  const text = asString(value);
  if (!/^\d+$/.test(text)) {
    throw new PrivacyError('unknown', 'The private service returned an invalid response.');
  }
  try {
    return BigInt(text);
  } catch {
    throw new PrivacyError('unknown', 'The private service returned an invalid response.');
  }
}

function asPositiveDecimalBigInt(value: unknown): bigint {
  const parsed = asDecimalBigInt(value);
  if (parsed <= 0n) {
    throw new PrivacyError('unknown', 'The private service returned an invalid response.');
  }
  return parsed;
}

function asString(value: unknown): string {
  if (typeof value !== 'string') {
    throw new PrivacyError('unknown', 'The private service returned an invalid response.');
  }
  return value;
}

function asNonEmptyString(value: unknown): string {
  const text = asString(value);
  if (text.length === 0) {
    throw new PrivacyError('unknown', 'The private service returned an invalid response.');
  }
  return text;
}

function asInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new PrivacyError('unknown', 'The private service returned an invalid response.');
  }
  return value;
}

function asIntegerAtLeast(value: unknown, minimum: number): number {
  const parsed = asInteger(value);
  if (parsed < minimum) {
    throw new PrivacyError('unknown', 'The private service returned an invalid response.');
  }
  return parsed;
}

function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new PrivacyError('unknown', 'The private service returned an invalid response.');
  }
  // `Array.prototype.map` skips holes (and invokes indexed accessors). A
  // sparse or accessor-backed response would become a different, partially
  // unchecked action/calldata list after parsing.
  let length: number;
  try {
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (
      !lengthDescriptor
      || !('value' in lengthDescriptor)
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
      || Reflect.ownKeys(value).length !== lengthDescriptor.value + 1
    ) {
      throw new PrivacyError('unknown', 'The private service returned an invalid response.');
    }
    length = lengthDescriptor.value as number;
  } catch (error) {
    if (error instanceof PrivacyError) throw error;
    throw new PrivacyError('unknown', 'The private service returned an invalid response.', error);
  }
  const owned: unknown[] = [];
  try {
    for (let index = 0; index < length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor)) {
        throw new Error('invalid response array item');
      }
      owned.push(descriptor.value);
    }
  } catch (error) {
    throw new PrivacyError('unknown', 'The private service returned an invalid response.', error);
  }
  return owned;
}
