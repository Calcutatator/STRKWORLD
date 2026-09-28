import {
  buildPrivateSwapFee,
  PaymasterRpcError,
  submitPrivateSwap,
  type AvnuOptions,
  type PrivateSwapCallAndProof,
} from '@avnu/avnu-sdk';
import { RelayNotConfiguredError } from './relay.js';
import type { PaymasterPort, PreparedArtifact } from './types.js';

interface AvnuFunctions {
  buildFee: typeof buildPrivateSwapFee;
  submit: typeof submitPrivateSwap;
}

export interface AvnuPaymasterOptions {
  apiKey?: string;
  paymasterBaseUrl?: string;
  functions?: AvnuFunctions;
}

/** The JSON-RPC code avnu answers a missing or invalid key with, among other failures. */
const UNKNOWN_ERROR = 163;

/**
 * AVNU sponsored-private apply_action adapter. Key stays server-side.
 *
 * avnu requires a Portal key for `sponsored_private` (D-070), so without one
 * this adapter never calls avnu, and avnu's own key rejection comes back as
 * the same `RelayNotConfiguredError`.
 */
export class AvnuPaymasterPort implements PaymasterPort {
  readonly configured: boolean;
  private readonly apiKey?: string;
  private readonly sdkOptions: AvnuOptions;
  private readonly functions: AvnuFunctions;

  constructor(options: AvnuPaymasterOptions = {}) {
    this.apiKey = options.apiKey;
    this.configured = typeof options.apiKey === 'string' && options.apiKey.length > 0;
    this.sdkOptions = options.paymasterBaseUrl
      ? { paymasterBaseUrl: options.paymasterBaseUrl }
      : {};
    this.functions = options.functions ?? {
      buildFee: buildPrivateSwapFee,
      submit: submitPrivateSwap,
    };
  }

  async buildFee(input: Parameters<PaymasterPort['buildFee']>[0]) {
    const paymasterApiKey = this.requireKey();
    try {
      return await this.functions.buildFee({
        poolAddress: input.poolAddress,
        feeMode: { poolFeeToken: input.feeToken },
        paymasterApiKey,
      }, { ...this.sdkOptions, abortSignal: input.signal });
    } catch (error) {
      throw keyRejected(error) ? new RelayNotConfiguredError() : error;
    }
  }

  async submit(input: Parameters<PaymasterPort['submit']>[0]) {
    const paymasterApiKey = this.requireKey();
    try {
      return await this.functions.submit({
        callAndProof: toAvnuArtifact(input.artifact),
        feeMode: { poolFeeToken: input.fee.token },
        paymasterApiKey,
      }, { ...this.sdkOptions, abortSignal: input.signal });
    } catch (error) {
      throw keyRejected(error) ? new RelayNotConfiguredError() : error;
    }
  }

  private requireKey(): string {
    if (!this.configured || this.apiKey === undefined) throw new RelayNotConfiguredError();
    return this.apiKey;
  }
}

/**
 * avnu refusing the key itself: code 163 with the key named in its data or
 * message ("x-paymaster-api-key is invalid"). avnu also answers 163 for an
 * outage or a blacklisted call, and those stay upstream failures.
 */
function keyRejected(error: unknown): boolean {
  if (!(error instanceof PaymasterRpcError) || error.code !== UNKNOWN_ERROR) return false;
  return /api[-_ ]?key/i.test(`${describe(error.data)} ${error.message}`);
}

function describe(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function toAvnuArtifact(artifact: PreparedArtifact): PrivateSwapCallAndProof {
  return {
    call: {
      contractAddress: artifact.call.contract_address,
      entrypoint: artifact.call.entry_point,
      calldata: artifact.call.calldata ?? [],
    },
    proof: {
      data: artifact.proof.data,
      proofFacts: artifact.proof.proof_facts,
    },
  };
}
