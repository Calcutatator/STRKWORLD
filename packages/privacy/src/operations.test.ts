import { describe, expect, it } from 'vitest';
import { FakePrivacyOperations } from './testing/fake.js';
import type { PrivacyOperations } from './operations.js';

/**
 * The D-036 freeze, made mechanical.
 *
 * `PrivacyOperations` is frozen at eleven methods: D-036's five, the two
 * entry-gate reads D-072 added, the Vault's three from D-077, and the Vault's
 * rates read D-079 added when it renamed the position read. Adding
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
] as const;

type PinnedMethod = (typeof PINNED_METHODS)[number];

/** The seam's callable members. A method demoted to data drops out. */
type SeamMethod = {
  [K in keyof PrivacyOperations]: PrivacyOperations[K] extends (...args: never[]) => unknown
    ? K
    : never;
}[keyof PrivacyOperations];

type MustBeNever<T extends never> = T;

/** Fails to compile when the seam gains a member the freeze does not list. */
type NoUnpinnedMember = MustBeNever<Exclude<keyof PrivacyOperations, PinnedMethod>>;

/** Fails to compile when a pinned method is removed or renamed. */
type NoMissingMember = MustBeNever<Exclude<PinnedMethod, keyof PrivacyOperations>>;

/** Fails to compile when a pinned member stops being callable. */
type EveryPinnedMemberIsAMethod = MustBeNever<Exclude<PinnedMethod, SeamMethod>>;

describe('D-036 PrivacyOperations freeze', () => {
  it('pins eleven distinct method names', () => {
    expect(new Set(PINNED_METHODS).size).toBe(11);
  });

  it('names methods the shipped test double implements', () => {
    const operations: PrivacyOperations = new FakePrivacyOperations();
    for (const method of PINNED_METHODS) {
      expect(typeof operations[method]).toBe('function');
    }
  });
});
