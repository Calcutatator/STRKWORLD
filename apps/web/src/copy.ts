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
function freezeCopy<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freezeCopy(child);
    Object.freeze(value);
  }
  return value;
}

export const COPY = freezeCopy({
  buildings: {
    bank: 'The Bank',
    exchange: 'The Exchange',
    'post-office': 'The Post Office',
    bridge: 'The Bridge',
    vault: 'The Vault',
    /** D-076: not a building, an open square; its windows use no money and no wallet. */
    plaza: 'The Privacy Plaza',
    /**
     * D-107: the hidden room has no name in the game. The Shell opens no
     * window for it (it is not in `BUILDINGS`); were one ever titled, it
     * would read as this ellipsis, never as a name.
     */
    bunker: '…',
    /** D-114: the gladiator pit's arena is a codename too: no window, so never titled; the same ellipsis. */
    arena: '…',
  },

  connect: {
    title: 'Connect your wallet',
    body: 'STRKWORLD asks your wallet to do the private part. Your keys and notes never leave it, and your wallet sends each finished transaction to the network itself.',
    action: 'Connect wallet',
    connecting: 'Waiting for your wallet…',
    retry: 'Try again',
    disconnect: 'Disconnect',
    choose: 'Choose a wallet',
    none: 'No compatible wallet was discovered.',
    /**
     * D-073: shown on a choose-a-wallet card only while discovery lists no
     * wallet. Display only: these links never feed discovery, the wallet list
     * or the STRK20 path, and a wallet named here is listed and treated
     * exactly like any other once it registers (SPEC §5 rules 1 and 2).
     */
    getWallet: 'Get a wallet:',
    installLinks: [
      { label: 'Ready', href: 'https://chromewebstore.google.com/detail/ready-x/dlcobpjiigpikoobohmabehhmhfoodbb' },
      { label: 'Xverse', href: 'https://chromewebstore.google.com/detail/xverse-wallet/idnnbdplmphpflfnlkomgpfbpcgelopg' },
    ],
    refreshWallets: 'Look again',
    wrongNetwork: 'Switch this wallet to Starknet mainnet, then try again.',
  },

  walletAttention: {
    connectTitle: 'Your wallet needs you',
    balanceTitle: 'Approve the balance read',
    confirmTitle: 'Confirm in your wallet',
    body: 'Finish this step in your wallet, then come back to the game.',
    tabTitle: '● Wallet needs you — STRKWORLD',
  },

  demo: {
    loadFailed: 'The local demo seam could not load.',
    retry: 'Try again',
  },

  /**
   * A connected wallet without the STRK20 methods, held at the capability
   * check: since the entry gate (D-055, D-072) nothing in the city opens for
   * it (D-073). `{Wallet}` starts a sentence and `{wallet}` sits inside one.
   * Both become the wallet's name as the picker lists it, a display-only
   * projection nothing compares, or `unnamed` / `unnamedInline` when the
   * shell has no name for it (`connect/unsupported-copy.ts`).
   */
  unsupported: {
    title: "{Wallet} can't open the privacy pool yet",
    body: "{Wallet} is connected but doesn't yet offer the STRK20 privacy methods STRKWORLD needs, so the city stays closed. Your funds are fine. Connect a wallet that supports STRK20 private balances, or check again once {wallet} adds them.",
    /** A wallet whose capability answer named a version below the city's. */
    tooOld: "{Wallet} is connected, but it reports Wallet API {version} and STRKWORLD needs {required} or later, so the city stays closed. Your funds are fine. Update {wallet} and check again, or connect a wallet that supports STRK20 private balances.",
    unnamed: 'Your wallet',
    unnamedInline: 'your wallet',
    action: 'Connect a different wallet',
  },

  /**
   * The entry gate (D-072): one check before the city opens, and the deposit
   * card for a player with nothing in the pool. The deposit's privacy
   * disclosure is the register's approved copy (D-024), shown at the commit
   * point by `ConfirmGate`, and never restated here. D-094: a STRK deposit
   * pays the pool fee on top, and its review shows the figures; the fee note
   * stays, without a figure, for another token, whose share of the STRK fee
   * cannot be stated.
   */
  entry: {
    title: 'One check before you enter',
    body: 'STRKWORLD is for people with funds in the STRK20 privacy pool. Your wallet will ask to share your private balance.',
    action: 'Enter STRKWORLD',
    checking: 'Waiting for your wallet to share your private balance…',
    /** On every card after the first check, so none is a dead end. The wallet asks first. */
    checkBalance: 'Check my private balance',
    depositTitle: 'Deposit to enter',
    depositBody: 'This account has nothing in the STRK20 privacy pool yet. Deposit any amount to enter.',
    token: 'Token',
    feeNote: "Part of a first deposit pays the pool's fee, so less than you deposit reaches the pool.",
    review: 'Review deposit',
    deposit: 'Deposit',
    landing: 'Deposit sent. Waiting for the network to confirm it…',
    unconfirmed: 'The network has not confirmed this deposit yet. It may still arrive, so check again in a moment.',
    receiptUnreachable:
      "STRKWORLD can't reach the network check right now, so it can't tell whether this deposit has arrived yet.",
    sentNotYet:
      'Your wallet shows nothing in the pool yet. A deposit you already sent may still be on its way, so check again before sending another.',
    checkAgain: 'Check again',
    reverted: 'This deposit did not go through on the network, so nothing entered the pool.',
    /**
     * A 119 at the gate: a shield draws on the wallet's public balance of the
     * chosen token, not the shielded balance `COPY.errors` speaks of. Written
     * around the token's symbol: "There is not enough USDC in your wallet's
     * public balance for this deposit."
     */
    publicShortLead: 'There is not enough',
    publicShortTail: "in your wallet's public balance for this deposit.",
    noToken: 'No token can be deposited in this build yet.',
  },

  /**
   * A shield's public leg at review, written around its exact amount and token
   * ("Depositing 0.5 STRK is public: …", `panels/bank/summary-copy.ts`). It
   * says what the seam's own warning says, in the token's decimals and symbol
   * instead of base units; the approved disclosure (D-024) sits below it,
   * unchanged, at the commit point.
   */
  warnings: {
    depositPublicLead: 'Depositing',
    depositPublicTail: 'is public: the amount and your address are visible on-chain.',
  },

  notRegistered: {
    title: 'Register with the pool first',
    body: 'The pool has no viewing key for this account yet, so it will not report a balance or move funds. Registration happens inside your wallet, and STRKWORLD cannot do it for you. It is recorded publicly on-chain, and this door checks it when you ask.',
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
    /** D-091: beside the balance line on an amount field. */
    refreshShort: 'Refresh',
    refreshLabel: 'Refresh balance',
    changed:
      'Your balance has changed. Read it again whenever you want the new figure — STRKWORLD will not ask your wallet on its own.',
    /** D-091: the shipped wallet's one total per token, which Max now uses. */
    maturityUnknown:
      'Your wallet reports one total, which can include funds you just added that are still settling for a few seconds.',
    /** D-091: the wallet refused a spend the reported total covers: a note is still maturing. */
    settling: 'Funds you just added are still settling; try again in a few seconds.',
    costUnknown:
      'The network cost depends on how much you queue, comes out of the same balance, and is only known once a visit of this shape has been costed. Review this visit once and the maximum appears.',
    maturing: 'Some of this is still maturing and cannot be spent yet.',
    feeReserved: 'The maximum leaves the pool fee behind, so you are not stranded one transaction short.',
    /** D-094: the Shield control's wallet balance, a public chain read that asks no wallet. */
    publicLoading: 'Reading your wallet balance…',
    publicFailed: "Couldn't read your wallet balance. Nothing was sent.",
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

  bank: {
    title: 'The Bank',
    shield: 'Shield',
    unshield: 'Unshield',
    transfer: 'Private transfer',
    stake: 'Stake',
    amount: 'Amount',
    recipient: 'To',
    /** An unshield goes to the connected wallet unless the player chooses another address. */
    toYourWallet: 'To: your wallet',
    sendToAnother: 'Send to another address',
    useMyWallet: 'Use my wallet',
    max: 'Max',
    /** D-091: the send's primary button before it has a recipient. */
    enterRecipient: 'Enter a recipient',
    checkRecipient: 'Check the address',
    poolFee: 'Pool fee',
    poolFeeNote: 'Read live from the pool. It is a governance setting and has moved before.',
    networkCost: 'Network cost',
    total: 'Total',
    /**
     * D-094: a shield's figures. The typed amount is what reaches the pool
     * balance, and the pool fee goes on top of it.
     */
    youShield: 'You shield',
    /** D-103: the other Bank-machine counters name what is entered the same way. */
    youUnshield: 'You unshield',
    youSend: 'You send',
    totalFromWallet: 'Total from your wallet',
    shieldFeeOnTop: 'The pool fee is added on top, so all of what you shield reaches your pool balance.',
    shieldFeeNudge: 'The pool fee is the same on every shield, so it costs proportionally less on a larger one.',
    shieldMaxNote: 'Max leaves the pool fee in your wallet to pay for this shield.',
    exceedsWallet: 'More than your wallet balance once the pool fee is added',
    shieldArrives: "Your wallet's shielded view shows the new funds after about 20 seconds, once they mature.",
  },

  exchange: {
    sell: 'Sell',
    buy: 'Buy',
    chooseAsset: 'Choose asset',
    expectedBuy: 'Expected buy',
    protectedMinimum: 'Protected minimum',
    slippage: 'Slippage',
    expiresAt: 'Quote expires',
    /**
     * D-084: the quote ran out before confirming, and avnu's fresh one would
     * lower the protected minimum, so the review shows it instead.
     */
    requoted: 'The quote expired and the price moved. Check the new protected minimum, then confirm again.',
    /**
     * D-084: the quote held against Pragma's on-chain oracle, read over the
     * wallet's own network connection. `{shortfall}` and `{bound}` are
     * percentages the counter fills in.
     */
    rate: 'Rate',
    usdValue: 'Oracle value',
    priceCheck: 'Price check',
    priceCheckedBelow: "{shortfall}% below Pragma's oracle price, within the {bound}% allowed.",
    priceCheckedAbove: "At or above Pragma's oracle price.",
    priceUnchecked:
      "No independent price check: Pragma's oracle has no price for at least one of these tokens, so nothing but avnu's quote says this rate is fair. The protected minimum only guards against the price moving after this quote.",
    acknowledgeUnchecked: 'I understand this swap has no independent price check.',
    acknowledgeFirst: 'Tick the box to confirm a swap with no independent price check.',
    /**
     * D-090: the compose view, in the words swap apps use (Uniswap's Sell,
     * Buy, Receive at least, Max slippage and Route via; avnu's Price
     * impact). Nothing here adds a privacy claim: the disclosure is at the
     * commit point, as before.
     */
    sellToken: 'Token to sell',
    buyToken: 'Token to buy',
    review: 'Review swap',
    receiveAtLeast: 'Receive at least',
    priceImpact: 'Price impact',
    /** Pragma prices one side or neither, so there is no independent figure to hold the output against. */
    priceImpactUnknown: 'Not known',
    priceImpactHigh: "Large price impact: you get noticeably less than Pragma's price for what you sell.",
    /** The review's collapsed section for everything beyond sell, buy and rate. */
    details: 'Details',
    poolFeeToken: 'Set in STRK. Your wallet chooses which token in your pool balance pays it.',
    quoting: 'Fetching a quote…',
    quotePaused: 'Press Review swap for a quote.',
    quoteStale: 'This quote ran out. Review swap asks for a fresh one.',
    slippageTitle: 'Max slippage',
    slippageHint: 'Your swap will not go through if the price moves more than this.',
    slippageCustom: 'Custom slippage',
    slippageHigh: 'High slippage: the price can move further against you before the swap stops it.',
    slippageOver: 'Enter a value up to {cap}%.',
    slippageZero: 'Enter a value larger than 0.',
    slippageInvalid: 'Enter a percentage, such as 0.5.',
    slippageFix: 'Check the slippage',
  },

  /**
   * The Exchange's degen floor (D-067). A degen swap is the same private swap
   * as downstairs, with the same register disclosure at commit, so nothing
   * here adds a privacy claim; and nothing here calls a listed token safe or
   * checked (`copy.test.ts` checks both).
   */
  degen: {
    eyebrow: 'Degen mode',
    intro:
      'Degen mode lists community tokens avnu has not verified, next to ones it has. Routed liquidity is thin, so a quote can be far worse than the market. The protected minimum still applies to every swap.',
    tags: "The chips are avnu's own tags. A tag is avnu's label for a token, not a promise about it.",
    listTitle: 'Listed in degen mode',
    displayOnly: 'Display only',
    displayOnlyNote: 'Display only: listed here, but this build cannot swap it.',
    displayOnlyNotice: 'That token is listed for display only. This build cannot swap it.',
    loading: 'Loading the degen list…',
    notReady: 'The degen list has not loaded yet.',
    unavailable: 'The degen list could not be loaded. Nothing was sent.',
    retry: 'Load the list again',
    curatedOnly: "avnu's live list could not be reached, so only the core list is shown.",
    demo: "Demo list and demo rates: these are not avnu's live tokens or market prices.",
  },

  /**
   * The Bank's Endur staking counter (D-063). D-064 waived its in-game
   * disclosure, and in exchange this copy claims no amount privacy: it says
   * where the STRK comes from and where the xSTRK lands, and never that
   * anything about the stake is hidden (`copy.test.ts` checks). The unstaking
   * line is how the product works, not a privacy disclosure.
   */
  stake: {
    eyebrow: 'Liquid staking with Endur',
    intro: 'Stake STRK from your pool balance with Endur. The xSTRK you receive lands in your pool balance.',
    /** D-085: unstaking is a counter of its own (D-103: UNSTAKE, beside STAKE). */
    unstaking:
      "To unstake, use the Unstake counter. Endur's withdrawal queue holds the STRK for about seven days, sometimes longer, before it can come back to your pool balance.",
    /** D-091: the preview rows. Estimates at xSTRK's live rate, never shown at review. */
    willReceive: 'You will receive',
    exchangeRate: 'Exchange rate',
    rateLine: '1 xSTRK = {rate} STRK',
    rateLoading: 'Reading the rate…',
    rateUnavailable: 'Unavailable right now',
    /** The demo fake's fixed rate, said to be one. */
    demoRate: "Demo rate, not Endur's.",
    oneAtATime: 'This counter prepares and confirms one stake at a time.',
    youStake: 'You stake',
    youReceive: 'You receive',
    outputToken: 'xSTRK',
    /** No figure is shown because neither the seam nor the prepared batch carries one (D-063). */
    amountAtExecution:
      "The xSTRK lands in your pool balance. Endur's vault sets the exact amount when the stake runs, so there is no figure to show before you confirm.",
  },

  /**
   * Endur unstaking through a shadow account (D-085). Plain words for how it
   * works: the request waits on a stand-in address that anyone can look up
   * but that is not linked to the wallet, and claiming moves the STRK back
   * into the pool balance. The route's approved disclosure is the register's,
   * shown at the commit point; nothing here says amounts are hidden
   * (`copy.test.ts` checks).
   */
  unstake: {
    title: 'Unstake xSTRK',
    intro:
      "Send xSTRK from your pool balance into Endur's withdrawal queue. The request waits on a stand-in address: anyone can look it up, but it is not linked to your wallet. When Endur releases the STRK, claim it and it returns to your pool balance.",
    wait: "Endur's queue holds the STRK for about seven days, sometimes longer while Endur gathers it. Endur often pays a ready request to the stand-in address on its own; claiming then just moves it into your pool balance.",
    amount: 'xSTRK to unstake',
    /** D-091: the preview row for Endur's wait, measured on chain (D-085). */
    waitingTime: 'Waiting time',
    waitValue: 'About 7 days',
    request: 'Review unstake request',
    readRequests: 'Show my unstaking requests',
    readAgain: 'Read my requests again',
    readNote: 'One read, from the chain. It does not update on its own.',
    loading: 'Reading Endur…',
    none: 'No unstaking requests are waiting.',
    pendingTitle: 'Waiting at Endur',
    statusWaiting: 'left',
    statusReady: 'Ready to claim',
    /** D-085: past its wait, but Endur's queue cannot pay it yet, so a claim would be refused. */
    statusAwaitingFunds: 'Waiting for Endur to fund it',
    owedLead: 'Owed',
    heldLead: 'Already paid to the stand-in address, ready to claim:',
    leftoverLead: 'xSTRK still on the stand-in address, which your next request returns to your pool balance:',
    unlisted: 'Some older requests on the stand-in address could not be listed. Endur still pays them there, and a claim collects them.',
    incomplete: 'The chain could not list every request this time, so some may be missing here. Read again in a moment.',
    claim: 'Review claim',
    nothingReady: 'Nothing is ready to claim yet.',
    standInLead: 'Your unstaking stand-in address,',
    standInTail: 'is public: anyone can look up its requests and what it holds. It is not your wallet, and not your Vault address.',
    feeNote: 'Each request and claim pays the pool fee from your pool balance, so keep some STRK there.',
    reviewRequest: 'You send to Endur',
    /** D-103: the standard's first row, at the form and the review. */
    youUnstake: 'You unstake',
    /** D-103: a request's STRK is named, never numbered, at the review (D-041). */
    receiveLater: 'STRK, when Endur releases it',
    reviewRequestTail: "Nothing comes back yet: Endur fixes the STRK it owes when the request runs, and you claim it once Endur releases it.",
    reviewLeftover: 'Also returns to your pool balance',
    reviewClaim: 'You claim',
    reviewClaimTail: 'Every STRK on the stand-in address returns to your pool balance, in one note. Endur pays only once its queue holds the STRK; if it does not yet, your wallet will refuse and nothing is sent.',
    requestsCount: 'ready requests',
    noXstrk: 'You have no xSTRK in your pool balance, so there is nothing to unstake. Stake some first.',
    changed: 'Your unstaking changed. Read your requests again to see it.',
    networkByWallet: 'Your wallet shows it',
    voyager: 'View it on Voyager',
    voyagerNote: 'Opens a new tab. Voyager sees your IP address when it loads.',
    submitted: {
      succeeded: 'Done. The network confirmed it.',
      pending: 'Sent. The network has not confirmed it yet, so read your requests again in a moment.',
      reverted: 'This did not go through on the network, so nothing moved.',
    },
  },

  /**
   * The Vault (D-077): Vesu lending from the player's STRK20 shadow account,
   * in every token D-079 pins a vault for. What is public about it is the
   * register's approved disclosure, shown at the commit point and never
   * restated here; so nothing below says that anything is hidden or private
   * (`copy.test.ts` checks). The fee lines are how the product works, not a
   * privacy disclosure. `standIn` is the one exception, and only in the
   * other direction: it says the stand-in address is public, as the
   * disclosure does, and claims nothing hidden.
   */
  vault: {
    locked: 'The Vault — lending with Vesu. Not open yet.',
    eyebrow: 'Lending with Vesu',
    intro: "Supply from your pool balance to Vesu's vaults, and redeem back into your pool balance whenever a vault can pay out.",
    feeNote: 'Each supply and redeem pays the pool fee from your pool balance, so keep enough there to come back out.',
    /**
     * D-079: shown while a token other than STRK is chosen. The pool fee is
     * set in STRK; the wallet picks the token that repays it, and wallets
     * have taken it in STRK as well as in other tokens, so STRK is worth
     * keeping on hand. No figure: the review shows the fee.
     */
    feeInStrk:
      'The pool fee is set in STRK, whichever token you lend. Your wallet chooses which token in your pool balance pays it, and that can be STRK, so keep some STRK there too.',
    checking: 'Checking what your wallet supports…',
    recheck: 'Check again',
    supply: 'Supply',
    redeem: 'Redeem',
    token: 'Token',
    amount: 'Amount',
    /**
     * D-089: the form's lending touches. A supply's field shows the pool
     * balance once the player asks for it (the wallet may ask first), a
     * redeem's shows what is supplied; Max on a redeem of the whole position
     * redeems every share, so "Redeem everything" is Max now.
     */
    form: {
      supplied: 'Supplied',
      overSupplied: 'More than you have supplied',
      showBalance: 'Show my pool balance',
      balanceLoading: 'Asking your wallet for your pool balance…',
      balanceUnavailable: 'Balance unavailable.',
      balanceAgain: 'Read it again',
      /** Written around the figure: "Vesu can pay out 12.5 USDC of it right now." */
      payoutLead: 'Vesu can pay out',
      payoutTail: 'of it right now.',
      willSupply: 'You will supply',
      /** D-103: what a supply gets out directly: the same amount, now in Vesu. */
      inVesu: 'Supplied to Vesu',
      willReceive: 'You will receive',
      /** D-089: the wallet refused a supply that counted a note still maturing (about ten blocks). */
      settling: 'Funds you just added are still settling; try again in a few seconds.',
    },
    /** D-079: a build whose Vault list names no token the counter can describe. */
    noToken: 'No token can be lent in this build yet.',
    /**
     * D-081: a collateral-only market, where Vesu lends none of the token
     * out. It is never offered for supply; one holding a position is listed
     * and redeemable.
     */
    collateralOnly: 'Collateral only: Vesu lends none of it out here, so it earns nothing, and it is not offered for supply. You can still redeem it.',
    /** D-081: a mode with nothing to offer in this build. */
    noSupply: 'No token here can be supplied: Vesu lends none of them out.',
    noRedeem: 'Nothing to redeem yet. Read your positions to see what you hold.',
    /** D-081: the picker's groups, and the headings of the market list. */
    groups: {
      majors: 'Majors',
      stables: 'Stables',
      btc: 'Bitcoin',
      staking: 'Staking tokens',
      ecosystem: 'Ecosystem',
    },
    /**
     * D-081: where a market lends. Prime is named as it is; a curated pool
     * reads "Re7 xBTC, curated", and one line says what curated means.
     */
    pools: {
      label: 'Pool',
      curated: 'curated',
      curatedNote: 'Curated pools are run by their own curators, with their own risk settings.',
    },
    /**
     * D-081: a supply takes the token from the pool balance. Written around
     * the token's symbol: "Supplying USDC takes it from your pool balance."
     * and, once a review found none there, "You have no USDC in your pool
     * balance, so there is nothing to supply. Shield some first, or choose
     * another token."
     */
    holding: {
      neededLead: 'Supplying',
      neededTail: 'takes it from your pool balance.',
      noneLead: 'You have no',
      noneTail: 'in your pool balance, so there is nothing to supply. Shield some first, or choose another token.',
    },
    position: {
      title: 'Your Vault positions',
      unrequested: 'STRKWORLD reads your positions from the chain only when you ask. Your wallet may ask you first.',
      show: 'Show my positions',
      loading: 'Reading your positions…',
      again: 'Read my positions again',
      /** D-079: the figures are one read, not a live feed. */
      asOf: 'These figures are from your last read and do not update on their own.',
      worth: 'Worth now',
      redeemable: 'Redeemable now',
      /** One token with nothing in its vault. */
      none: 'Nothing supplied',
      empty: 'Nothing is in the Vault yet.',
      changed: 'Your Vault positions have changed. Read them again to see the new figures.',
    },
    /**
     * D-079: Vesu's current supply APY for each token, from Vesu's public
     * API through STRKWORLD's backend, and always labelled as Vesu's figure.
     * Written around the figure: "Supply APY 2.73%, Vesu's figure".
     */
    rates: {
      label: 'Supply APY',
      source: "Vesu's figure",
      unavailable: "Vesu's rates can't be read right now.",
    },
    /**
     * D-079: the stand-in address, once a read has resolved it. Written
     * around the shortened address: "Your stand-in address, 0x2491…91ac9, is
     * public: anyone can look up what it holds." The link is the player's
     * choice, and the note says what opening it tells Voyager.
     */
    standIn: {
      lead: 'Your stand-in address,',
      tail: 'is public: anyone can look up what it holds.',
      voyager: 'View it on Voyager',
      voyagerNote: 'Opens a new tab. Voyager sees your IP address when it loads.',
    },
    review: {
      supply: 'You supply',
      redeem: 'You redeem',
      redeemAll: 'You redeem everything, about',
      /** No figure is promised: Vesu fixes the amount when the redeem runs. */
      allNote: "Vesu fixes the exact amount when the redeem runs, so the figure above is the vault's own preview.",
      /** Written around the token's symbol: "The USDC lands in your pool balance." */
      landsInLead: 'The',
      landsInTail: 'lands in your pool balance.',
      /** The wallet submits the Vault and adds its own network fee, so STRKWORLD states none. */
      networkByWallet: 'Added and shown by your wallet when it asks',
      /** D-079: beside the pool fee when the action moves a token other than STRK. */
      feeTokenByWallet: 'Set in STRK. Your wallet chooses which token in your pool balance pays it.',
    },
    submitted: {
      succeeded: 'Done. The network confirmed it.',
      pending: 'Sent. The network has not confirmed it yet, so read your positions again in a moment.',
      reverted: 'This did not go through on the network, so nothing moved in the Vault.',
    },
  },

  /**
   * The Borrow counter (D-083): Vesu loans in its Prime pool from the
   * player's second STRK20 shadow account, at a counter in the Vault's room.
   * What is public about it, and that a loan can be liquidated, is the
   * register's approved disclosure, previewed while composing and shown at
   * the commit point; nothing below says anything is hidden or private
   * (`copy.test.ts` checks). `risk` explains how Vesu liquidates a loan, in
   * plain words and without a privacy claim; `standIn` says the address is
   * public, as the disclosure does. The figures are Vesu's own, from its
   * oracle and its pool, and say so.
   */
  borrow: {
    eyebrow: 'Borrowing with Vesu',
    intro: "Borrow against collateral from your pool balance, in Vesu's Prime pool. What you borrow, and collateral you take back, lands in your pool balance.",
    feeNote: 'Each action pays the pool fee from your pool balance, so keep enough there to come back out.',
    feeInStrk:
      'The pool fee is set in STRK, whichever token you move. Your wallet chooses which token in your pool balance pays it, and that can be STRK, so keep some STRK there too.',
    checking: 'Checking what your wallet supports…',
    recheck: 'Check again',
    modes: {
      borrow: 'Borrow',
      'add-collateral': 'Add collateral',
      repay: 'Repay',
      'withdraw-collateral': 'Withdraw collateral',
    },
    collateral: 'Collateral',
    debt: 'Borrow',
    collateralAmount: 'Collateral to add',
    borrowAmount: 'Amount to borrow',
    amount: 'Amount',
    /**
     * D-089: the form's lending touches. Max borrows to a health factor of
     * 1.25, safer than D-083's 1.05 floor; on a repay it repays everything,
     * and on a withdrawal with nothing owed it withdraws everything.
     */
    form: {
      available: 'Available to borrow',
      health: 'Health factor',
      remaining: 'Remaining debt',
      /** D-103: what adding collateral and repaying get out directly. */
      addedToLoan: 'Added to your loan',
      paidOff: 'Debt paid off',
      owed: 'Owed',
      held: 'Collateral',
      noDebt: '∞',
      maxHint: 'Max keeps your health factor at 1.25 or more. Anything under 1.05 is refused.',
      readLoans: 'Show your loans above to see what you can borrow and your health factor after.',
      /** D-102: the collateral this pair already holds, and where collateral comes from. Written before the figure: "Your collateral: 0 STRK". */
      yourCollateral: 'Your collateral',
      collateralReading: 'reading…',
      collateralUnread: 'not read yet',
      collateralSource: 'Your Vault supply is not collateral here. Add collateral below, from your pool balance.',
      /** Fills the collateral field with the pool balance, less the pool fee in STRK. */
      maxCollateral: 'Max collateral',
      addCollateralFirst: 'Add collateral first.',
      belowFloorHint: "Vesu's smallest loan is worth about $10, so add more collateral.",
      /** Why "Available to borrow" shows no figure (D-102). */
      availableWhy: {
        'loans-loading': 'Reading your loans…',
        'loans-unread': 'Read your loans first',
        'no-collateral': 'Add collateral first',
        stale: 'Price feed stale',
        'not-offered': 'Not offered right now',
        'at-limit': 'None at a health factor of 1.25',
        'no-liquidity': 'Vesu has none to lend right now',
        'below-floor': "Under Vesu's $10 minimum",
      },
      tooLow: 'Health factor too low',
      overDebt: 'More than you owe',
      overCollateral: 'More than the loan holds',
      repayAllLine: 'Max repays everything: interest included, fixed by Vesu when it runs.',
      withdrawAllLine: 'Max withdraws all the collateral.',
    },
    /** Written around the figure: "Max LTV 68.00%". */
    maxLtv: 'Max LTV',
    noPair: 'Vesu offers no loans in these tokens right now.',
    noLoan: 'No loan to change yet. Read your loans to see what you hold.',
    /** How Vesu liquidates a loan, said plainly. Shown beside every form. */
    risk: {
      title: 'How a loan can be lost',
      lines: [
        "Vesu prices your collateral and your debt with its own price feed. Your loan-to-value (LTV) is what you owe over what your collateral is worth.",
        "If the LTV passes the pair's max LTV, anyone can liquidate the loan: repay some of it and take your collateral at a discount. Nothing in STRKWORLD can stop that.",
        "If Vesu's price feed goes stale, Vesu refuses every change to the loan, repaying included, until it updates.",
      ],
    },
    market: {
      loading: "Reading Vesu's pool…",
      failed: "Vesu's pool can't be read right now.",
      again: 'Try again',
      /** Vesu's figures, one read. */
      source: "Vesu's figures, from its price feed and pool as last read.",
    },
    loans: {
      title: 'Your loans',
      unrequested: 'Your loans have not been read. Your wallet may ask you first.',
      show: 'Show my loans',
      loading: 'Reading your loans…',
      again: 'Read my loans again',
      asOf: 'These figures are from your last read and do not update on their own. Prices move all the time.',
      empty: 'You have no loans yet.',
      changed: 'Your loans have changed. Read them again to see the new figures.',
      collateral: 'Collateral',
      debt: 'Owed now',
      ltv: 'LTV',
      health: 'Health',
      liquidation: 'Liquidation price',
      /** Written around the price and symbols: "If STRK falls to $0.0147 and USDC holds its price, anyone can liquidate this loan." */
      liquidationLead: 'If',
      liquidationMid: 'falls to',
      liquidationAnd: 'and',
      liquidationTail: 'holds its price, anyone can liquidate this loan.',
      stale: "Vesu's price feed for this pair is stale, so no figure is shown and Vesu refuses every change until it updates.",
    },
    /** A loan's band, by Vesu's own rule. */
    bands: {
      safe: 'Healthy',
      warning: 'Close to liquidation',
      liquidatable: 'Can be liquidated now',
      none: 'Nothing owed',
      unknown: 'Price feed stale',
    },
    warningNote:
      "This loan is close to its max LTV: a small fall in the collateral's price would let anyone liquidate it. Add collateral or repay some of the debt to move it back.",
    liquidatableNote:
      'This loan is past its max LTV, so anyone can liquidate it now. Repay or add collateral at once if you can.',
    /**
     * The borrow stand-in address, once a read has resolved it. Written
     * around the shortened address. It is not the Vault's address.
     */
    standIn: {
      lead: 'Your borrow stand-in address,',
      tail: 'is public: anyone can look up its loans, and liquidate one that passes its max LTV.',
      voyager: 'View it on Voyager',
      voyagerNote: 'Opens a new tab. Voyager sees your IP address when it loads.',
    },
    /** Why the counter refused before asking the wallet (`BorrowRefusal`). */
    refusals: {
      amount: 'Enter an amount above zero.',
      'unknown-pair': 'That pair is not offered here.',
      'pair-not-offered': 'Vesu does not offer new loans in that pair right now.',
      'stale-price': "Vesu's price feed for that pair is stale, so Vesu refuses every change to it until the feed updates.",
      'above-max-ltv': "That would take the loan above the pair's max LTV, so Vesu would refuse it. Borrow less, or add more collateral.",
      /** D-083: risk-adding actions keep a margin, since prices move while the wallet proves and sends. */
      'too-close-to-liquidation':
        "That would leave the loan too close to liquidation: Vesu's prices can move in the time your wallet takes to prove and send it. Borrow less or add more collateral; to take collateral back, withdraw less or repay some first.",
      'review-expired': 'This review is more than two minutes old, and interest or prices may have moved since. Review it again.',
      'debt-below-floor': "Vesu needs a debt worth more than its minimum, about $10. Borrow more, or repay everything instead.",
      'collateral-below-floor': "Vesu needs collateral worth more than its minimum, about $10, while you owe anything.",
      'debt-cap': "That would pass the pair's debt cap on Vesu.",
      utilization: 'Vesu cannot lend or release that much of the token right now.',
      'nothing-to-repay': 'There is nothing owed in that pair.',
      'repay-exceeds-debt': 'That is the whole debt or more. Use Max to repay everything instead.',
      'withdraw-exceeds-collateral': 'That is more collateral than the loan holds.',
      'withdraw-all-with-debt': 'Repay everything before withdrawing all the collateral.',
    },
    review: {
      borrow: 'You borrow',
      collateral: 'You add as collateral',
      repay: 'You repay',
      repayAll: 'You repay everything, at most',
      withdraw: 'You withdraw',
      withdrawAll: 'You withdraw all the collateral, about',
      /** No figure is promised for a repay-all: Vesu fixes it when it runs. */
      bufferNote:
        'Vesu fixes the exact amount when the repay runs, interest included. The figure above has a small buffer in it, and whatever of the buffer Vesu does not take returns to your pool balance.',
      withdrawAllNote: "Vesu fixes the exact amount when the withdrawal runs, so the figure above is Vesu's own count now.",
      /** Written around the token's symbol: "The USDC lands in your pool balance." */
      landsInLead: 'The',
      landsInTail: 'lands in your pool balance.',
      after: 'After this',
      networkByWallet: 'Added and shown by your wallet when it asks',
      feeTokenByWallet: 'Set in STRK. Your wallet chooses which token in your pool balance pays it.',
    },
    submitted: {
      succeeded: 'Done. The network confirmed it.',
      pending: 'Sent. The network has not confirmed it yet, so read your loans again in a moment.',
      reverted: 'This did not go through on the network, so your loan did not change.',
    },
  },

  /**
   * The Privacy Plaza (D-076): a no-money square with two windows. The
   * monument shows public, pool-wide figures only, never anything about the
   * player, and says where they come from; the shell game touches no money, no
   * wallet and no backend. Every line keeps to what the pool really hides:
   * notes inside it, not its public edges (`copy.test.ts` checks).
   */
  plaza: {
    monument: {
      title: 'The privacy pool, live',
      intro: 'Public figures for the whole STRK20 privacy pool, read from its own events on Starknet. Nothing here is about you.',
      accounts: 'Accounts registered',
      /** D-098: the pool's total USD value, shown once; the 24-hour deposit count is gone. */
      total: 'Total in the pool',
      topHoldings: 'Top holdings',
      /** D-080: the pool's USD value comes from Voyager through strkprice.com's public proxy, backend-only. */
      source: 'Values from Voyager via strkprice.com, updated every minute.',
      unknown: '\u2026',
      failed: "The pool's figures can't be read right now. They fill in again once they can.",
      demo: 'Demo figures: this practice city shows sample numbers, not the live pool.',
      setTitle: 'Why the crowd matters',
      set: [
        'An anonymity set is the crowd you hide in: everyone who could have made the move you made.',
        'Each account that joins the pool makes every other one harder to pick out.',
        'So the more people use the pool, the more privacy everyone in it gets.',
      ],
      edges: 'Deposits and withdrawals are public, so an unusual amount or a quick in-and-out makes your crowd smaller.',
    },
    shells: {
      title: "Where's the note?",
      intro: 'A note hides under one of three cups. Watch it, then find it after the shuffle.',
      pool: "In the pool, notes look alike from outside. Without your viewing key, no one can tell which ones are yours.",
      fun: 'Just for fun: no money, no wallet, nothing saved.',
      start: 'Hide the note',
      again: 'Play again',
      watch: 'Watch the note…',
      shuffling: 'Shuffling…',
      pick: 'Which cup is the note under?',
      win: 'You found the note.',
      loseLead: 'Not that one. The note was under cup',
      cup: 'Cup',
      streak: 'Streak',
    },
  },

  /**
   * The Post Office, and every transfer line elsewhere. D-065 waived the
   * transfer's in-game disclosure, and in exchange this copy never claims the
   * recipient is hidden: "send privately" may stay (`copy.test.ts` checks).
   */
  postOffice: {
    intro: 'Send privately to a STRK20 pool account belonging to another player. They must already be registered with the pool to receive it.',
    oneAtATime: 'Each send goes to one recipient and is confirmed on its own.',
  },

  bridge: {
    title: 'The Bridge',
    deposit: 'Deposit',
    unavailable: 'The Bridge planner is unavailable, so this route stays locked.',
    plannerUnavailable: 'Shield planning is not available in this build, so funding instructions stay hidden.',
    recoveryUnavailable: 'Saved Bridge recovery is unavailable in this browser. Your wallet and the rest of the city are unaffected.',
    accountRequired: 'Connect the account that should receive this deposit before creating a quote.',
    accountChanged: 'The active account changed. This record remains bound to its original recipient; reconnect that account before continuing.',
    noRecord: 'No bridge deposit is saved on this device.',
    source: 'From',
    amount: 'Amount',
    recipient: 'Recipient',
    refundAddress: 'Refund address',
    expected: 'Expected STRK',
    /** D-091: the quote's rows, as wallets and bridges name them. */
    willReceive: 'You will receive',
    estTime: 'Est. time',
    estTimeNote: 'Once your deposit confirms on its own chain.',
    estMinutes: '~{minutes} min',
    estUnderMinute: 'Under a minute',
    status: 'Status',
    minimum: 'Minimum STRK',
    deadline: 'Quote deadline',
    depositAddress: 'Deposit address',
    memo: 'Memo',
    instructions: 'Send the exact amount to this address. Arrival is public; shielding is a separate step at the Bank.',
    quote: 'Get a deposit quote',
    preflight: 'Prepare deposit instructions',
    refresh: 'Check for deposit',
    watch: 'Watch for deposit',
    resume: 'Resume saved deposit',
    stopWatching: 'Stop watching',
    shield: 'Review shield at the Bank',
    shieldUnavailable: 'Shield planning is unavailable or the connected account does not match this record.',
    planChanged: 'The fresh shield plan changed, so nothing was signed. Review the new estimate before continuing.',
    settled: 'The actual STRK received is the amount available to shield.',
    sensitive: 'This record contains addresses, timing and signed provider evidence. Treat exports and imports as sensitive.',
    export: 'Export sensitive record',
    import: 'Import sensitive record',
    discard: 'Discard record',
    providerFee: 'Provider fee: 0.2% of the bridged amount. Pool and network costs are separate.',
    preflightFailed: 'Shield planning failed, so deposit instructions remain hidden. Keep this signed quote as evidence or discard it and try again.',
    preflightExpired: 'This signed quote is expired or no longer awaiting deposit, so deposit instructions remain hidden.',
    busy: 'A Bridge request is still finishing. Keep this evidence open and try again when it completes.',
    statusFailed: 'The bridge status could not be checked. The saved record was kept.',
    watchFailed: 'The bridge watch could not be completed. The saved record was kept.',
    importFailed: 'The sensitive bridge record could not be imported.',
    plan: 'Shield plan',
    amountToShield: 'Amount to shield',
    poolFee: 'Pool fee estimate',
    gasEstimate: 'Public gas estimate',
    plannedReserve: 'Planned reserve',
    /** D-061: shown wherever the Bridge shows its planned shield or hands it to the Bank. */
    reserveStaysPublic:
      'The planned reserve is not shielded. It stays in your wallet as public STRK to cover the pool fee and network gas. Whatever is not spent stays there, still public.',
    refundedAmount: 'Refunded amount',
  },

  gameMode: {
    menu: 'Menu Mode',
    exit: 'Leave building',
    /** D-103: every counter does one action and confirms it, and each pays its own pool fee. */
    singleAction: 'This counter confirms one action at a time, and each action pays its own pool fee.',
    reviewAction: 'Review this action',
    /** D-088: names Menu Mode's row of counter tabs for assistive tech. */
    counters: 'Counters',
  },

  presence: {
    connecting: 'Connecting to multiplayer…',
    connected: 'Multiplayer connected',
    suspended: 'Playing inside',
    unavailable: 'Multiplayer unavailable — playing solo.',
    reconnect: 'Reconnect multiplayer',
  },

  /** The street HUD (`hud/HudLayer.tsx`). Status words only; no privacy claim. */
  hud: {
    label: 'Your wallet and balance',
    wallet: {
      unknown: 'Checking wallet…',
      connecting: 'Connecting wallet…',
      connected: 'Wallet connected',
      disconnected: 'Wallet not connected',
      unsupported: 'Wallet cannot open the pool',
      unregistered: 'Register in your wallet',
    },
    balance: 'Shielded balance',
    balanceUnknown: 'Check at the Bank',
    balanceHidden: 'Hidden',
    hide: 'Hide',
    show: 'Show',
    hideBalance: 'Hide balance',
    showBalance: 'Show balance',
    pendingOne: 'action in progress',
    pendingMany: 'actions in progress',
    pendingNone: 'No actions in progress',
    help: 'Getting started',
  },

  /**
   * The first-run card (`hud/GettingStarted.tsx`). The controls are the
   * World's real bindings; the route never calls the Bridge private.
   */
  guide: {
    title: 'Getting started',
    intro: 'Every building on this street is a Starknet protocol. Walk in to use one.',
    controlsTitle: 'Controls',
    controls: [
      { input: 'WASD or arrow keys', effect: 'Walk. Up always heads away from the camera.' },
      { input: 'Shift', effect: 'Hold while walking to sprint.' },
      { input: 'Space', effect: 'Jump. Works anywhere you can walk, standing, walking or sprinting; not while a counter or Menu Mode is open. Jump to climb onto a block one higher than you: walking into it just stops you.' },
      { input: 'F', effect: 'Swap your outfit.' },
      { input: 'E', effect: 'Use what you stand at when its E prompt shows: a counter, the Privacy Plaza\'s monument or table, an outfit in the Avatar Studio. Walking up never opens anything by itself, and on a touch screen you tap the prompt instead. In the sandbox, pick up the block in front of you, and press E again to put it down. On the football pitch, kick the ball when E · KICK shows.' },
      { input: 'Esc', effect: 'Close a counter or Menu Mode.' },
    ],
    buildingsTitle: 'Inside a building',
    buildings:
      'Walk through a door to go in. Walk up to a lit counter and press E when its prompt shows to open it; a grey one is not open in this build yet, and Menu Mode says why. Walk back out, or press Leave building, to return to the street.',
    routeTitle: 'A first route',
    /** Shown step by step, only while each route is open in this build (`hud/guide-route.ts`). */
    route: {
      bridge: 'The Bridge brings funds in from another chain. Arrival is public. Skip it if you already hold STRK on Starknet.',
      bank: 'The Bank shields them into the pool.',
      swapOrSend: 'Swap at the Exchange, or send from the Post Office.',
      swap: 'Swap at the Exchange.',
      send: 'Send from the Post Office.',
      none: 'No money route is switched on in this build yet. The street and the sandbox are open to explore.',
    },
    routeNote: 'You review every action before you confirm it, and nothing moves until you do.',
    sandboxTitle: 'The sandbox',
    sandbox:
      'The road ends in a sandbox square. Blocks drop from the sky: press E to pick one up and E again to put it down, and build with whoever else is there. Press Space to jump up onto a block, one at a time.',
    plazaTitle: 'The Privacy Plaza',
    plaza:
      "At the street's west end, beside the football pitch, a square with no money in it. Press E at the monument for the pool's live figures, or at the table to play Where's the note?",
    pitchTitle: 'The football pitch',
    pitch:
      'The road begins at a football pitch with one ball for everyone there. Walk into the ball to dribble it, or press E when E · KICK shows to kick it away from you. West shoots east and East shoots west; the first side to 5 wins, and the score starts again from 0–0.',
    dismiss: 'Got it',
    stationHint: 'Walk up to a lit counter and press E to open it; grey ones are not open yet. Menu Mode opens the full menu.',
  },

  /** Next-step prompts (`panels/next-step.ts`) and the D-021 Bridge nudge. */
  next: {
    shieldAtBank: 'Next: shield at the Bank',
    afterShield: 'Next: swap at the Exchange or send from the Post Office.',
    afterShieldSend: 'Next: send from the Post Office.',
    afterShieldSwap: 'Next: swap at the Exchange.',
    afterSwap: 'Next: send it privately from the Post Office.',
    afterTransfer:
      'All done here. Take a walk down the street, or build something in the sandbox where the road ends.',
    afterStake: 'All done here. Your xSTRK lands in your pool balance.',
    bridgeArrival: 'Your bridged STRK arrived publicly — shield it at the Bank.',
    bridgeArrivalHere:
      'Your bridged STRK arrived publicly. Shield it here, and keep enough back to cover the fees.',
    dismiss: 'Dismiss',
    dismissLabel: 'Dismiss this reminder',
  },

  locked: {
    comingSoon:
      'This building is shut. It opens once its private route is built, reviewed and approved.',
    unapprovedRoute:
      'This door stays locked. The route behind it gives up more privacy than the default, and no approved disclosure exists for it yet.',
    unknownRoute:
      'This door stays locked. STRKWORLD has no approved private route for it, and there is no public shortcut on offer.',
    /** Approved by the privacy register, but this build's wallet policy has not switched it on (D-054/D-056). */
    notEnabled: {
      generic: "This route isn't switched on in this build yet.",
      shield: "Shield isn't switched on in this build yet.",
      unshield: "Unshield isn't switched on in this build yet.",
      transfer: "Private transfer isn't switched on in this build yet.",
      swap: "Swap isn't switched on in this build yet.",
      stake: "Staking isn't switched on in this build yet.",
      /** D-085: one policy route gates the unstake request and the claim alike. */
      unstake: "Unstaking isn't switched on in this build yet.",
      /** D-077: the Vault's one policy route gates supply and redeem alike. */
      vault: "The Vault isn't switched on in this build yet.",
      /** D-083: the Borrow counter's one policy route gates its four actions. */
      borrow: "Borrowing isn't switched on in this build yet.",
    },
  },

  /**
   * Plain-English "what's this?" disclosures next to review-screen jargon
   * (`panels/Glossary.tsx`). Kept separate from the field labels above them —
   * `bank.poolFee` etc. stay the visible label; these are the expandable
   * explanation underneath it.
   */
  glossary: {
    toggle: "What's this?",
    protectedMinimum:
      'The least amount you are guaranteed to receive, even if the market moves against you before this settles.',
    bridgeMinimum:
      'The least STRK this quote delivers if the bridge completes. If it cannot complete, 1Click refunds your deposit instead, so it is not a guarantee of arrival.',
    /** D-090: the player sets the slippage with the cog; the review states what this swap carries. */
    slippageFixedAt: 'This swap carries a slippage of',
    slippageReason:
      'chosen with the settings cog. It is fixed once quoted, which is what lets the protected minimum above be a guarantee rather than an estimate.',
    quoteExpiry:
      'After this time the quote is asked for again before your wallet is. If the fresh price would lower the protected minimum, you see it first; nothing trades at a stale price.',
    refundAddress: 'Where funds are sent back if this deposit cannot be completed.',
    memo: 'A short tag the destination needs to identify your deposit. Leaving it out can cause the deposit to be delayed or lost.',
    poolFee: 'The protocol fee the STRK20 pool charges for this action. It is set by governance and read live, never hardcoded.',
    networkCost: 'The Starknet network gas for this action, separate from the pool fee.',
    maturingFunds:
      'Funds you shielded need a fixed number of blocks before they can be spent. Until then they count toward your balance but are not available yet.',
    xstrk:
      "xSTRK is Endur's liquid staking token: a share of the STRK staked with Endur, so the STRK it stands for changes over time. What you receive lands in your pool balance.",
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
    /** The same rule met from the other side: a spend is already queued, often one whose prepare failed. */
    shieldAfterSpend:
      'A spend is already queued, and a shield cannot travel with it. Remove the queued item first, then add the shield.',
    mixedRouteKinds: 'One visit settles as one kind of action. Confirm what is queued, or clear it, then start the other one.',
    swapAlone: 'A swap settles on its own.',
    stakeAlone: 'A stake settles on its own.',
    oneRecipientPerSend: 'One recipient per send. Confirm this transfer, then send the next.',
    oneUnshieldPerSend: 'One unshield per send. Confirm this one, then unshield again.',
    batchFull: 'That is as much as one visit can settle at once.',
    emptyBatch: 'There is nothing queued to confirm.',
    notAnIntent: 'STRKWORLD only sends the actions its own controls produce.',
    poolNotLoaded: 'Still reading the pool settings.',
    disclosureMissing:
      'This cannot be confirmed: the approved wording for what it makes public is missing, and STRKWORLD will not ask you to agree to something it cannot describe.',
    feeMoved:
      'The pool fee moved above the total you were shown, so nothing was signed. Prepare it again to see the new figure.',
    bridgePlanMoved:
      'The fresh shield plan changed, so nothing was signed. Review the new estimate before continuing.',
  },

  errors: {
    'not-registered':
      'The pool does not know this account yet. Register inside your wallet, then come back.',
    /** D-074: a fact about the recipient, so it stays in the panel and never moves the connect flow. */
    'recipient-not-registered':
      "That recipient hasn't set up private balances yet, so they can't receive a private transfer. Nothing was sent.",
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
    /**
     * D-070, narrowed by D-082 and D-084: the deployment has no avnu key for
     * its relay. No player flow uses the relay any more, so this only reads
     * if one ever did again.
     */
    'relay-not-configured':
      "This needs the private relay, which isn't set up on this site yet. Nothing was sent.",
    /**
     * D-077, D-084: the Vault and the Exchange need a wallet that runs STRK20
     * shadow accounts. A fact about the wallet's release, not the account: it
     * stays in the building, and every other one works as before.
     */
    'shadow-accounts-unsupported':
      "Your wallet doesn't support shadow accounts yet, and the Vault and the Exchange need one. Nothing was sent, and every other building works as before.",
    unknown: 'That did not go through, and nothing was signed.',
  } satisfies Record<PrivacyErrorKind, string>,

  /**
   * The shared panel kit (`panels/kit`). Wording follows the rest of the
   * shell: a balance is the pool balance, and a button says what it will do
   * or why it cannot yet. `{symbol}` is filled in by the kit.
   */
  kit: {
    poolBalance: 'Pool balance',
    /** D-094: the public balance a shield draws on, never called a pool balance. */
    walletBalance: 'Wallet balance',
    max: 'Max',
    half: '50%',
    maxLabel: 'Fill in the most you can use',
    halfLabel: 'Fill in half of the most you can use',
    enterAmount: 'Enter an amount',
    chooseToken: 'Choose a token',
    insufficient: 'Insufficient {symbol}',
    invalidAmount: 'Enter a valid amount',
    belowMinimum: 'Below the minimum',
    exceedsBalance: 'More than your pool balance',
    belowMinimumDetail: 'The minimum is {minimum}.',
    invalidDetail: 'Use digits and one decimal point, with no more decimal places than the token has.',
    settings: 'Settings',
    custom: 'Custom',
    flip: 'Swap direction',
    invert: 'Show the inverse rate',
    refreshIn: 'Quote refreshes in {seconds}s',
    refreshing: 'Refreshing quote…',
    paste: 'Paste',
    pasteLabel: 'Paste an address',
    addressPlaceholder: 'Enter address',
    /**
     * D-103, the owner's standard: every counter's amounts read as what you
     * enter, what you receive, the fees on top, and the total.
     */
    youReceive: 'You receive',
    theyReceive: 'They receive',
    /** D-103: the amount fits the balance, but not with the pool fee on top. */
    exceedsWithFee: 'More than your pool balance once the pool fee is added',
    totalFromPool: 'Total from your pool',
    totalFromWallet: 'Total from your wallet',
    amountsLabel: 'Amounts',
  },

  submissionUncertainty: {
    acknowledge: 'I refreshed and checked my private balance',
    acknowledged:
      'A previous private action is still unconfirmed. You checked your refreshed balance before continuing.',
  },
} as const satisfies Record<string, unknown> & { errors: Record<PrivacyErrorKind, string> });

/** Flattened for the copy tests. Order is not meaningful. */
export function allCopyStrings(node: unknown = COPY, out: string[] = []): string[] {
  if (typeof node === 'string') {
    out.push(node);
  } else if (node && typeof node === 'object') {
    for (const value of Object.values(node)) allCopyStrings(value, out);
  }
  return out;
}
