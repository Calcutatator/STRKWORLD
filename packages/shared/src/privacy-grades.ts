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
 * The one exception to "the game tells the player" is explicit and narrow: the
 * project lead may waive a route's player-facing disclosure by decision entry
 * (`disclosureWaivedBy`, e.g. D-064). The grade and `observable` still record
 * exactly what an observer sees; only the in-game copy is waived, and the
 * route's own copy must not claim more privacy than its grade.
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
   * Who acted is hidden, but **part of the action is public**. Anonymizer-
   * mediated DeFi hides the parties but not the amounts: open notes carry the
   * filled amount in plaintext by design, and the AMM leg is public. "Nobody
   * can link this to you" is defensible; "your amount is hidden" is not. The
   * private transfer (D-065) hides sender and amount, but a first send
   * publishes the recipient, so "the recipient is hidden" is not defensible.
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
   * The decision entry (e.g. `D-064`) under which the project lead waived this
   * deviation's player-facing disclosure. Absent or null for every route that
   * shows its disclosure, which is the rule. A waiver replaces only the
   * `disclosure` string; approval and rationale are still required.
   */
  disclosureWaivedBy?: string | null;
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
    // D-065: regraded from `private` after a verified mainnet finding; the
    // lead waived the in-game disclosure.
    grade: 'anonymous',
    observable:
      'Sender and amount hidden, recipient not always. A first transfer to a new recipient opens a channel keyed by their address: the address is in plaintext calldata and the pool counts a new channel for it in that block, so an observer learns that this address received a first private payment, and when. Later transfers to the same recipient add no such record. The wallet submits the send (D-082) and the network fee it adds leaves the pool publicly, to the avnu paymaster forwarder in Ready, and the proof publishes the block it was built against, which dates the confirm. One recipient per send (D-065), so a submission never links several recipients.',
    disclosure: null,
    approvedBy: 'calc',
    approvedOn: '2026-09-27',
    rationale:
      'The sender and amount stay hidden, which the lead accepts for private sends; the first-send recipient record cannot be avoided through the Wallet API. The player-facing disclosure is waived by D-065, and the copy claims no recipient privacy.',
    disclosureWaivedBy: 'D-065',
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
  // D-063, 2026-09-27: Endur private staking, graded like the swap and built
  // switched off in production. Approved by the lead, with its in-game
  // disclosure waived by D-064 (see DISCLOSURE_WAIVERS below).
  {
    building: 'bank',
    route: 'bank.stake',
    grade: 'anonymous',
    observable:
      'Unlinkable but not amount-confidential. The pool withdraws the staked STRK to the Endur deposit anonymizer as a public transfer with a visible amount, the anonymizer deposits it into the public xSTRK vault, and the minted xSTRK is credited to an open note whose amount is plaintext. Who staked is hidden; that a stake happened, when, and how much went in and came out is not. There is no private unstake: the Endur withdrawal queue takes 1 to 14 days and no withdraw anonymizer exists.',
    // The lead waived the in-game disclosure (D-064). `observable` above is
    // still the exact record of what an observer sees.
    disclosure: null,
    approvedBy: 'calc',
    approvedOn: '2026-09-27',
    rationale:
      'Endur liquid staking through its live STRK20 deposit anonymizer (D-063): the staker is unlinkable, which the lead accepts for a stake-only counter. The player-facing disclosure is waived by D-064; the counter claims no amount privacy.',
    disclosureWaivedBy: 'D-064',
    // The anonymizer credits the minted xSTRK to an OPEN pool note.
    returnToPool: false,
  },
  // D-072, 2026-09-29: the entry gate's deposit. The Bank's own shield,
  // offered on a second surface at the city's entrance, so it is graded under
  // the Bank with the Bank shield's approved disclosure word for word.
  {
    building: 'bank',
    route: 'entry.shield',
    grade: 'public-edge',
    observable:
      'The same pool deposit as bank.shield: the ERC-20 approve and the deposit are both public, and the pool emits a Deposit event naming the depositor and the token, with the amount. Your address, the token and the amount are visible on-chain. Deposits are always to self, so the depositor is always named.',
    disclosure:
      'Shielding is public. Your wallet address, token and amount will be visible on-chain. Privacy begins after the funds enter the pool.',
    approvedBy: 'calc',
    approvedOn: '2026-09-29',
    rationale:
      'D-072: entry needs funds in the pool, so a player with none must be able to deposit at the gate. It is the Bank shield on a second surface with the same grade and disclosure; without it such a player would have no way in.',
    returnToPool: false,
  },
  // D-077, 2026-09-29: the Vault lends to Vesu from the player's STRK20
  // shadow account, through the canonical ShadowAccountAnonymizer, behind a
  // fail-closed build switch. Graded like Endur staking (D-063): who acted is
  // hidden, what the chain shows is not. Both routes show one disclosure.
  // D-079 extends both to every token with a pinned Vesu Prime vault, and
  // D-081 to every pinned Vesu market, in the Prime pool or a curated one.
  // The grade and the disclosure name no token and no pool, so they hold
  // unchanged; the observable says what an observer sees for any of them.
  {
    building: 'vault',
    route: 'vault.supply',
    grade: 'anonymous',
    observable:
      'Unlinkable to the wallet, but public and persistent. The pool withdraws the token supplied to the player shadow account as a public transfer with a visible token and amount, and the canonical ShadowAccountAnonymizer then has that address approve the pinned Vesu vault for that token, in the Vesu Prime pool or a curated pool, and deposit into it, so the vault shares sit on the shadow account. Its address, deployment, balances in every token, calls and positions are public, and every Vault action by the same player, in any token and any pool, uses the same address (dapp name strkworld-vault, nonce 0), so they are linked to each other. Only the link from that address to the wallet is hidden: the wallet is not the sender and never appears in the calls. The wallet fee withdrawal leaves the pool publicly, in whichever token the wallet pays it with, and the proof publishes the block it was built against. Matching amounts or timing around a public deposit can still link the two.',
    disclosure:
      'Your Vault position sits on a stand-in address, not your wallet. That address, its balance and every supply and redeem you make through it, with their amounts, are public on-chain. Only its link to your wallet is hidden, and matching amounts or timing can still give that link away.',
    approvedBy: 'calc',
    approvedOn: '2026-09-29',
    rationale:
      'D-077: shadow accounts let the Vault lend through Vesu with no project-owned Cairo, which D-007 and D-018 had required. The lead accepts a persistent stand-in address whose balance and activity are public, because its link to the wallet is hidden and the disclosure says plainly what is not. The first live use is the probe of wallet support.',
    returnToPool: false,
  },
  {
    building: 'vault',
    route: 'vault.redeem',
    grade: 'anonymous',
    observable:
      'Unlinkable to the wallet, but public and persistent. The canonical ShadowAccountAnonymizer has the player shadow account withdraw or redeem from the pinned Vesu vault for the token, in the Vesu Prime pool or a curated pool, a public call with visible amounts, and the pool collects only the token that call gained into an open note for the wallet, whose token and amount are plaintext. The shadow account keeps its address, history and any other public balance, and every Vault action by the same player, in any token and any pool, uses that one address, so they are linked to each other. Only the link from that address to the wallet is hidden. The wallet fee withdrawal leaves the pool publicly, in whichever token the wallet pays it with, and the proof publishes the block it was built against.',
    disclosure:
      'Your Vault position sits on a stand-in address, not your wallet. That address, its balance and every supply and redeem you make through it, with their amounts, are public on-chain. Only its link to your wallet is hidden, and matching amounts or timing can still give that link away.',
    approvedBy: 'calc',
    approvedOn: '2026-09-29',
    rationale:
      'D-077: the way back from the Vault position into the pool. The same stand-in address and the same public record as the supply, and the same disclosure, so a player reads one account of the Vault whichever way they move.',
    // The token collected lands in an OPEN pool note, already private.
    returnToPool: false,
  },
  // D-083, 2026-10-01: borrowing on Vesu's Prime pool from a second STRK20
  // shadow account, the Borrow counter in the Vault's room, behind its own
  // fail-closed build switch. One route for its four actions (open or borrow
  // more, add collateral, repay, withdraw collateral), graded like the Vault:
  // who acted is hidden, what the chain shows is not, and a loan can be
  // liquidated, which the Vault's disclosure never said, so it has its own.
  {
    building: 'vault',
    route: 'vault.borrow',
    grade: 'anonymous',
    observable:
      'Unlinkable to the wallet, but public, persistent and liquidatable. Each action is one private transaction. The pool withdraws any collateral or repayment to the player borrow shadow account (dapp name strkworld-borrow, nonce 0, not the Vault address) as a public transfer with a visible token and amount, and the canonical ShadowAccountAnonymizer has that address approve the Vesu Prime pool and call modify_position on its own position, so the collateral and the debt sit on it. Borrowed or withdrawn tokens are collected into an open note for the wallet whose token and amount are plaintext, and a repay-all collects its unused buffer the same way. The address, its balances, its positions in every pair and every call are public, and every loan by the same player uses that one address, so they are linked to each other, though not to the Vault address. Anyone can liquidate the position once it is undercollateralized at the Vesu oracle price, exactly as any Vesu position. Only the link from that address to the wallet is hidden: the wallet is not the sender and never appears in the calls. The wallet fee withdrawal leaves the pool publicly, and the proof publishes the block it was built against. Matching amounts or timing around a public deposit can still link the two.',
    disclosure:
      'Your loans sit on a second stand-in address, not your wallet and not your Vault one. That address, its collateral, its debt and every change you make, with their amounts, are public on-chain, and like any Vesu loan anyone can liquidate it if its collateral loses too much value. Only its link to your wallet is hidden, and matching amounts or timing can still give that link away.',
    approvedBy: 'calc',
    approvedOn: '2026-10-01',
    rationale:
      'D-083: the lead chose borrowing on Vesu through its own shadow account, so loans are not linkable to Vault supply, with a disclosure that says plainly the position is public and can be liquidated like any Vesu position. The same route as the Vault (D-077), a second Vesu entry point, no project-owned Cairo. Off by default; no live borrow through a shadow account has been made yet.',
    returnToPool: false,
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
  return hasNonBlankText(route.approvedBy) &&
    hasNonBlankText(route.approvedOn) &&
    hasNonBlankText(route.rationale) &&
    (hasNonBlankText(route.disclosure) || isDisclosureWaived(route));
}

/**
 * Every disclosure waiver the lead has granted, by route, with its decision.
 *
 * The one list a waiver must appear in. An entry's own `disclosureWaivedBy`
 * only counts when it names exactly the decision recorded here for that
 * route, so no other route can switch its disclosure off by citing some
 * decision that merely mentions it. Adding a waiver means a decision entry,
 * this table and the register entry, all together.
 */
export const DISCLOSURE_WAIVERS: Readonly<Record<string, string>> = Object.freeze({
  'bank.stake': 'D-064',
  'post-office.transfer': 'D-065',
});

/**
 * Whether the lead waived this route's player-facing disclosure by decision.
 *
 * Only an own data property naming the decision `DISCLOSURE_WAIVERS` records
 * for this exact route counts, so a malformed, inherited or borrowed value can
 * never switch a disclosure off.
 */
export function isDisclosureWaived(route: RouteGrade): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(route, 'disclosureWaivedBy');
  if (descriptor === undefined || !('value' in descriptor)) return false;
  const granted = Object.hasOwn(DISCLOSURE_WAIVERS, route.route) ? DISCLOSURE_WAIVERS[route.route] : undefined;
  return typeof descriptor.value === 'string' && granted !== undefined && descriptor.value === granted;
}

function hasNonBlankText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
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
    (r) => isDeviation(r.grade) && r.approvedBy !== null && r.disclosure === null && !isDisclosureWaived(r),
  );
}
