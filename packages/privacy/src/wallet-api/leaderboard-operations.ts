import type { STRK20_ACTION } from 'starknet';
import {
  LEADERBOARD_DAPP_NAME,
  LEADERBOARD_SEASON,
  LEADERBOARD_SHADOW_PAGE,
  MAX_LEADERBOARD_RECEIPTS,
  ownHistogram,
  placementFrom,
  receiptInvokeAction,
  shadowCommitment,
  type LeaderboardHistogram,
  type Placement,
} from '../leaderboard.js';
import { noticeLeaderboard, type LeaderboardSkipReason } from '../leaderboard-notice.js';
import { PrivacyError, type Address } from '../types.js';
import { shadowAccountAddress } from '../vault.js';
import { WalletCommitmentCache } from './commitment-cache.js';
import { mapShadowWalletError } from './errors.js';
import { createReceiptNonceStore, receiptNonceKey, type ReceiptNonceStore } from './receipt-nonce-store.js';
import { ownData, sameAddress, throwIfAborted } from './shadow-account.js';
import type { LeaderboardReadClient, LeaderboardShadowRow, WalletStrk20Account } from './types.js';

/**
 * The private placement on the Wallet API (leaderboard phase 1).
 *
 * The one secret is the season partial commitment `p`, which only the
 * player's wallet can derive. It lives in this object's memory for the
 * connection and nowhere else: never in storage, never in a log, never in an
 * error message, never in a callback, and never handed to the Shell. It goes
 * to exactly two places: the backend's pinned shadow read (as the Vault's own
 * partial commitment does, D-077) and the blind tally, on the player's own
 * request.
 *
 * Receipts fail open. A wallet that refuses or cannot give `p`, or a read
 * that fails, means the action goes out exactly as it would without a
 * receipt: a placement is never a reason to block a player's money.
 *
 * Nothing here branches on wallet identity.
 */

/**
 * A counter whose shadow account can tick the ledger, as a placement check
 * may read it: both answers come from the connection's commitment cache and
 * never from the wallet, so a check cannot prompt for a feature (D-122,
 * amended 2026-10-03). A feature the player has not used this session is
 * simply absent from the check — the tally keeps its last verified count.
 */
export interface LedgerTickSource {
  /** The feature shadow's full commitment `C`, if its partial is cached; null otherwise. */
  cachedCommitment(): string | null;
  /** Sent to the tally only when it ranks DeFi (`rankDefi`), as proof this account owns the shadow. */
  cachedPartial(): string | null;
}

export interface LeaderboardReceiptsOptions {
  readonly wallet: WalletStrk20Account;
  readonly reads?: LeaderboardReadClient;
  readonly ledger: Address;
  /** The operations' own capability answer: `supportsShadowAccounts`. */
  readonly supported: (signal?: AbortSignal) => Promise<boolean>;
  /** The DeFi counters' shadow accounts (Vault, Borrow, Endur unstaking, Swap), whose ticks add to the count. */
  readonly features: readonly LedgerTickSource[];
  /** Where this device remembers the next receipt nonce; guarded `localStorage` by default. */
  readonly nonces?: ReceiptNonceStore;
  /**
   * The connection's one commitment cache, shared with every feature route, so
   * the season commitment is asked for at most once per connection and a
   * receipt and a check never ask twice between them. Absent, its own.
   */
  readonly commitments?: WalletCommitmentCache;
}

/** A receipt ready to join a transaction, and the nonce it uses. */
export interface PreparedReceipt {
  readonly action: STRK20_ACTION;
  readonly nonce: bigint;
}

/** What a placement check found. Counts only; `p` is never part of it. */
export interface PlacementCheck {
  readonly season: string;
  /** Receipt-mode receipts (shield, unshield, send), read on-chain. */
  readonly receipts: number;
  /** DeFi ticks on the feature shadows (Vault, Borrow, Endur, Swap), read on-chain. */
  readonly defi: number;
  /** The tally's own verified count for this player, or null when the tally could not be reached. */
  readonly verified: number | null;
  /** The season's anonymous histogram, or null when it could not be read. */
  readonly histogram: LeaderboardHistogram | null;
  /**
   * The count ranked against the histogram: the tally's verified count, the
   * same measure everyone in the histogram has (DeFi ticks are not in it, since
   * the tally sees only the season commitment), or the player's own receipt
   * count when the tally was down.
   */
  readonly ranked: number;
  /** Where `ranked` sits in the histogram, computed here on the device; null with nothing to rank or no histogram. */
  readonly placement: Placement | null;
  /**
   * Whether the tally ranks DeFi ticks too (`BACKEND_LEADERBOARD_RANK_DEFI`).
   * Only then were the feature partials sent, and `verified` includes them.
   */
  readonly rankDefi: boolean;
}

const COUNT_CHUNK = LEADERBOARD_SHADOW_PAGE;
const MAX_PAGES = MAX_LEADERBOARD_RECEIPTS / LEADERBOARD_SHADOW_PAGE;

export class LeaderboardReceipts {
  readonly ledger: Address;
  private readonly reads?: LeaderboardReadClient;
  private readonly supported: (signal?: AbortSignal) => Promise<boolean>;
  private readonly features: readonly LedgerTickSource[];
  /** Where `p` lives once given: the connection's shared cache, memory only. */
  private readonly commitments: WalletCommitmentCache;
  /**
   * The lowest nonce not yet used by a transaction this connection submitted:
   * a submitted receipt is not on-chain until accepted, and the next action
   * must not reuse its shadow meanwhile. It only advances after a submit, so
   * a discarded batch never leaves a gap.
   */
  private floor = 0n;
  private readonly nonces: ReceiptNonceStore;

  constructor(options: LeaderboardReceiptsOptions) {
    this.nonces = options.nonces ?? createReceiptNonceStore();
    this.reads = options.reads;
    this.ledger = options.ledger;
    this.supported = options.supported;
    this.features = Object.freeze([...options.features]);
    this.commitments = options.commitments ?? new WalletCommitmentCache(options.wallet);
  }

  /**
   * Whether the next check would reach the wallet for the season commitment —
   * so the panel can say "Your wallet will ask to share your season ID" only
   * when it is true. Reads the cache; it never asks anything itself.
   */
  willPrompt(): boolean {
    return this.commitments.willAsk(LEADERBOARD_DAPP_NAME);
  }

  /**
   * The receipt for the next shield, unshield or send, or null when there
   * cannot be one (fail open: the action goes out unchanged).
   *
   * Every exit reports itself on D-069's debug channel as a reason code, so a
   * probe deploy that attaches nothing says which step declined. The code is
   * all that is written: no commitment, no nonce, no address.
   */
  async receiptFor(signal?: AbortSignal): Promise<PreparedReceipt | null> {
    try {
      if (!this.reads) return skipReceipt('no-reads');
      if (!(await this.supported(signal))) return skipReceipt('unsupported-route');
      throwIfAborted(signal);
      const partial = await this.partialCommitment();
      throwIfAborted(signal);
      // The device's own record first: then `p` goes nowhere for a normal
      // send. Only with no record does the backend's scan find the nonce.
      const key = receiptNonceKey(LEADERBOARD_SEASON, partial);
      this.nonceKey = key;
      const known = this.nonces.read(key);
      const next = known ?? (await this.scan(partial, signal)).next;
      const nonce = next > this.floor ? next : this.floor;
      if (nonce >= BigInt(MAX_LEADERBOARD_RECEIPTS)) return skipReceipt('no-nonce');
      const prepared = Object.freeze({
        action: receiptInvokeAction({ ledger: this.ledger, partialCommitment: partial, nonce }),
        nonce,
      });
      noticeLeaderboard({ event: 'receipt', attached: true });
      return prepared;
    } catch {
      // A cancelled prepare is the player closing the counter, not a fault:
      // it is the one exit that reports nothing.
      if (signal?.aborted !== true) skipReceipt('scan-failed');
      return null;
    }
  }

  /** A transaction carrying the receipt at `nonce` was submitted. */
  committed(nonce: bigint): void {
    if (nonce + 1n > this.floor) this.floor = nonce + 1n;
    if (this.nonceKey) this.nonces.write(this.nonceKey, this.floor);
  }

  /** The device record's key for this connection's account, once `p` is known. */
  private nonceKey: string | null = null;

  /**
   * "Check your placement privately": count this player's receipts on-chain,
   * refresh their anonymous entry at the tally, and read the season's
   * histogram. The placement itself is computed by the caller, on the device.
   */
  async check(signal?: AbortSignal): Promise<PlacementCheck> {
    const reads = this.reads;
    if (!reads) throw new PrivacyError('unknown', 'The placement reads are not configured.');
    let supported: boolean;
    try {
      supported = await this.supported(signal);
    } catch (error) {
      throw mapShadowWalletError(error);
    }
    if (!supported) {
      throw new PrivacyError('shadow-accounts-unsupported', 'This wallet cannot check a private placement yet.');
    }
    throwIfAborted(signal);
    const partial = await this.partialCommitment();
    throwIfAborted(signal);

    const { deployed, next } = await this.scan(partial, signal);
    const receipts = await this.countOf(deployed.map((nonce) => shadowCommitment(partial, nonce)), signal);
    // The check already scanned: bring the device's nonce record up to the
    // chain (receipts sent from another device), never down.
    const key = receiptNonceKey(LEADERBOARD_SEASON, partial);
    this.nonceKey = key;
    const known = this.nonces.read(key);
    const best = [next, this.floor, known ?? 0n].reduce((a, b) => (b > a ? b : a));
    if (known === null || best > known) this.nonces.write(key, best);

    // The DeFi counters' ticks, for the features this session has already
    // used: their commitments come from the connection's cache, so a check
    // never prompts for one. A feature the player has not touched this session
    // is left out, and the tally keeps its last verified count for it.
    const featureCommitments = this.features
      .map((feature) => feature.cachedCommitment())
      .filter((commitment): commitment is string => commitment !== null);
    let defi = 0;
    try {
      defi = await this.countOf(featureCommitments, signal);
    } catch {
      throwIfAborted(signal);
    }

    // Does the tally rank DeFi? Only then are the feature partials sent: they
    // let it verify the DeFi ticks, and they let it tie this season pseudonym
    // to the persistent feature shadows (D-122's trade-off). Off by default.
    let rankDefi = false;
    try {
      rankDefi = ownData(await reads.leaderboardHistogram(signal), 'rankDefi') === true;
    } catch {
      throwIfAborted(signal);
    }
    // Only the partials already in this session's cache go out: never a prompt
    // just to collect them for a check.
    const featurePartials = rankDefi
      ? this.features
          .map((feature) => feature.cachedPartial())
          .filter((partial): partial is string => partial !== null)
      : [];

    let verified: number | null = null;
    try {
      const answer = await reads.leaderboardCheckIn(
        LEADERBOARD_SEASON,
        partial,
        signal,
        featurePartials.length > 0 ? featurePartials : undefined,
      );
      verified = smallCount(answer.count);
    } catch {
      throwIfAborted(signal);
    }
    let histogram: LeaderboardHistogram | null = null;
    try {
      histogram = ownHistogram(await reads.leaderboardHistogram(signal));
      if (histogram && histogram.season !== LEADERBOARD_SEASON) histogram = null;
    } catch {
      throwIfAborted(signal);
    }
    // The placement, worked out here on the player's device. When the tally
    // stored this player (a verified count above zero) they are already in
    // the histogram; otherwise they count as one more player.
    const ranked = verified ?? (rankDefi ? receipts + defi : receipts);
    const placement = histogram ? placementFrom(histogram, ranked, verified !== null && verified > 0) : null;
    return Object.freeze({ season: LEADERBOARD_SEASON, receipts, defi, verified, histogram, ranked, placement, rankDefi });
  }

  /**
   * The deployed receipt nonces and the next free one: pages of the
   * anonymizer's view, until a page holds no deployed account.
   *
   * The count never rests on the addresses: each receipt's commitment is
   * derived here from `p` and its nonce, and its count is the ledger's. So
   * only the newest deployed row's address is cross-checked (deriving one
   * costs several Pedersen hashes, about 30 ms in JS): enough to catch a
   * backend reading another anonymizer or class, without hashing every row.
   */
  private async scan(partial: string, signal?: AbortSignal): Promise<{ deployed: bigint[]; next: bigint }> {
    const reads = this.reads;
    if (!reads) throw new PrivacyError('unknown', 'The placement reads are not configured.');
    const deployed: bigint[] = [];
    let newest: LeaderboardShadowRow | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const rows = await reads.leaderboardShadows(partial, page, signal);
      throwIfAborted(signal);
      if (!Array.isArray(rows) || rows.length !== LEADERBOARD_SHADOW_PAGE) {
        throw new PrivacyError('unknown', 'The placement read is invalid.');
      }
      let any = false;
      for (const [index, row] of rows.entries()) {
        const nonce = BigInt(page * LEADERBOARD_SHADOW_PAGE + index);
        if (!row || row.nonce !== nonce || typeof row.deployed !== 'boolean') {
          throw new PrivacyError('unknown', 'The placement read could not be verified.');
        }
        if (row.deployed) {
          any = true;
          deployed.push(nonce);
          newest = row;
        }
      }
      if (!any) break;
    }
    const last = newest as LeaderboardShadowRow | null;
    if (last !== null && !sameAddress(shadowAccountAddress(partial, `0x${last.nonce.toString(16)}`), last.address)) {
      throw new PrivacyError('unknown', 'The placement read could not be verified.');
    }
    return { deployed, next: last === null ? 0n : last.nonce + 1n };
  }

  private async countOf(commitments: readonly string[], signal?: AbortSignal): Promise<number> {
    const reads = this.reads;
    if (!reads || commitments.length === 0) return 0;
    let total = 0;
    for (let at = 0; at < commitments.length; at += COUNT_CHUNK) {
      const chunk = commitments.slice(at, at + COUNT_CHUNK);
      const counts = await reads.leaderboardCounts(chunk, signal);
      throwIfAborted(signal);
      if (!Array.isArray(counts) || counts.length !== chunk.length) {
        throw new PrivacyError('unknown', 'The placement read is invalid.');
      }
      for (const count of counts) total += smallCount(count);
    }
    return total;
  }

  /**
   * `p` for the season, through the connection's shared cache: asked once per
   * connection across every flow (a receipt, a check, a second check), and a
   * refusal is asked again next time. Memory only, as the cache is.
   */
  private partialCommitment(): Promise<string> {
    return this.commitments.commitment(LEADERBOARD_DAPP_NAME);
  }
}

/** Report a declined receipt by code, and answer null: the action goes out unchanged. */
function skipReceipt(reason: LeaderboardSkipReason): null {
  noticeLeaderboard({ event: 'receipt', attached: false, reason });
  return null;
}

function smallCount(value: unknown): number {
  if (typeof value !== 'bigint' || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new PrivacyError('unknown', 'The placement read is invalid.');
  }
  return Number(value);
}
