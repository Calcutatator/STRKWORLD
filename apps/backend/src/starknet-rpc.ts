import {
  ASSET_CONFIG_SELECTOR,
  BORROW_PAIRS,
  BORROW_POOL,
  BORROW_TOKENS,
  PAIR_CONFIG_SELECTOR,
  PAIRS_SELECTOR,
  POSITION_SELECTOR,
  PRICE_SELECTOR,
} from './borrow.js';
import type {
  BorrowAssetRead,
  BorrowMarketRead,
  BorrowPairRead,
  BorrowPositionRead,
  BorrowRpcPort,
  ChainHead,
  EndurRequestRead,
  EndurRpcPort,
  EndurUnstakeRead,
  PoolEventsFilter,
  PoolEventsPage,
  PoolRpcPort,
  PoolStatsRpcPort,
  ShadowAccountRead,
  VaultPositionRead,
  VaultRpcPort,
} from './types.js';
import { isFelt } from './validation.js';
import {
  GET_SHADOW_ACCOUNTS_SELECTOR,
  MAX_REDEEM_SELECTOR,
  MAX_WITHDRAW_SELECTOR,
  PREVIEW_REDEEM_SELECTOR,
  SHADOW_ACCOUNT_ANONYMIZER,
  VESU_VAULTS,
} from './vault.js';
import {
  ENDUR_EVENTS_CHUNK_SIZE,
  ENDUR_SCAN_MAX_PAGES,
  ENDUR_SCAN_WINDOW_BLOCKS,
  ENDUR_UNSTAKE_FIRST_BLOCK,
  ENDUR_WITHDRAWAL_QUEUE,
  ENDUR_XSTRK,
  ENDUR_XSTRK_ASSET,
  CLAIM_WITHDRAWAL_SELECTOR,
  CONVERT_TO_ASSETS_SELECTOR,
  GET_REQUEST_INFO_SELECTOR,
  MAX_ENDUR_CLAIM_DRY_RUNS,
  MAX_ENDUR_REQUESTS,
  ONE_XSTRK,
  WITHDRAW_QUEUE_EVENT_KEY,
} from './endur.js';
import { COUNT_OF_SELECTOR, type LeaderboardRpcPort, type LeaderboardShadowRead } from './leaderboard.js';

const FEE_SELECTOR = '0x3d323cd692ad43935b81ce230c47bfc57f69656249c5a33fe5223c17dd32ed2';
const PUBLIC_KEY_SELECTOR = '0x1a35984e05126dbecb7c3bb9929e7dd9106d460c59b1633739a5c733a5fb13b';
const PROOF_VALIDITY_SELECTOR = '0x11d6d65b366023adbdaeaa04008285431f4509d78e78cda7067e58fbba35147';
/** `sn_keccak('balance_of')`, pinned in pool-stats.test.ts. */
export const BALANCE_OF_SELECTOR = '0x35a73cd311a05d46deda634c5ee045db92f811b4e74bca4437fcb5302b7af33';
/** Events asked for per page; nodes accept up to about a thousand. */
export const POOL_EVENTS_CHUNK_SIZE = 1_000;
/**
 * D-081: the most `starknet_call`s one JSON-RPC batch request carries. A
 * position read sends its balance reads in one batch and the follow-ups for
 * held positions in one more, so it is a few HTTP requests to the node however
 * many vaults are pinned (48 at most: at most four requests).
 */
export const VAULT_RPC_BATCH_SIZE = 50;
/** D-081: a node that refuses batch requests is read one call at a time, this many at once. */
export const VAULT_RPC_FALLBACK_CONCURRENCY = 4;
const MAX_CONTINUATION_TOKEN_LENGTH = 512;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const MAX_RPC_ID = Number.MAX_SAFE_INTEGER;

/** The Starknet JSON-RPC spec's `TXN_HASH_NOT_FOUND`: the node has not seen this hash. */
const TXN_HASH_NOT_FOUND = 29;

type RpcEnvelope = { kind: 'result'; result: unknown } | { kind: 'error'; code: number | null };

/** D-081: one pinned vault read: its contract, selector and calldata, never a request's. */
interface PinnedCall {
  readonly contract: string;
  readonly selector: string;
  readonly calldata: readonly string[];
}

/** A call's felts, or null when that one call failed. */
type CallOutcome = readonly string[] | null;

export interface StarknetRpcOptions {
  rpcUrl: string;
  poolAddress: string;
  feeToken: string;
  noteMaturityBlocks?: number;
  fetcher?: FetchLike;
}

/** Minimal raw JSON-RPC port; it cannot relay arbitrary client calls. */
export class StarknetRpcPoolPort implements PoolRpcPort, PoolStatsRpcPort, VaultRpcPort, BorrowRpcPort, EndurRpcPort, LeaderboardRpcPort {
  private id = 0;
  private readonly activeIds = new Set<number>();
  private readonly fetcher: FetchLike;

  constructor(private readonly options: StarknetRpcOptions) {
    this.fetcher = options.fetcher ?? ((input, init) => globalThis.fetch(input, init));
  }

  async getPoolConfig(signal?: AbortSignal) {
    const [feeResult, validityResult] = await Promise.all([
      this.callPool(FEE_SELECTOR, [], signal),
      this.callPool(PROOF_VALIDITY_SELECTOR, [], signal),
    ]);
    // `get_fee_amount` returns a u128 (a single felt) in the live pool's ABI.
    // It was modelled as a u256 (two felts), which failed every pool-config
    // read against mainnet, where the call returns `[0x53444835ec580000]`.
    if (feeResult.length !== 1) {
      throw new Error('Starknet RPC returned an invalid fee amount.');
    }
    const feeAmount = feltToU128(feeResult[0], 'fee amount');
    if (validityResult.length !== 1) {
      throw new Error('Starknet RPC returned an invalid proof-validity window.');
    }
    const proofValidityBlocks = feltToPositiveSafeInteger(
      validityResult[0],
      'proof-validity window',
    );
    return {
      feeAmount,
      feeToken: this.options.feeToken,
      proofValidityBlocks,
      noteMaturityBlocks: this.options.noteMaturityBlocks ?? 10,
    };
  }

  async getPublicKey(address: string, signal?: AbortSignal): Promise<string> {
    const result = await this.callPool(PUBLIC_KEY_SELECTOR, [address], signal);
    const key = result[0];
    if (result.length !== 1 || !key || !isFelt(key)) {
      throw new Error('Starknet RPC returned an invalid public key.');
    }
    return key;
  }

  /**
   * D-072: a transaction the node has not seen yet is an answer, not a
   * failure. A deposit has no receipt for its first seconds, and the node says
   * so with error 29, which resolves `null` here so the receipt route can tell
   * "not yet" apart from a read that failed. Every other error still rejects.
   */
  async getReceipt(transactionHash: string, signal?: AbortSignal): Promise<unknown> {
    const envelope = await this.request('starknet_getTransactionReceipt', [transactionHash], signal);
    if (envelope.kind === 'result') return envelope.result;
    if (envelope.code === TXN_HASH_NOT_FOUND) return null;
    throw new Error('Starknet RPC returned an error.');
  }

  /**
   * D-076: one page of the pool's own events whose first key is `key`. Only
   * each match's block number leaves this port: never its keys (a user's
   * address), its data or its transaction. A page holding anything outside
   * the filter, the range or the page size is refused whole. With
   * `toBlockHash` the range ends at that block by hash, which a node that
   * has not reached it refuses (`BLOCK_NOT_FOUND`) instead of answering
   * short.
   */
  async getPoolEvents(filter: PoolEventsFilter, signal?: AbortSignal): Promise<PoolEventsPage> {
    const { key, fromBlock, toBlock } = filter;
    const token = filter.continuationToken ?? null;
    const toHash = filter.toBlockHash ?? null;
    if (
      !isFelt(key) ||
      !Number.isSafeInteger(fromBlock) || !Number.isSafeInteger(toBlock) ||
      fromBlock < 0 || toBlock < fromBlock ||
      (toHash !== null && (typeof toHash !== 'string' || !isFelt(toHash))) ||
      (token !== null && !isContinuationToken(token))
    ) {
      throw new Error('Pool event filter is invalid.');
    }
    const value = await this.rpc('starknet_getEvents', [{
      from_block: { block_number: fromBlock },
      to_block: toHash !== null ? { block_hash: toHash } : { block_number: toBlock },
      address: this.options.poolAddress,
      keys: [[key]],
      chunk_size: POOL_EVENTS_CHUNK_SIZE,
      ...(token !== null ? { continuation_token: token } : {}),
    }], signal);
    const events = ownData(value, 'events');
    if (!Array.isArray(events) || events.length > POOL_EVENTS_CHUNK_SIZE) {
      throw new Error('Starknet RPC returned an invalid events page.');
    }
    const pool = BigInt(this.options.poolAddress);
    const selector = BigInt(key);
    const blocks: number[] = [];
    for (let index = 0; index < events.length; index += 1) {
      const event = ownData(events, String(index));
      const from = ownData(event, 'from_address');
      const keys = ownData(event, 'keys');
      const first = Array.isArray(keys) ? ownData(keys, '0') : undefined;
      const block = ownData(event, 'block_number');
      if (
        typeof from !== 'string' || !isFelt(from) || BigInt(from) !== pool ||
        typeof first !== 'string' || !isFelt(first) || BigInt(first) !== selector ||
        typeof block !== 'number' || !Number.isSafeInteger(block) || block < fromBlock || block > toBlock
      ) {
        throw new Error('Starknet RPC returned an event outside its filter.');
      }
      blocks.push(block);
    }
    const next = ownData(value, 'continuation_token');
    if (next !== undefined && next !== null && (typeof next !== 'string' || !isContinuationToken(next))) {
      throw new Error('Starknet RPC returned an invalid continuation token.');
    }
    return { blocks, continuationToken: typeof next === 'string' ? next : null };
  }

  /** D-076: the latest block's number and hash, for a scan to end at. */
  async getHead(signal?: AbortSignal): Promise<ChainHead> {
    const value = await this.rpc('starknet_blockHashAndNumber', [], signal);
    const number = ownData(value, 'block_number');
    const hash = ownData(value, 'block_hash');
    if (
      typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0 ||
      typeof hash !== 'string' || !isFelt(hash)
    ) {
      throw new Error('Starknet RPC returned an invalid head.');
    }
    return { number, hash };
  }

  /**
   * D-077: the shadow account at nonce 0 for a partial commitment, from the
   * pinned anonymizer's own view: `get_shadow_accounts(partial, start = 0,
   * end = 1, until_undeployed = false)`, a `Span<ShadowAccountInfo>` of
   * `{ nonce: u64, address, is_deployed: bool }`. The view is the authority
   * on the address; the browser cross-checks it before sending funds there.
   * Anything but exactly one well-formed row for nonce 0 is refused.
   */
  async getShadowAccount(partialCommitment: string, signal?: AbortSignal): Promise<ShadowAccountRead> {
    if (!isFelt(partialCommitment) || BigInt(partialCommitment) === 0n) {
      throw new Error('Shadow-account commitment is invalid.');
    }
    const rows = await this.callContract(
      SHADOW_ACCOUNT_ANONYMIZER,
      GET_SHADOW_ACCOUNTS_SELECTOR,
      [partialCommitment, '0x0', '0x1', '0x0'],
      signal,
    );
    const [count, nonce, address, deployed] = rows;
    if (
      rows.length !== 4 ||
      count === undefined || BigInt(count) !== 1n ||
      nonce === undefined || BigInt(nonce) !== 0n ||
      address === undefined || BigInt(address) === 0n || BigInt(address) >= CONTRACT_ADDRESS_BOUND ||
      deployed === undefined || (BigInt(deployed) !== 0n && BigInt(deployed) !== 1n)
    ) {
      throw new Error('Starknet RPC returned an invalid shadow account.');
    }
    return { address, deployed: BigInt(deployed) === 1n };
  }

  /**
   * Leaderboard phase 1: one page of the pinned anonymizer's
   * `get_shadow_accounts(partial, start, start + count, until_undeployed =
   * false)`, a `Span<ShadowAccountInfo>` of `{ nonce: u64, address,
   * is_deployed: bool }`. Anything but exactly one well-formed row per nonce,
   * in order, is refused.
   */
  async getLeaderboardShadows(
    partialCommitment: string,
    start: number,
    count: number,
    signal?: AbortSignal,
  ): Promise<readonly LeaderboardShadowRead[]> {
    if (
      !isFelt(partialCommitment) || BigInt(partialCommitment) === 0n
      || !Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(count) || count <= 0 || count > 1_024
    ) {
      throw new Error('Leaderboard shadow read is invalid.');
    }
    const felts = await this.callContract(
      SHADOW_ACCOUNT_ANONYMIZER,
      GET_SHADOW_ACCOUNTS_SELECTOR,
      [partialCommitment, `0x${start.toString(16)}`, `0x${(start + count).toString(16)}`, '0x0'],
      signal,
    );
    const [length, ...items] = felts;
    if (length === undefined || BigInt(length) !== BigInt(count) || items.length !== count * 3) {
      throw new Error('Starknet RPC returned an invalid shadow page.');
    }
    const rows: LeaderboardShadowRead[] = [];
    for (let index = 0; index < count; index += 1) {
      const nonce = BigInt(items[index * 3]!);
      const address = items[index * 3 + 1]!;
      const deployed = BigInt(items[index * 3 + 2]!);
      if (
        nonce !== BigInt(start + index)
        || BigInt(address) === 0n || BigInt(address) >= CONTRACT_ADDRESS_BOUND
        || (deployed !== 0n && deployed !== 1n)
      ) {
        throw new Error('Starknet RPC returned an invalid shadow page.');
      }
      rows.push({ nonce: start + index, address, deployed: deployed === 1n });
    }
    return rows;
  }

  /**
   * Leaderboard phase 1: the ledger's `count_of(C) -> u64` for each
   * commitment (D-116, `contracts/receipt-ledger/src/lib.cairo`), in JSON-RPC
   * batches. Anything but one felt below 2^64, or a failed call, is null.
   */
  async getLeaderboardCounts(ledger: string, commitments: readonly string[], signal?: AbortSignal): Promise<readonly (bigint | null)[]> {
    if (!isFelt(ledger) || BigInt(ledger) === 0n || commitments.some((commitment) => !isFelt(commitment))) {
      throw new Error('Leaderboard count read is invalid.');
    }
    const outcomes = await this.callPinned(
      commitments.map((commitment) => ({ contract: ledger, selector: COUNT_OF_SELECTOR, calldata: [commitment] })),
      signal,
    );
    return outcomes.map((felts) => {
      if (!felts || felts.length !== 1) return null;
      const count = BigInt(felts[0]!);
      return count < 1n << 64n ? count : null;
    });
  }

  /**
   * D-077, D-079, D-081: `account`'s position in every pinned vault, one row
   * each in `VESU_VAULTS` order. Bounded however many vaults are pinned: one
   * JSON-RPC batch of `balance_of` for every vault, then one batch of the
   * preview and both limits for the vaults that hold shares (a vault holding
   * none has nothing to preview), each batch at most `VAULT_RPC_BATCH_SIZE`
   * calls. Every value is a u256 as two u128 felts. A vault whose call fails
   * or answers malformed is `ok: false`, so one vault's trouble never blocks
   * another token: the browser needs only the rows of the vaults it lends
   * through. A cancelled request still rejects.
   */
  async getVaultPositions(account: string, signal?: AbortSignal): Promise<readonly VaultPositionRead[]> {
    if (!isFelt(account) || BigInt(account) === 0n) throw new Error('Vault account is invalid.');
    const balances = await this.callPinned(
      VESU_VAULTS.map(({ vault }) => ({ contract: vault, selector: BALANCE_OF_SELECTOR, calldata: [account] })),
      signal,
    );
    const shares = balances.map((felts) => readU256(felts, 'vault shares'));
    const held = VESU_VAULTS.flatMap((_vault, index) => ((shares[index] ?? 0n) > 0n ? [index] : []));
    const details = held.length === 0 ? [] : await this.callPinned(held.flatMap((index) => {
      const { vault } = VESU_VAULTS[index]!;
      return [
        { contract: vault, selector: PREVIEW_REDEEM_SELECTOR, calldata: u256Felts(shares[index]!) },
        { contract: vault, selector: MAX_WITHDRAW_SELECTOR, calldata: [account] },
        { contract: vault, selector: MAX_REDEEM_SELECTOR, calldata: [account] },
      ];
    }), signal);
    return VESU_VAULTS.map(({ vault }, index): VaultPositionRead => {
      const owned = shares[index];
      if (owned === null || owned === undefined) return { vault, ok: false };
      if (owned === 0n) return { vault, ok: true, shares: 0n, assets: 0n, maxWithdraw: 0n, maxRedeem: 0n };
      const at = held.indexOf(index) * 3;
      const assets = readU256(details[at], 'vault preview');
      const maxWithdraw = readU256(details[at + 1], 'vault withdraw limit');
      const maxRedeem = readU256(details[at + 2], 'vault redeem limit');
      if (assets === null || maxWithdraw === null || maxRedeem === null) return { vault, ok: false };
      return { vault, ok: true, shares: owned, assets, maxWithdraw, maxRedeem };
    });
  }

  /**
   * D-085: what `account` holds at Endur's withdrawal queue. The latest
   * block's number and timestamp; the queue's `WithdrawQueue` events whose
   * receiver key is `account`, from `ENDUR_SCAN_WINDOW_BLOCKS` back (never
   * before `ENDUR_UNSTAKE_FIRST_BLOCK`), at most `ENDUR_SCAN_MAX_PAGES` pages;
   * then one batch of STRK's, xSTRK's and the queue's `balance_of(account)`
   * and `get_request_info` for each request id found (the newest
   * `MAX_ENDUR_REQUESTS`); then a read-only `claim_withdrawal` dry run of
   * each unpaid request past its wait, oldest first, at most
   * `MAX_ENDUR_CLAIM_DRY_RUNS`, whose success is `claimableNow`. An event
   * outside its filter, or a balance or request read that fails or answers
   * malformed, fails the whole read: half an answer could hide a request. A
   * scan that runs out of pages answers `complete: false`. A dry run that
   * reverts or fails is `claimableNow: false`, the safe answer.
   */
  async getEndurUnstake(account: string, signal?: AbortSignal): Promise<EndurUnstakeRead> {
    if (!isFelt(account) || BigInt(account) === 0n || BigInt(account) >= CONTRACT_ADDRESS_BOUND) {
      throw new Error('Unstaking account is invalid.');
    }
    const block = await this.rpc('starknet_getBlockWithTxHashes', ['latest'], signal);
    const head = ownData(block, 'block_number');
    const chainTime = ownData(block, 'timestamp');
    if (
      typeof head !== 'number' || !Number.isSafeInteger(head) || head < 0
      || typeof chainTime !== 'number' || !Number.isSafeInteger(chainTime) || chainTime < 0
    ) {
      throw new Error('Starknet RPC returned an invalid block.');
    }
    const fromBlock = Math.max(ENDUR_UNSTAKE_FIRST_BLOCK, head - ENDUR_SCAN_WINDOW_BLOCKS);
    const ids = new Set<bigint>();
    let complete = true;
    if (head >= fromBlock) {
      const queue = BigInt(ENDUR_WITHDRAWAL_QUEUE);
      const key = BigInt(WITHDRAW_QUEUE_EVENT_KEY);
      const receiver = BigInt(account);
      let token: string | null = null;
      for (let page = 0; page < ENDUR_SCAN_MAX_PAGES; page += 1) {
        const value = await this.rpc('starknet_getEvents', [{
          from_block: { block_number: fromBlock },
          to_block: { block_number: head },
          address: ENDUR_WITHDRAWAL_QUEUE,
          keys: [[WITHDRAW_QUEUE_EVENT_KEY], [account]],
          chunk_size: ENDUR_EVENTS_CHUNK_SIZE,
          ...(token !== null ? { continuation_token: token } : {}),
        }], signal);
        const events = ownData(value, 'events');
        if (!Array.isArray(events) || events.length > ENDUR_EVENTS_CHUNK_SIZE) {
          throw new Error('Starknet RPC returned an invalid events page.');
        }
        for (let index = 0; index < events.length; index += 1) {
          const event = ownData(events, String(index));
          const from = ownData(event, 'from_address');
          const keys = ownData(event, 'keys');
          const data = ownData(event, 'data');
          const first = Array.isArray(keys) ? ownData(keys, '0') : undefined;
          const second = Array.isArray(keys) ? ownData(keys, '1') : undefined;
          const requestId = Array.isArray(data) ? ownData(data, '0') : undefined;
          const blockNumber = ownData(event, 'block_number');
          if (
            typeof from !== 'string' || !isFelt(from) || BigInt(from) !== queue
            || typeof first !== 'string' || !isFelt(first) || BigInt(first) !== key
            || typeof second !== 'string' || !isFelt(second) || BigInt(second) !== receiver
            || typeof requestId !== 'string' || !isFelt(requestId) || BigInt(requestId) >= (1n << 128n)
            || typeof blockNumber !== 'number' || !Number.isSafeInteger(blockNumber) || blockNumber < fromBlock || blockNumber > head
          ) {
            throw new Error('Starknet RPC returned an event outside its filter.');
          }
          ids.add(BigInt(requestId));
        }
        const next = ownData(value, 'continuation_token');
        if (next === undefined || next === null) {
          token = null;
          break;
        }
        if (typeof next !== 'string' || !isContinuationToken(next)) {
          throw new Error('Starknet RPC returned an invalid continuation token.');
        }
        token = next;
      }
      // Pages left over: say so, rather than answer as if the list were whole.
      complete = token === null;
    }
    const requestIds = [...ids].sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)).slice(0, MAX_ENDUR_REQUESTS);
    const outcomes = await this.callPinned([
      { contract: ENDUR_XSTRK_ASSET, selector: BALANCE_OF_SELECTOR, calldata: [account] },
      { contract: ENDUR_XSTRK, selector: BALANCE_OF_SELECTOR, calldata: [account] },
      { contract: ENDUR_WITHDRAWAL_QUEUE, selector: BALANCE_OF_SELECTOR, calldata: [account] },
      ...requestIds.map((requestId) => ({
        contract: ENDUR_WITHDRAWAL_QUEUE,
        selector: GET_REQUEST_INFO_SELECTOR,
        calldata: [`0x${requestId.toString(16)}`],
      })),
    ], signal);
    const [strk, xstrk, outstanding] = [0, 1, 2].map((index) => readU256(outcomes[index], 'balance'));
    if (strk === null || strk === undefined || xstrk === null || xstrk === undefined || outstanding === null || outstanding === undefined) {
      throw new Error('Starknet RPC could not read the unstaking balances.');
    }
    const recorded = requestIds.map((requestId, index) => endurRequestOf(requestId, outcomes[index + 3]));
    const due = recorded
      .filter((request) => !request.claimed && request.claimableAt <= chainTime)
      .sort((a, b) => (a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0))
      .slice(0, MAX_ENDUR_CLAIM_DRY_RUNS);
    const dryRuns = due.length === 0 ? [] : await this.callPinned(due.map((request) => ({
      contract: ENDUR_WITHDRAWAL_QUEUE,
      selector: CLAIM_WITHDRAWAL_SELECTOR,
      calldata: [`0x${request.requestId.toString(16)}`],
    })), signal);
    const payable = new Set(due.filter((_request, index) => dryRuns[index] != null).map((request) => request.requestId));
    const requests = recorded.map((request) => ({ ...request, claimableNow: payable.has(request.requestId) }));
    return { chainTime, strk, xstrk, outstanding, requests, complete };
  }

  /**
   * D-091: xSTRK's exchange rate: one pinned `convert_to_assets(10^18)` on
   * xSTRK at the latest block. A failed, malformed or zero answer fails the
   * read; nothing about any player is asked or answered.
   */
  async getEndurRate(signal?: AbortSignal): Promise<bigint> {
    const [outcome] = await this.callPinned([{
      contract: ENDUR_XSTRK,
      selector: CONVERT_TO_ASSETS_SELECTOR,
      calldata: [`0x${ONE_XSTRK.toString(16)}`, '0x0'],
    }], signal);
    const assets = readU256(outcome, 'xSTRK rate');
    if (assets === null || assets <= 0n) throw new Error('Starknet RPC could not read the xSTRK rate.');
    return assets;
  }

  /**
   * D-083: the Borrow counter's market figures, read from the pinned Prime
   * pool alone: `price` and `asset_config` for every token in
   * `BORROW_TOKENS`, then `pair_config` and `pairs` for every pair in
   * `BORROW_PAIRS`. That is fifty calls, one JSON-RPC batch
   * (`VAULT_RPC_BATCH_SIZE`), through the same bounded path as the vault
   * reads. A row is `ok: false` when either of its two calls fails or answers
   * malformed (a wrong length, a non-felt, a bool that is not 0 or 1, a
   * limb or integer out of range), so one token or pair never blocks
   * another. A cancelled request still rejects.
   */
  async getBorrowMarket(signal?: AbortSignal): Promise<BorrowMarketRead> {
    const outcomes = await this.callPinned([
      ...BORROW_TOKENS.flatMap((token) => [
        { contract: BORROW_POOL, selector: PRICE_SELECTOR, calldata: [token] },
        { contract: BORROW_POOL, selector: ASSET_CONFIG_SELECTOR, calldata: [token] },
      ]),
      ...BORROW_PAIRS.flatMap(({ collateral, debt }) => [
        { contract: BORROW_POOL, selector: PAIR_CONFIG_SELECTOR, calldata: [collateral, debt] },
        { contract: BORROW_POOL, selector: PAIRS_SELECTOR, calldata: [collateral, debt] },
      ]),
    ], signal);
    const assets = BORROW_TOKENS.map((token, index): BorrowAssetRead => {
      const price = decodeRow(outcomes[index * 2], decodeAssetPrice);
      const config = decodeRow(outcomes[index * 2 + 1], decodeAssetConfig);
      if (!price || !config) return { token, ok: false };
      return { token, ok: true, price: price.value, priceValid: price.isValid, ...config };
    });
    const offset = BORROW_TOKENS.length * 2;
    const pairs = BORROW_PAIRS.map(({ collateral, debt }, index): BorrowPairRead => {
      const config = decodeRow(outcomes[offset + index * 2], decodePairConfig);
      const pair = decodeRow(outcomes[offset + index * 2 + 1], decodePair);
      if (!config || !pair) return { collateral, debt, ok: false };
      return { collateral, debt, ok: true, ...config, totalNominalDebt: pair.totalNominalDebt };
    });
    return { assets, pairs };
  }

  /**
   * D-083: `account`'s position in every pinned pair of the Prime pool, one
   * `position(collateral, debt, account)` call each in `BORROW_PAIRS` order:
   * twenty calls, one JSON-RPC batch. A pair whose call fails or answers
   * malformed is `ok: false`. A cancelled request still rejects.
   */
  async getBorrowPositions(account: string, signal?: AbortSignal): Promise<readonly BorrowPositionRead[]> {
    if (!isFelt(account) || BigInt(account) === 0n) throw new Error('Borrow account is invalid.');
    const outcomes = await this.callPinned(
      BORROW_PAIRS.map(({ collateral, debt }) => (
        { contract: BORROW_POOL, selector: POSITION_SELECTOR, calldata: [collateral, debt, account] }
      )),
      signal,
    );
    return BORROW_PAIRS.map(({ collateral, debt }, index): BorrowPositionRead => {
      const position = decodeRow(outcomes[index], decodePosition);
      return position ? { collateral, debt, ok: true, ...position } : { collateral, debt, ok: false };
    });
  }

  /**
   * D-081: pinned vault (and D-083 borrow) calls, in batches of at most `VAULT_RPC_BATCH_SIZE`,
   * each answered by position. A call the node failed or answered malformed
   * is null; so is every call of a batch the node could not take at all (down,
   * rate-limited, erroring), which is never retried call by call. A node that
   * refuses JSON-RPC batches (a client error, or one error object instead of a
   * list) is read one call at a time instead, `VAULT_RPC_FALLBACK_CONCURRENCY`
   * at once. A cancelled request rejects.
   */
  private async callPinned(calls: readonly PinnedCall[], signal?: AbortSignal): Promise<CallOutcome[]> {
    const outcomes: CallOutcome[] = [];
    for (let start = 0; start < calls.length; start += VAULT_RPC_BATCH_SIZE) {
      outcomes.push(...await this.callBatch(calls.slice(start, start + VAULT_RPC_BATCH_SIZE), signal));
    }
    return outcomes;
  }

  private async callBatch(calls: readonly PinnedCall[], signal?: AbortSignal): Promise<CallOutcome[]> {
    const ids = calls.map(() => this.allocateId());
    let batchRefused = false;
    try {
      let response: Response;
      try {
        response = await this.fetcher(this.options.rpcUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(calls.map((call, index) => ({
            jsonrpc: '2.0',
            id: ids[index],
            method: 'starknet_call',
            params: [{ contract_address: call.contract, entry_point_selector: call.selector, calldata: call.calldata }, 'latest'],
          }))),
          signal,
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        return calls.map(() => null);
      }
      if (!response.ok) {
        // Nothing in an error body is read; free the connection.
        await response.body?.cancel().catch(() => undefined);
        if (response.status === 429 || response.status >= 500) return calls.map(() => null);
      }
      let payload: unknown;
      try {
        payload = response.ok ? await response.json() : undefined;
      } catch (error) {
        if (signal?.aborted) throw error;
        payload = undefined;
      }
      if (!Array.isArray(payload)) {
        batchRefused = true;
      } else {
        return ids.map((id) => batchOutcome(payload as unknown[], id));
      }
    } finally {
      for (const id of ids) this.activeIds.delete(id);
    }
    if (batchRefused) return this.callEach(calls, signal);
    return calls.map(() => null);
  }

  /** D-081: the fallback for a node without batches: single calls, a few at once. */
  private async callEach(calls: readonly PinnedCall[], signal?: AbortSignal): Promise<CallOutcome[]> {
    const outcomes: CallOutcome[] = calls.map(() => null);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < calls.length) {
        const index = next;
        next += 1;
        const call = calls[index]!;
        try {
          outcomes[index] = await this.callContract(call.contract, call.selector, [...call.calldata], signal);
        } catch (error) {
          if (signal?.aborted) throw error;
          outcomes[index] = null;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(VAULT_RPC_FALLBACK_CONCURRENCY, calls.length) }, worker));
    return outcomes;
  }

  async getBlockNumber(signal?: AbortSignal): Promise<number> {
    const value = await this.rpc('starknet_blockNumber', [], signal);
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      throw new Error('Starknet RPC returned an invalid block number.');
    }
    return value;
  }

  private async callPool(selector: string, calldata: string[], signal?: AbortSignal): Promise<string[]> {
    const value = await this.rpc('starknet_call', [{
      contract_address: this.options.poolAddress,
      entry_point_selector: selector,
      calldata,
    }, 'latest'], signal);
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
      throw new Error('Starknet RPC returned an invalid call result.');
    }
    return value as string[];
  }

  /** D-077: a `starknet_call` of a pinned Vault contract and selector; every returned item must be a felt. */
  private async callContract(
    contract: string,
    selector: string,
    calldata: string[],
    signal?: AbortSignal,
  ): Promise<string[]> {
    const value = await this.rpc('starknet_call', [{
      contract_address: contract,
      entry_point_selector: selector,
      calldata,
    }, 'latest'], signal);
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !isFelt(item))) {
      throw new Error('Starknet RPC returned an invalid call result.');
    }
    return value as string[];
  }

  private async rpc(method: string, params: unknown[], signal?: AbortSignal): Promise<unknown> {
    const envelope = await this.request(method, params, signal);
    if (envelope.kind === 'error') throw new Error('Starknet RPC returned an error.');
    return envelope.result;
  }

  private async request(method: string, params: unknown[], signal?: AbortSignal): Promise<RpcEnvelope> {
    const id = this.allocateId();
    try {
      const response = await this.fetcher(this.options.rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal,
      });
      if (!response.ok) throw new Error('Starknet RPC request failed.');
      let payload: unknown;
      try {
        payload = await response.json();
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        throw new Error('Starknet RPC returned an invalid response.');
      }
      return parseRpcEnvelope(payload, id);
    } finally {
      this.activeIds.delete(id);
    }
  }

  private allocateId(): number {
    const first = this.id >= MAX_RPC_ID ? 1 : this.id + 1;
    let candidate = first;
    for (;;) {
      if (!this.activeIds.has(candidate)) {
        this.activeIds.add(candidate);
        this.id = candidate;
        return candidate;
      }
      candidate = candidate === MAX_RPC_ID ? 1 : candidate + 1;
      if (candidate === first) {
        throw new Error('Starknet RPC request-id space is exhausted.');
      }
    }
  }
}

function parseRpcEnvelope(payload: unknown, requestId: number): RpcEnvelope {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Starknet RPC returned an invalid response.');
  }
  const record = payload as Record<string, unknown>;
  // JSON-RPC permits extension members; this narrow port consumes only the
  // required envelope fields and never reflects provider extensions.
  const jsonrpc = Object.getOwnPropertyDescriptor(record, 'jsonrpc');
  const id = Object.getOwnPropertyDescriptor(record, 'id');
  const result = Object.getOwnPropertyDescriptor(record, 'result');
  const error = Object.getOwnPropertyDescriptor(record, 'error');
  if (
    !jsonrpc || !('value' in jsonrpc) ||
    !id || !('value' in id)
  ) {
    throw new Error('Starknet RPC returned an invalid response.');
  }
  const hasResult = Boolean(result);
  const hasError = Boolean(error);
  if (
    hasResult === hasError ||
    (result !== undefined && !('value' in result)) ||
    (error !== undefined && !('value' in error)) ||
    jsonrpc.value !== '2.0' ||
    id.value !== requestId
  ) {
    throw new Error('Starknet RPC returned an invalid response.');
  }
  return hasError ? { kind: 'error', code: rpcErrorCode(error!.value) } : { kind: 'result', result: result!.value };
}

/**
 * The error's own numeric `code`, and nothing else: its message and data are
 * provider text this port never reads or reflects.
 */
function rpcErrorCode(error: unknown): number | null {
  if (!error || typeof error !== 'object' || Array.isArray(error)) return null;
  const code = Object.getOwnPropertyDescriptor(error, 'code');
  return code && 'value' in code && Number.isSafeInteger(code.value) ? code.value as number : null;
}

/** An own data property, never a getter or an inherited value. */
function ownData(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

/** A node's opaque page cursor: printable, short, and never taken from a request. */
function isContinuationToken(value: string): boolean {
  return value.length > 0 && value.length <= MAX_CONTINUATION_TOKEN_LENGTH && /^[\x21-\x7e]+$/.test(value);
}

function feltToPositiveSafeInteger(value: string | undefined, label: string): number {
  if (!value || !isFelt(value)) throw new Error(`Starknet RPC returned an invalid ${label}.`);
  const parsed = BigInt(value);
  if (parsed <= 0n || parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`Starknet RPC returned an invalid ${label}.`);
  }
  return Number(parsed);
}

/** Starknet contract addresses lie below 2^251. */
const CONTRACT_ADDRESS_BOUND = 1n << 251n;

/** A u256 result: exactly two u128 felts, low first. */
function u256Of(value: readonly string[], label: string): bigint {
  if (value.length !== 2) throw new Error(`Starknet RPC returned an invalid ${label}.`);
  return feltToU128(value[0], label) + (feltToU128(value[1], label) << 128n);
}

/** D-081: a batched call's u256, or null for a failed call or a malformed answer. */
function readU256(value: CallOutcome | undefined, label: string): bigint | null {
  if (!value) return null;
  try {
    return u256Of(value, label);
  } catch {
    return null;
  }
}

/**
 * D-081: the answer with this id in a batch response, as felts, or null: no
 * such answer, two of them, an error, or anything malformed. Only the envelope
 * fields and the result are read, never an error's text.
 */
function batchOutcome(payload: readonly unknown[], id: number): CallOutcome {
  const matching = payload.filter((item) => ownData(item, 'id') === id);
  if (matching.length !== 1) return null;
  let envelope: RpcEnvelope;
  try {
    envelope = parseRpcEnvelope(matching[0], id);
  } catch {
    return null;
  }
  if (envelope.kind === 'error') return null;
  const { result } = envelope;
  if (!Array.isArray(result) || result.some((item) => typeof item !== 'string' || !isFelt(item))) return null;
  return Object.freeze([...result as string[]]);
}

/**
 * D-085: one `get_request_info` answer, a `WithdrawRequest`: assets (u256),
 * shares (u256), isClaimed (bool), timestamp (u64), claimTime (u64),
 * cumulative_requested_amount_snapshot (u256), nine felts. Anything else
 * fails the read.
 */
function endurRequestOf(requestId: bigint, value: CallOutcome | undefined): Omit<EndurRequestRead, 'claimableNow'> {
  if (!value || value.length !== 9) throw new Error('Starknet RPC could not read an unstaking request.');
  const assets = u256Of(value.slice(0, 2), 'request assets');
  const shares = u256Of(value.slice(2, 4), 'request shares');
  const claimed = BigInt(value[4]!);
  const requestedAt = BigInt(value[5]!);
  const claimableAt = BigInt(value[6]!);
  if (
    (claimed !== 0n && claimed !== 1n)
    || requestedAt > BigInt(Number.MAX_SAFE_INTEGER) || claimableAt > BigInt(Number.MAX_SAFE_INTEGER)
    || claimableAt < requestedAt
  ) {
    throw new Error('Starknet RPC returned an invalid unstaking request.');
  }
  return { requestId, assets, shares, claimed: claimed === 1n, requestedAt: Number(requestedAt), claimableAt: Number(claimableAt) };
}

/** A u256 argument as Cairo serializes it: low 128 bits, then high. */
function u256Felts(value: bigint): string[] {
  const mask = (1n << 128n) - 1n;
  return [`0x${(value & mask).toString(16)}`, `0x${(value >> 128n).toString(16)}`];
}

function feltToU128(value: string | undefined, label: string): bigint {
  if (!value || !isFelt(value)) {
    throw new Error(`Starknet RPC returned an invalid ${label}.`);
  }
  const parsed = BigInt(value);
  if (parsed >= (1n << 128n)) {
    throw new Error(`Starknet RPC returned an invalid ${label}.`);
  }
  return parsed;
}

/**
 * D-083: a Cairo return value read in order, each felt checked against its
 * declared type. Anything out of range, or any felt left over, refuses the
 * whole value.
 */
class FeltReader {
  private at = 0;

  constructor(private readonly felts: readonly string[]) {}

  private uint(bits: bigint): bigint {
    const felt = this.felts[this.at];
    this.at += 1;
    if (felt === undefined || !isFelt(felt)) throw new Error('Starknet RPC returned an invalid felt.');
    const value = BigInt(felt);
    if (value >= (1n << bits)) throw new Error('Starknet RPC returned an out-of-range integer.');
    return value;
  }

  u64(): bigint { return this.uint(64n); }

  u128(): bigint { return this.uint(128n); }

  /** Two u128 felts, low first. */
  u256(): bigint { return this.u128() + (this.u128() << 128n); }

  bool(): boolean { return this.uint(1n) === 1n; }

  end(): void {
    if (this.at !== this.felts.length) throw new Error('Starknet RPC returned a value of the wrong length.');
  }
}

/** D-083: a pinned call's decoded value, or null for a failed call or a malformed answer. */
function decodeRow<T>(value: CallOutcome | undefined, decode: (reader: FeltReader) => T): T | null {
  if (!value) return null;
  try {
    const reader = new FeltReader(value);
    const decoded = decode(reader);
    reader.end();
    return decoded;
  } catch {
    return null;
  }
}

/** `price(asset) -> AssetPrice { value: u256, is_valid: bool }`. */
function decodeAssetPrice(reader: FeltReader) {
  return { value: reader.u256(), isValid: reader.bool() };
}

/** `asset_config(asset) -> AssetConfig`, twenty-two felts; only the figures the counter uses leave here. */
function decodeAssetConfig(reader: FeltReader) {
  reader.u256(); // total_collateral_shares
  const totalNominalDebt = reader.u256();
  const reserve = reader.u256();
  const maxUtilization = reader.u256();
  const floor = reader.u256();
  const scale = reader.u256();
  reader.bool(); // is_legacy
  reader.u64(); // last_updated
  const rateAccumulator = reader.u256();
  reader.u256(); // last_full_utilization_rate
  reader.u256(); // fee_rate
  reader.u256(); // fee_shares
  return { scale, floor, reserve, totalNominalDebt, rateAccumulator, maxUtilization };
}

/** `pair_config(collateral, debt) -> PairConfig { max_ltv: u64, liquidation_factor: u64, debt_cap: u128 }`. */
function decodePairConfig(reader: FeltReader) {
  return { maxLtv: reader.u64(), liquidationFactor: reader.u64(), debtCap: reader.u128() };
}

/** `pairs(collateral, debt) -> Pair { total_collateral_shares: u256, total_nominal_debt: u256 }`. */
function decodePair(reader: FeltReader) {
  reader.u256(); // total_collateral_shares
  return { totalNominalDebt: reader.u256() };
}

/** `position(collateral, debt, user) -> (Position { collateral_shares, nominal_debt }, collateral: u256, debt: u256)`. */
function decodePosition(reader: FeltReader) {
  return {
    collateralShares: reader.u256(),
    nominalDebt: reader.u256(),
    collateralAmount: reader.u256(),
    debtAmount: reader.u256(),
  };
}
