import {
  buildPrivateSwapFee,
  submitPrivateSwap,
  type AvnuOptions,
  type PrivateSwapCallAndProof,
} from '@avnu/avnu-sdk';
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

/** AVNU sponsored-private apply_action adapter. Key stays server-side. */
export class AvnuPaymasterPort implements PaymasterPort {
  private readonly apiKey?: string;
  private readonly sdkOptions: AvnuOptions;
  private readonly functions: AvnuFunctions;

  constructor(options: AvnuPaymasterOptions = {}) {
    this.apiKey = options.apiKey;
    this.sdkOptions = options.paymasterBaseUrl
      ? { paymasterBaseUrl: options.paymasterBaseUrl }
      : {};
    this.functions = options.functions ?? {
      buildFee: buildPrivateSwapFee,
      submit: submitPrivateSwap,
    };
  }

  async buildFee(input: Parameters<PaymasterPort['buildFee']>[0]) {
    return this.functions.buildFee({
      poolAddress: input.poolAddress,
      feeMode: { poolFeeToken: input.feeToken },
      paymasterApiKey: this.apiKey,
    }, { ...this.sdkOptions, abortSignal: input.signal });
  }

  async submit(input: Parameters<PaymasterPort['submit']>[0]) {
    return this.functions.submit({
      callAndProof: toAvnuArtifact(input.artifact),
      feeMode: { poolFeeToken: input.fee.token },
      paymasterApiKey: this.apiKey,
    }, { ...this.sdkOptions, abortSignal: input.signal });
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
