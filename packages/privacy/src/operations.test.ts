import { describe, expect, it } from 'vitest';
import { FakePrivacyOperations } from './testing/fake.js';
import type { PrivacyOperations } from './operations.js';

/**
 * The D-036 freeze, made mechanical.
 *
 * `PrivacyOperations` is frozen at nineteen methods: D-036's five, the two
 * entry-gate reads D-072 added, the Vault's three from D-077, the Vault's
 * rates read D-079 added when it renamed the position read, the Borrow
 * counter's three from D-083, and Endur unstaking's read and two prepared
 * batches from D-085, xSTRK's rate read from D-091, and the public
 * balance read from D-094. Adding
 * another, or removing or renaming one of these, needs a decision entry and a
 * heads-up to dependent lanes before implementation, so it must not be
 * possible to do it quietly. These assertions turn seam drift into an error
 * in the package typecheck.
 */
const PINNED_METHODS = [
  'capability',
  'poolConfig',
  'balances',
  'recipientStatus',
  'prepare',
  // D-072: the entry gate's boolean funds check and its public deposit receipt read.
  'hasPrivateFunds',
  'depositStatus',
  // D-077: the Vault's position read and its two prepared shadow-account batches.
  // D-079: the read covers every admitted token and names the stand-in address.
  'vaultPositions',
  'prepareVaultSupply',
  'prepareVaultRedeem',
  // D-079: Vesu's supply APY for each admitted token, a public read.
  'vaultRates',
  // D-083: the Borrow counter's market and loans reads, and its prepared batch.
  'borrowMarket',
  'borrowPositions',
  'prepareBorrow',
  // D-085: Endur unstaking through its own shadow account.
  'endurUnstakePosition',
  'prepareEndurUnstake',
  'prepareEndurClaim',
  // D-091: xSTRK's live exchange rate, a public read.
  'endurRate',
  // D-094: the account's public balance of one token, which a shield draws on.
  'publicBalance',
  // Leaderboard phase 1: the private placement, counted on-chain, ranked on the device.
  'checkPlacement',
] as const;

type PinnedMethod = (typeof PINNED_METHODS)[number];

/**
 * Optional members, pinned the same way (D-122, amended 2026-10-03): the
 * placement's "will the wallet prompt?" read and the disconnect-time forget of
 * this connection's cached commitments. Optional so an implementation that
 * caches nothing, and the Shell's demo seam, need not offer them; the wallet
 * adapter does (`commitment-cache.test.ts`).
 */
const PINNED_OPTIONAL_METHODS = ['placementWillPrompt', 'forgetCommitments'] as const;

type PinnedOptionalMethod = (typeof PINNED_OPTIONAL_METHODS)[number];
type PinnedMember = PinnedMethod | PinnedOptionalMethod;

/** The seam's callable members. A method demoted to data drops out. */
type SeamMethod = {
  [K in keyof PrivacyOperations]-?: NonNullable<PrivacyOperations[K]> extends (...args: never[]) => unknown
    ? K
    : never;
}[keyof PrivacyOperations];

type MustBeNever<T extends never> = T;

/** Fails to compile when the seam gains a member the freeze does not list. */
type NoUnpinnedMember = MustBeNever<Exclude<keyof PrivacyOperations, PinnedMember>>;

/** Fails to compile when a pinned method is removed or renamed. */
type NoMissingMember = MustBeNever<Exclude<PinnedMember, keyof PrivacyOperations>>;

/** Fails to compile when a pinned member stops being callable. */
type EveryPinnedMemberIsAMethod = MustBeNever<Exclude<PinnedMember, SeamMethod>>;

/** Fails to compile when a pinned optional member becomes required. */
type EveryOptionalMemberStaysOptional = MustBeNever<
  Exclude<PinnedOptionalMethod, {
    [K in keyof PrivacyOperations]-?: undefined extends PrivacyOperations[K] ? K : never;
  }[keyof PrivacyOperations]>
>;

describe('D-036 PrivacyOperations freeze', () => {
  it('pins twenty distinct required method names, and two optional ones', () => {
    expect(new Set(PINNED_METHODS).size).toBe(20);
    expect(new Set(PINNED_OPTIONAL_METHODS).size).toBe(2);
  });

  it('names methods the shipped test double implements', () => {
    const operations: PrivacyOperations = new FakePrivacyOperations();
    for (const method of PINNED_METHODS) {
      expect(typeof operations[method]).toBe('function');
    }
  });
});
