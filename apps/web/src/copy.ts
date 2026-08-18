import type { PrivacyErrorKind } from '@strkworld/privacy';

/**
 * Every player-facing string the shell owns, in one place.
 *
 * Two rules, both enforced by `copy.test.ts` rather than by remembering:
 *
 * 1. **"your wallet", never "your extension".** v1 ships against wallets that
 *    happen to be browser extensions, but the whole forward-compatibility
 *    design (SPEC §5) exists so a web wallet or an embedded wallet can appear
 *    with no rewrite. Copy naming the delivery mechanism ages badly the day
 *    that happens.
 * 2. **No privacy disclosure lives here.** Those are canonical approved copy in
 *    `packages/shared/src/privacy-grades.ts` (D-024) and are imported verbatim.
 *    A paraphrase in this file would be a privacy claim nobody reviewed.
 */
export const COPY = {
  buildings: {
    bank: 'The Bank',
    exchange: 'The Exchange',
    'post-office': 'The Post Office',
    bridge: 'The Bridge',
    vault: 'The Vault',
  },

  connect: {
    title: 'Connect your wallet',
    body: 'STRKWORLD asks your wallet to do the private part. Your keys, your notes and your proofs never leave it.',
    action: 'Connect wallet',
    connecting: 'Waiting for your wallet…',
    retry: 'Try again',
    disconnect: 'Disconnect',
  },

  unsupported: {
    title: 'This wallet cannot open the pool',
    body: 'Your wallet is connected but does not offer the STRK20 privacy methods this city runs on. Your funds are fine — the doors that need the pool stay shut until you connect a wallet that supports it.',
    action: 'Connect a different wallet',
  },

  notRegistered: {
    title: 'Register with the pool first',
    body: 'The pool has no viewing key for this account yet, so it will not report a balance or move funds. Registration happens inside your wallet: STRKWORLD cannot do it for you and cannot see when you have.',
    action: 'I have registered — check again',
    hint: 'Open your wallet, register with the privacy pool, then come back to this door.',
  },

  unreachable: {
    title: 'Cannot reach your wallet',
    body: 'The connection dropped before your wallet answered. Nothing was sent and nothing was signed.',
    action: 'Try again',
  },

  balance: {
    unrequested:
      'Balances are private. Your wallet asks you before sharing them, so STRKWORLD only reads one when you say so — never on a timer.',
    loading: 'Asking your wallet for your balance…',
    refresh: 'Show my balance',
    refreshAgain: 'Read it again',
    changed:
      'Your balance has changed. Read it again whenever you want the new figure — STRKWORLD will not ask your wallet on its own.',
    maturityUnknown:
      'Your wallet reports one total and decides for itself which notes are old enough to spend, so there is no maximum to fill in here.',
    costUnknown:
      'The network cost depends on how much you queue, comes out of the same balance, and is only known once a visit of this shape has been costed. Review this visit once and the maximum appears.',
    maturing: 'Some of this is still maturing and cannot be spent yet.',
    feeReserved: 'The maximum leaves the pool fee behind, so you are not stranded one transaction short.',
  },

  flow: {
    preparing: 'Preparing with your wallet…',
    handingOver: 'Handing this to your wallet…',
    awaitingApproval: 'Confirm in your wallet',
    proving: 'Your wallet is building the proof. This takes a while.',
    submitting: 'Submitting',
    confirming: 'Waiting for the network',
    done: 'Done',
    review: 'Check this before you confirm',
    confirm: 'Confirm',
    cancel: 'Cancel',
    back: 'Back to the counter',
    close: 'Close',
    submitted: 'Sent.',
    /**
     * Said without a number on purpose. How many times a wallet asks is a
     * source-derived expectation awaiting the funded run (D-028), and printing
     * a count is how a provisional finding becomes a promise to a player.
     */
    mayAskMoreThanOnce: 'Your wallet may ask you to confirm more than once.',
    closingWillNotCancel:
      'Your wallet is signing. Closing this room will not cancel it, and your receipt will be waiting when you come back.',
    receiptWaiting: 'This settled while the room was shut.',
  },

  batch: {
    title: 'This visit',
    empty: 'Nothing queued yet. Add what you want to do, then confirm once.',
    add: 'Add to this visit',
    clear: 'Clear',
    remove: 'Remove',
    why: 'Everything queued here settles as one action, so you pay the pool fee once and your wallet asks you once.',
  },

  bank: {
    title: 'The Bank',
    shield: 'Shield',
    unshield: 'Unshield',
    transfer: 'Private transfer',
    amount: 'Amount',
    recipient: 'To',
    max: 'Max',
    poolFee: 'Pool fee',
    poolFeeNote: 'Read live from the pool. It is a governance setting and has moved before.',
    networkCost: 'Network cost',
    total: 'Total',
  },

  locked: {
    comingSoon:
      'This building is shut. It opens once its private route is built, reviewed and approved.',
    unapprovedRoute:
      'This door stays locked. The route behind it gives up more privacy than the default, and no approved disclosure exists for it yet.',
    unknownRoute:
      'This door stays locked. STRKWORLD has no approved private route for it, and there is no public shortcut on offer.',
  },

  unbuilt: 'This room is still being built.',

  boot: 'Waking up the city…',
  productionNotWired:
    'STRKWORLD is not wired to a live wallet yet. This build runs against a practice city, which is disabled here on purpose — no real balance would ever be shown.',
  crashed: 'Something in the city fell over. Reloading the page will bring it back.',

  notices: {
    badAmount: 'That is not an amount this token can hold. Check the number and the decimal places.',
    badRecipient: 'That does not look like a Starknet address.',
    recipientUnregistered:
      'That address is not registered with the pool, so it cannot receive a private transfer. They register inside their own wallet.',
    recipientUnknown:
      'We could not check whether that address is registered. The transfer may still be refused when your wallet tries it.',
    mixedShieldAndSpend:
      'Shielding and spending cannot travel together: a deposit names you publicly, and bundling the two would publish the link the pool exists to break. Confirm the shield on its own first.',
    mixedRouteKinds: 'One visit settles as one kind of action. Confirm what is queued, or clear it, then start the other one.',
    swapAlone: 'A swap settles on its own.',
    batchFull: 'That is as much as one visit can settle at once.',
    emptyBatch: 'There is nothing queued to confirm.',
    notAnIntent: 'STRKWORLD only sends the actions its own controls produce.',
    poolNotLoaded: 'Still reading the pool settings.',
    disclosureMissing:
      'This cannot be confirmed: the approved wording for what it makes public is missing, and STRKWORLD will not ask you to agree to something it cannot describe.',
    feeMoved:
      'The pool fee moved above the total you were shown, so nothing was signed. Prepare it again to see the new figure.',
  },

  errors: {
    'not-registered':
      'The pool does not know this account yet. Register inside your wallet, then come back.',
    'insufficient-balance':
      'There is not enough in your shielded balance for this, once the pool fee is counted.',
    'privacy-leak':
      'Your wallet refused this on privacy grounds. Try it as a smaller, separate action.',
    'unsupported-wallet':
      'Your wallet does not support the version of the privacy API this needs.',
    'user-rejected': 'You declined it in your wallet. Nothing was sent.',
    unreachable: 'Could not reach the network or your wallet. Nothing was sent.',
    'submission-uncertain':
      'We could not confirm whether this private action was submitted. Do not retry it yet. Reconnect, wait a few minutes, and refresh your private balance before taking another action.',
    unknown: 'That did not go through, and nothing was signed.',
  } satisfies Record<PrivacyErrorKind, string>,
} as const;

/** Flattened for the copy tests. Order is not meaningful. */
export function allCopyStrings(node: unknown = COPY, out: string[] = []): string[] {
  if (typeof node === 'string') {
    out.push(node);
  } else if (node && typeof node === 'object') {
    for (const value of Object.values(node)) allCopyStrings(value, out);
  }
  return out;
}
