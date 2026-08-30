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
    return {
      feeAmount: asUint256(ownField(record, 'feeAmount')),
      feeToken: asString(ownField(record, 'feeToken')),
      proofValidityBlocks: asInteger(ownField(record, 'proofValidityBlocks')),
      noteMaturityBlocks: asInteger(ownField(record, 'noteMaturityBlocks')),
    };
  }

  async publicKey(address: string, signal?: AbortSignal): Promise<string> {
    const raw = await this.post('/v1/rpc/public-key', { v: 1, address }, signal);
    throwIfAborted(signal);
    const value = asRecord(raw);
    return asString(ownField(value, 'publicKey'));
  }

  async estimate(input: Parameters<PrivateSubmissionGateway['estimate']>[0]): Promise<RelayFeeQuote> {
    const raw = await this.post('/v1/private/fees', {
      v: 1,
      route: input.route,
      feeToken: input.feeToken,
      operationToken: input.operationToken,
    }, input.signal);
    throwIfAborted(input.signal);
    const value = asRecord(raw);
    return {
      token: asString(ownField(value, 'token')),
      recipient: asString(ownField(value, 'recipient')),
      amount: BigInt(asString(ownField(value, 'amount'))),
      authorization: asString(ownField(value, 'authorization')),
      expiresAtBlock: asInteger(ownField(value, 'expiresAtBlock')),
    };
  }

  async submit(input: Parameters<PrivateSubmissionGateway['submit']>[0]): Promise<TxResult> {
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
    const result = { transactionHash };
    input.onAccepted?.(result);
    return result;
  }

  async prepareSwap(
    input: NonNullable<PrivateSubmissionGateway['prepareSwap']> extends (...args: infer A) => unknown
      ? A[0]
      : never,
  ): Promise<PreparedPrivateSwap> {
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
    return {
      quoteId: asString(ownField(value, 'quoteId')),
      buyAmount: BigInt(asString(ownField(value, 'buyAmount'))),
      expiresAt: asInteger(ownField(value, 'expiresAt')),
      chainId: asString(ownField(value, 'chainId')),
      executorAddress: asString(ownField(value, 'executorAddress')),
      executorCalls: rawCalls.map((raw) => {
        const call = asRecord(raw);
        return {
          contractAddress: asString(ownField(call, 'contractAddress')),
          entrypoint: asString(ownField(call, 'entrypoint')),
          calldata: asArray(ownField(call, 'calldata')).map(asString),
        };
      }),
      fee: {
        token: asString(ownField(fee, 'token')),
        recipient: asString(ownField(fee, 'recipient')),
        amount: BigInt(asString(ownField(fee, 'amount'))),
        authorization: asString(ownField(fee, 'authorization')),
        expiresAtBlock: asInteger(ownField(fee, 'expiresAtBlock')),
      },
    };
  }

  private async post(
    path: string,
    body: unknown,
    signal?: AbortSignal,
    transportFailureKind: PrivacyErrorKind = 'unreachable',
  ): Promise<unknown> {
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
      throw new PrivacyError(
        transportFailureKind,
        transportFailureKind === 'submission-uncertain'
          ? 'The private submission response was lost.'
          : 'The private service could not be reached.',
        error,
      );
    }
    if (!response.ok) {
      const failure = await response.json().catch(() => null) as { message?: unknown } | null;
      throw new PrivacyError(
        response.status === 503 ? 'unreachable' : 'unknown',
        typeof failure?.message === 'string' ? failure.message : 'The private service rejected the request.',
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

function asString(value: unknown): string {
  if (typeof value !== 'string') {
    throw new PrivacyError('unknown', 'The private service returned an invalid response.');
  }
  return value;
}

function asInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new PrivacyError('unknown', 'The private service returned an invalid response.');
  }
  return value;
}

function asArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new PrivacyError('unknown', 'The private service returned an invalid response.');
  }
  return value;
}
