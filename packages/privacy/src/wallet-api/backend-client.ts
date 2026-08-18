import { PrivacyError, type PrivacyErrorKind, type TxResult } from '../types.js';
import type { PoolConfig } from '../operations.js';
import type {
  PoolReadClient,
  PrivateSubmissionGateway,
  PreparedPrivateSwap,
  RelayFeeQuote,
} from './types.js';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Browser client for the narrow, no-logging backend API. */
export class BackendPrivacyClient implements PoolReadClient, PrivateSubmissionGateway {
  constructor(
    private readonly baseUrl: string,
    private readonly fetcher: FetchLike = fetch,
  ) {}

  async config(signal?: AbortSignal): Promise<PoolConfig> {
    const value = await this.post('/v1/rpc/pool-config', { v: 1 }, signal);
    const record = asRecord(value);
    return {
      feeAmount: BigInt(asString(record.feeAmount)),
      feeToken: asString(record.feeToken),
      proofValidityBlocks: asInteger(record.proofValidityBlocks),
      noteMaturityBlocks: asInteger(record.noteMaturityBlocks),
    };
  }

  async publicKey(address: string, signal?: AbortSignal): Promise<string> {
    const value = asRecord(await this.post('/v1/rpc/public-key', { v: 1, address }, signal));
    return asString(value.publicKey);
  }

  async estimate(input: Parameters<PrivateSubmissionGateway['estimate']>[0]): Promise<RelayFeeQuote> {
    const value = asRecord(await this.post('/v1/private/fees', {
      v: 1,
      route: input.route,
      feeToken: input.feeToken,
      operationToken: input.operationToken,
    }, input.signal));
    return {
      token: asString(value.token),
      recipient: asString(value.recipient),
      amount: BigInt(asString(value.amount)),
      authorization: asString(value.authorization),
      expiresAtBlock: asInteger(value.expiresAtBlock),
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
    const result = { transactionHash: asString(value.transactionHash) };
    input.onAccepted?.(result);
    return result;
  }

  async prepareSwap(
    input: NonNullable<PrivateSubmissionGateway['prepareSwap']> extends (...args: infer A) => unknown
      ? A[0]
      : never,
  ): Promise<PreparedPrivateSwap> {
    const value = asRecord(await this.post('/v1/private/swaps/prepare', {
      v: 1,
      sellToken: input.sellToken,
      buyToken: input.buyToken,
      sellAmount: input.sellAmount.toString(),
      minAmountOut: input.minAmountOut.toString(),
      slippageBps: input.slippageBps,
    }, input.signal));
    const fee = asRecord(value.fee);
    const rawCalls = asArray(value.executorCalls);
    return {
      quoteId: asString(value.quoteId),
      buyAmount: BigInt(asString(value.buyAmount)),
      expiresAt: asInteger(value.expiresAt),
      chainId: asString(value.chainId),
      executorAddress: asString(value.executorAddress),
      executorCalls: rawCalls.map((raw) => {
        const call = asRecord(raw);
        return {
          contractAddress: asString(call.contractAddress),
          entrypoint: asString(call.entrypoint),
          calldata: asArray(call.calldata).map(asString),
        };
      }),
      fee: {
        token: asString(fee.token),
        recipient: asString(fee.recipient),
        amount: BigInt(asString(fee.amount)),
        authorization: asString(fee.authorization),
        expiresAtBlock: asInteger(fee.expiresAtBlock),
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

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PrivacyError('unknown', 'The private service returned an invalid response.');
  }
  return value as Record<string, unknown>;
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
