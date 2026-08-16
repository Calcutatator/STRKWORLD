import type {
  STRK20_ACTION,
  STRK20_BALANCE_ENTRY,
  STRK20_CALL_AND_PROOF,
} from 'starknet';
import type { PoolConfig } from '../operations.js';
import type { Address, TxResult } from '../types.js';

/** Structural slice of WalletAccountV6 used by STRKWORLD. */
export interface WalletStrk20Account {
  readonly address: Address;
  strk20Balances(tokens: Address[]): Promise<STRK20_BALANCE_ENTRY[]>;
  strk20PrepareInvoke(
    actions: STRK20_ACTION[],
    simulate?: boolean,
  ): Promise<STRK20_CALL_AND_PROOF>;
  strk20InvokeTransaction(actions: STRK20_ACTION[]): Promise<{ transaction_hash: string }>;
}

/** Backend-proxied pool reads. No viewing key or private state crosses it. */
export interface PoolReadClient {
  config(signal?: AbortSignal): Promise<PoolConfig>;
  publicKey(address: Address, signal?: AbortSignal): Promise<string>;
}

export type PoolNativeRoute = 'unshield' | 'transfer';

export interface RelayFeeQuote {
  token: Address;
  recipient: Address;
  amount: bigint;
}

export interface PrivateSubmissionGateway {
  estimate(input: {
    route: PoolNativeRoute;
    feeToken: Address;
    operationToken: Address;
    signal?: AbortSignal;
  }): Promise<RelayFeeQuote>;
  submit(input: {
    route: PoolNativeRoute;
    artifact: STRK20_CALL_AND_PROOF;
    proofValidityBlocks: number;
    signal?: AbortSignal;
  }): Promise<TxResult>;
}

export interface WalletRoutePolicy {
  maxIntents: number;
  maxRelayFee: bigint;
  enabledRoutes: readonly ('shield' | 'unshield' | 'transfer' | 'swap')[];
}

export type SupportedVersionsReader = (signal?: AbortSignal) => Promise<readonly string[]>;
