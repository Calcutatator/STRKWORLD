/**
 * Public types for the Bridge building.
 *
 * ONE PATH: any asset on any supported chain → STRK on Starknet → the STRK20
 * pool. No direction toggle, no destination token choice, no route options.
 *
 * Note the pool step is NOT this package's job. The shell sequences it, because
 * pool deposits are always-to-self and must be signed by the player. See
 * README.md — "the two-transaction truth".
 *
 * Amounts are `bigint`, as everywhere that touches value.
 */

/**
 * How the player funds the origin side.
 *
 * `signed` — the player signs a deposit in a connected wallet on that chain.
 * `manual` — the player goes to an exchange withdrawal screen and we poll for
 *            arrival. This is the common case for funding from a centralised
 *            exchange, so it is the path to design for first, not an edge case.
 */
export type DepositMode = 'signed' | 'manual';

import type { QuoteResponse } from '@defuse-protocol/one-click-sdk-typescript';

export type SourceChain =
  | 'near'
  | 'ethereum'
  | 'base'
  | 'arbitrum'
  | 'polygon'
  | 'bsc'
  | 'abstract'
  | 'gnosis'
  | 'berachain'
  | 'monad'
  | 'xlayer'
  | 'plasma'
  | 'optimism'
  | 'avalanche'
  | 'adi'
  | 'scroll'
  | 'hypercore'
  | 'solana'
  | 'fogo'
  | 'sui'
  | 'movement'
  | 'aptos'
  | 'bitcoin'
  | 'bitcoin-cash'
  | 'litecoin'
  | 'dogecoin'
  | 'dash'
  | 'zcash'
  | 'xrp'
  | 'cardano'
  | 'aleo'
  | 'stellar'
  | 'ton'
  | 'tron';

/** An asset a player can deposit from. The destination is always STRK. */
export interface SourceAsset {
  /** 1Click asset identifier. */
  assetId: string;
  symbol: string;
  chainName: SourceChain;
  decimals: number;
  depositMode: DepositMode;
  /** Whether this entry was confirmed in the current registry response. */
  availability?: 'live' | 'fallback';
}

export interface BridgeQuote {
  source: SourceAsset;
  amountIn: bigint;
  /** STRK the solver expects to deliver. An estimate — present it as one. */
  strkOutEstimate: bigint;
  /** Where the player sends funds on the origin chain. */
  depositAddress: string;
  /** Past this, re-quote rather than submitting. */
  expiresAt: number;
  slippageBps: number;
  /** Complete signed response retained as dispute evidence. */
  signedQuote: QuoteResponse;
}

/**
 * A deposit is multi-leg and takes minutes. Every leg is persisted so the flow
 * survives a reload, a tab close or a crash — with manual mode the player is
 * expected to leave, and they must find the deposit still in progress when
 * they return.
 *
 * `settled` means STRK has landed publicly at the player's address. The
 * shielding step that follows belongs to the shell, not to this package.
 */
export type BridgeLeg =
  | 'quoted'
  | 'awaiting-deposit'
  | 'deposit-detected'
  | 'solver-settling'
  | 'settled'
  | 'failed'
  | 'expired';

export interface BridgeStatus {
  leg: BridgeLeg;
  /** Present once the origin-side deposit is on chain. */
  depositTxHash?: string;
  /** Present once STRK has landed on Starknet. */
  settlementTxHash?: string;
  /** STRK actually delivered. Known only at `settled`. */
  strkReceived?: bigint;
  /** Already mapped from solver states. Never surface a raw solver string. */
  message: string;
  /**
   * True once active polling has stopped. Distinct from `failed`: this means
   * "still working, come back later", not "this will not complete". The UI
   * must not conflate them — one is a wait, the other is a loss.
   */
  pollingStopped: boolean;
}

/** Versioned, resumable bridge state. Safe for browser-local persistence. */
export interface BridgeRecord {
  v: 1;
  createdAt: number;
  updatedAt: number;
  source: SourceAsset;
  amountIn: bigint;
  starknetRecipient: string;
  refundAddress: string;
  signedQuote: QuoteResponse;
  status: BridgeStatus;
}
