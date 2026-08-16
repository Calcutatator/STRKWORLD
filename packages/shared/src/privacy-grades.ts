/**
 * Privacy grading and the approval gate.
 *
 * **The default is absolute privacy.** Any integration that delivers less is a
 * deviation, and a deviation ships only if the project lead has approved it
 * *and* the game tells the player plainly what is visible.
 *
 * This file is the single source of truth for both halves: what grade a route
 * carries, and the exact words shown to the player. The UI imports the
 * disclosure string from here so copy cannot drift away from the grade it
 * describes.
 *
 * Enforced by `scripts/check-invariants.sh` check 8: an active route with a
 * grade below `private` and no recorded approval fails the build. Unapproved
 * means a locked door, never a quiet downgrade.
 *
 * Review the current state with `./scripts/privacy-report.sh`.
 */

import type { BuildingId } from './index.js';

/**
 * What an on-chain observer can learn.
 *
 * Ordered strongest to weakest. These are not marketing labels — each maps to
 * a verified property of the protocol, and the wording rules follow from it.
 */
export type PrivacyGrade =
  /**
   * Parties and amounts hidden. No public leg. Nothing an observer can read.
   * This is the default and the only grade that needs no approval.
   */
  | 'private'
  /**
   * Parties hidden, **amounts visible**. Anonymizer-mediated DeFi: open notes
   * carry the filled amount in plaintext by design, and the AMM leg is public.
   * "Nobody can link this to you" is defensible; "your amount is hidden" is not.
   */
  | 'anonymous'
  /**
   * The action has a public leg naming the actor and the amount. Shielding and
   * unshielding both do — every pool deposit names its depositor.
   */
  | 'public-edge'
  /**
   * No privacy claim at all. Ordinary public rails.
   */
  | 'public';

export interface RouteGrade {
  building: BuildingId;
  /** Short id for the specific action, e.g. `bank.shield`. */
  route: string;
  grade: PrivacyGrade;
  /** Precisely what an observer sees. Written for a reviewer, not a player. */
  observable: string;
  /**
   * Shown to the player before they commit, verbatim.
   * Required for anything below `private`. Plain language, no hedging.
   */
  disclosure: string | null;
  /**
   * Who approved this deviation, and when. `null` for `private` routes, which
   * need no approval — and for deviations that have not been approved yet,
   * which must render as a locked door.
   */
  approvedBy: string | null;
  approvedOn: string | null;
  /** Why the deviation is acceptable. Required whenever `approvedBy` is set. */
  rationale: string | null;
  /**
   * Whether finishing this route should funnel the player back to the pool.
   *
   * Pool STRK is the game's money and its gas (D-013), so any route that
   * leaves value sitting in public is an unfinished journey. The building must
   * offer the next step rather than letting the player walk away holding
   * something the game cannot use. See D-021.
   */
  returnToPool: boolean;
}

/**
 * The register. Every active financial route appears here exactly once.
 *
 * Adding a route without an entry fails CI. That is deliberate: a new
 * integration cannot reach players before its privacy level has been stated
 * and, if it is a deviation, approved.
 */
export const PRIVACY_REGISTER: readonly RouteGrade[] = [
  {
    building: 'post-office',
    route: 'post-office.transfer',
    grade: 'private',
    observable:
      'Nothing. A private transfer between two registered accounts has no public leg — sender, recipient, token and amount are all hidden.',
    disclosure: null,
    approvedBy: null,
    approvedOn: null,
    rationale: null,
    returnToPool: false,
  },
  {
    building: 'bank',
    route: 'bank.shield',
    grade: 'public-edge',
    observable:
      'The ERC-20 approve and the pool deposit are both public. Your address and the amount are visible on-chain. Deposits are always to self, so the depositor is always named.',
    disclosure:
      'Shielding is public. Your wallet address, token and amount will be visible on-chain. Privacy begins after the funds enter the pool.',
    approvedBy: 'calc',
    approvedOn: '2026-08-16',
    rationale:
      'Unavoidable: pool deposits are always to self, so the depositor is always named. Rejecting it would mean no way into the pool at all.',
    returnToPool: false,
  },
  {
    building: 'bank',
    route: 'bank.unshield',
    grade: 'public-edge',
    observable:
      'Withdrawal reveals token, amount and recipient. Withdrawing a similar amount to the same address shortly after depositing is publicly linkable by pattern alone.',
    disclosure:
      'Unshielding is public. The token, amount and destination address will be visible on-chain. Similar amounts or timing can link it to other public activity.',
    approvedBy: 'calc',
    approvedOn: '2026-08-16',
    rationale:
      'Unavoidable: the exit is public by construction. Accepted because a pool with no exit is not a product.',
    returnToPool: false,
  },
  {
    building: 'exchange',
    route: 'exchange.swap',
    grade: 'anonymous',
    observable:
      'Unlinkable but not amount-confidential. The withdraw leg to the executor is a public event with a visible amount, and the swap runs on public AMM liquidity. Who traded is hidden; what and how much is not.',
    disclosure:
      'This swap hides who traded, but not the tokens or amounts. The executor and public exchange activity are visible on-chain.',
    approvedBy: 'calc',
    approvedOn: '2026-08-16',
    rationale:
      'The AMM leg runs on public liquidity, so amounts cannot be hidden without rebuilding the DEX. Who traded is still hidden, which is the property that matters here.',
    // AVNU's private executor creates the bought asset as an OPEN pool note.
    returnToPool: false,
  },
  {
    building: 'bridge',
    route: 'bridge.deposit',
    grade: 'public',
    observable:
      'Entirely public. The solver delivers to your address with a visible amount, and the shield that follows has its own public leg. Privacy begins only after the funds are in the pool.',
    disclosure:
      'Bridging is public. Your destination address and amount are visible, and shielding afterwards is also public. Privacy begins only after the funds enter the pool.',
    approvedBy: 'calc',
    approvedOn: '2026-08-16',
    rationale:
      'Public rails are the only way in from another chain. Accepted because arrival was never the privacy promise — and the player is funnelled straight into the pool afterwards.',
    returnToPool: true,
  },
];

/** Grades that ship without approval. Everything else is a deviation. */
export const DEFAULT_GRADE: PrivacyGrade = 'private';

export function isDeviation(grade: PrivacyGrade): boolean {
  return grade !== DEFAULT_GRADE;
}

/**
 * Whether a route may be offered to players.
 *
 * A deviation without a recorded approval is not a soft warning — the door
 * stays locked. Silently degrading privacy is the one failure this whole
 * mechanism exists to prevent.
 */
export function isRoutePlayable(route: RouteGrade): boolean {
  if (!isDeviation(route.grade)) return true;
  return route.approvedBy !== null && route.disclosure !== null;
}

/** Deviations nobody has approved. These are decisions, not tasks. */
export function routesAwaitingApproval(): RouteGrade[] {
  return PRIVACY_REGISTER.filter(
    (r) => isDeviation(r.grade) && r.approvedBy === null,
  );
}

/**
 * Approved deviations still missing their player-facing copy.
 *
 * A different state from unapproved: the call has been made, the words have
 * not been written. Still locked — an approved deviation the player is not
 * told about is exactly the silent downgrade this prevents.
 */
export function routesAwaitingCopy(): RouteGrade[] {
  return PRIVACY_REGISTER.filter(
    (r) => isDeviation(r.grade) && r.approvedBy !== null && r.disclosure === null,
  );
}
