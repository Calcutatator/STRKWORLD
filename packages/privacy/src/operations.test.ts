import { describe, expect, it } from 'vitest';
import { FakePrivacyOperations } from './testing/fake.js';
import type { PrivacyOperations } from './operations.js';

/**
 * The D-036 freeze, made mechanical.
 *
 * `PrivacyOperations` is frozen at five methods. Adding a sixth, or removing or
 * renaming one of these, needs a decision entry and a heads-up to dependent
 * lanes before implementation, so it must not be possible to do it quietly.
 * These assertions turn seam drift into an error in the package typecheck.
 */
const PINNED_METHODS = [
  'capability',
  'poolConfig',
  'balances',
  'recipientStatus',
  'prepare',
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
  it('pins five distinct method names', () => {
    expect(new Set(PINNED_METHODS).size).toBe(5);
  });

  it('names methods the shipped test double implements', () => {
    const operations: PrivacyOperations = new FakePrivacyOperations();
    for (const method of PINNED_METHODS) {
      expect(typeof operations[method]).toBe('function');
    }
  });
});
