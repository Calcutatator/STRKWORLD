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
import { PrivacyError, type Address } from '../types.js';
import { shadowAccountAddress } from '../vault.js';
import { mapShadowWalletError } from './errors.js';
import { hasCommitmentMethod, isFelt, sameAddress, throwIfAborted } from './shadow-account.js';
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

/** A counter whose shadow account can tick the ledger: its own full commitment. */
export interface LedgerTickSource {
  commitment(): Promise<string>;
}

export interface LeaderboardReceiptsOptions {
  readonly wallet: WalletStrk20Account;
  readonly reads?: LeaderboardReadClient;
  readonly ledger: Address;
  /** The operations' own capability answer: `supportsShadowAccounts`. */
  readonly supported: (signal?: AbortSignal) => Promise<boolean>;
  /** The DeFi counters' shadow accounts (Vault, Borrow, Endur unstaking, Swap), whose ticks add to the count. */
  readonly features: readonly LedgerTickSource[];
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
}

const COUNT_CHUNK = LEADERBOARD_SHADOW_PAGE;
const MAX_PAGES = MAX_LEADERBOARD_RECEIPTS / LEADERBOARD_SHADOW_PAGE;

export class LeaderboardReceipts {
  readonly ledger: Address;
  private readonly wallet: WalletStrk20Account;
  private readonly reads?: LeaderboardReadClient;
  private readonly supported: (signal?: AbortSignal) => Promise<boolean>;
  private readonly features: readonly LedgerTickSource[];
  /** `p` once given, for this connection only. Deterministic, so asked once. */
  private partial: Promise<string> | null = null;
  /**
   * The lowest nonce not yet used by a transaction this connection submitted:
   * a submitted receipt is not on-chain until accepted, and the next action
   * must not reuse its shadow meanwhile. It only advances after a submit, so
   * a discarded batch never leaves a gap.
   */
  private floor = 0n;

  constructor(options: LeaderboardReceiptsOptions) {
    this.wallet = options.wallet;
    this.reads = options.reads;
    this.ledger = options.ledger;
    this.supported = options.supported;
    this.features = Object.freeze([...options.features]);
  }

  /**
   * The receipt for the next shield, unshield or send, or null when there
   * cannot be one (fail open: the action goes out unchanged).
   */
  async receiptFor(signal?: AbortSignal): Promise<PreparedReceipt | null> {
    try {
      if (!this.reads) return null;
      if (!(await this.supported(signal))) return null;
      throwIfAborted(signal);
      const partial = await this.partialCommitment();
      throwIfAborted(signal);
      const { next } = await this.scan(partial, signal);
      const nonce = next > this.floor ? next : this.floor;
      if (nonce >= BigInt(MAX_LEADERBOARD_RECEIPTS)) return null;
      return Object.freeze({
        action: receiptInvokeAction({ ledger: this.ledger, partialCommitment: partial, nonce }),
        nonce,
      });
    } catch {
      return null;
    }
  }

  /** A transaction carrying the receipt at `nonce` was submitted. */
  committed(nonce: bigint): void {
    if (nonce + 1n > this.floor) this.floor = nonce + 1n;
  }

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

    const { deployed } = await this.scan(partial, signal);
    const receipts = await this.countOf(deployed.map((nonce) => shadowCommitment(partial, nonce)), signal);

    // The DeFi counters' ticks: best effort, a refused or failed one adds nothing.
    const featureCommitments: string[] = [];
    for (const feature of this.features) {
      try {
        featureCommitments.push(await feature.commitment());
      } catch {
        throwIfAborted(signal);
      }
    }
    let defi = 0;
    try {
      defi = await this.countOf(featureCommitments, signal);
    } catch {
      throwIfAborted(signal);
    }

    let verified: number | null = null;
    try {
      const answer = await reads.leaderboardCheckIn(LEADERBOARD_SEASON, partial, signal);
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
    const ranked = verified ?? receipts;
    const placement = histogram ? placementFrom(histogram, ranked, verified !== null && verified > 0) : null;
    return Object.freeze({ season: LEADERBOARD_SEASON, receipts, defi, verified, histogram, ranked, placement });
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

  /** `p` for the season, asked once per connection; a refusal is asked again next time. */
  private partialCommitment(): Promise<string> {
    if (this.partial) return this.partial;
    const request = (async () => {
      let answer: unknown;
      try {
        if (!hasCommitmentMethod(this.wallet)) {
          throw new PrivacyError('shadow-accounts-unsupported', 'This wallet cannot check a private placement yet.');
        }
        answer = await this.wallet.strk20ShadowAccountCommitment!(LEADERBOARD_DAPP_NAME);
      } catch (error) {
        throw mapShadowWalletError(error);
      }
      if (typeof answer !== 'string' || !isFelt(answer) || BigInt(answer) === 0n) {
        throw new PrivacyError('unknown', 'The wallet returned an invalid commitment.');
      }
      return answer;
    })();
    this.partial = request;
    request.catch(() => {
      if (this.partial === request) this.partial = null;
    });
    return request;
  }
}

function smallCount(value: unknown): number {
  if (typeof value !== 'bigint' || value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new PrivacyError('unknown', 'The placement read is invalid.');
  }
  return Number(value);
}
