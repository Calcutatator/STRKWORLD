import { PrivacyError, type TxResult } from '../types.js';
import type { PoolConfig } from '../operations.js';
import type {
  PoolReadClient,
  PrivateSubmissionGateway,
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
    }, input.signal));
    return { transactionHash: asString(value.transactionHash) };
  }

  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      throw new PrivacyError('unreachable', 'The private service could not be reached.', error);
    }
    if (!response.ok) {
      const failure = await response.json().catch(() => null) as { message?: unknown } | null;
      throw new PrivacyError(
        response.status === 503 ? 'unreachable' : 'unknown',
        typeof failure?.message === 'string' ? failure.message : 'The private service rejected the request.',
      );
    }
    return response.json();
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
