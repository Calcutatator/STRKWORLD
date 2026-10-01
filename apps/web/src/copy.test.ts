import { describe, expect, it } from 'vitest';
import { PRIVACY_REGISTER } from './privacy/register.js';
import { unsupportedCopy } from './connect/unsupported-copy.js';
import { COPY, allCopyStrings } from './copy.js';

describe('shell copy', () => {
  it('keeps the authored copy tree immutable at the public seam', () => {
    expect(Object.isFrozen(COPY)).toBe(true);
    expect(Object.isFrozen(COPY.connect)).toBe(true);
    expect(Object.isFrozen(COPY.errors)).toBe(true);
    expect(Reflect.set(COPY.connect, 'body', 'rewritten')).toBe(false);
    expect(COPY.connect.body).toContain('your wallet');
  });
  it('says "your wallet", never "your extension"', () => {
    // v1 happens to ship against browser wallets. The forward-compatibility
    // design (SPEC §5 rule 5) exists so a web or embedded wallet can appear
    // with no rewrite, and copy naming the delivery mechanism would age the
    // day it does.
    for (const line of allCopyStrings()) {
      expect(line.toLowerCase(), line).not.toContain('extension');
    }
  });

  it('holds no local copy of an approved privacy disclosure (D-024)', () => {
    const lines = allCopyStrings();
    for (const entry of PRIVACY_REGISTER) {
      if (!entry.disclosure) continue;
      for (const line of lines) {
        expect(line, `${entry.route} disclosure restated in shell copy`).not.toContain(
          entry.disclosure,
        );
      }
    }
  });

  it('has a player-facing sentence for every failure class', () => {
    for (const [kind, text] of Object.entries(COPY.errors)) {
      expect(text.length, kind).toBeGreaterThan(10);
    }
  });

  it('uses the exact D-034 uncertainty copy without a retry or failure claim', () => {
    const copy = COPY.errors['submission-uncertain'];
    expect(copy).toBe(
      'We could not confirm whether this private action was submitted. Do not retry it yet. Reconnect, wait a few minutes, and refresh your private balance before taking another action.',
    );
    expect(copy).not.toContain('Try again');
    expect(copy).not.toContain('Nothing was sent');
  });

  it('says plainly that the unconfigured relay is needed and that nothing was sent (D-070, D-082, D-084)', () => {
    expect(COPY.errors['relay-not-configured']).toBe(
      "This needs the private relay, which isn't set up on this site yet. Nothing was sent.",
    );
    // Not a retry invitation, and not the network's fault.
    expect(COPY.errors['relay-not-configured']).not.toMatch(/try again|could not reach|wallet/i);
  });

  it('tells a player whose shield meets a queued spend to remove that item first', () => {
    expect(COPY.notices.shieldAfterSpend).toBe(
      'A spend is already queued, and a shield cannot travel with it. Remove the queued item first, then add the shield.',
    );
    expect(COPY.notices.shieldAfterSpend).toContain(COPY.batch.remove);
    expect(COPY.notices.shieldAfterSpend).not.toBe(COPY.notices.mixedShieldAndSpend);
  });

  describe('the entry gate (D-072)', () => {
    const entryCopy = allCopyStrings(COPY.entry);

    it('asks plainly before the city opens', () => {
      expect(COPY.entry.title).toBe('One check before you enter');
      expect(COPY.entry.body).toBe(
        'STRKWORLD is for people with funds in the STRK20 privacy pool. Your wallet will ask to share your private balance.',
      );
      expect(COPY.entry.action).toBe('Enter STRKWORLD');
    });

    it('says part of a first deposit pays the pool fee, without promising a figure', () => {
      expect(COPY.entry.feeNote).toMatch(/first deposit pays the pool's fee/);
      expect(COPY.entry.feeNote).not.toMatch(/\d/);
    });

    it('names the way off every card after the first check in plain words', () => {
      expect(COPY.entry.checkBalance).toBe('Check my private balance');
    });

    it('warns plainly when a STRK deposit is no more than the fee, with no figure', () => {
      expect(COPY.entry.feeTakesAll).toBe(
        "This is no more than the pool's fee, which comes out of the deposit, so nothing would reach the pool.",
      );
      expect(COPY.entry.feeTakesAll).not.toMatch(/\d/);
    });

    it('says the network check is out of reach without calling the deposit failed or slow', () => {
      expect(COPY.entry.receiptUnreachable).toMatch(/can't reach the network check right now/);
      expect(COPY.entry.receiptUnreachable).not.toMatch(/fail|did not go through|not confirmed|nothing was sent/i);
      expect(COPY.entry.receiptUnreachable).not.toBe(COPY.entry.unconfirmed);
    });

    it('cautions before a second deposit without promising the first one landed', () => {
      expect(COPY.entry.sentNotYet).toMatch(/may still be on its way/);
      expect(COPY.entry.sentNotYet).not.toMatch(/arrived|landed|confirmed/i);
    });

    it('speaks of the public balance of the chosen token at the gate, not the shielded one', () => {
      const line = `${COPY.entry.publicShortLead} USDC ${COPY.entry.publicShortTail}`;
      expect(line).toBe("There is not enough USDC in your wallet's public balance for this deposit.");
      expect(line).not.toMatch(/shielded/);
      expect(COPY.errors['insufficient-balance']).toMatch(/shielded/);
    });

    it('never calls the deposit private: the register discloses it as public at the commit point', () => {
      const claim = /\b(?:hidden|hides?|anonymous\w*|untraceable|unlinkable|confidential|invisible)\b|\bnobody\b|deposit\w* (?:is|are|stays?) private/i;
      expect(entryCopy.length).toBeGreaterThan(10);
      for (const line of entryCopy) {
        expect(line, line).not.toMatch(claim);
      }
    });
  });

  describe('the wallet cards (D-073)', () => {
    it('names the connected wallet in the unsupported room, and says the whole city waits', () => {
      expect(unsupportedCopy('Xverse')).toEqual({
        title: "Xverse can't open the privacy pool yet",
        body: "Xverse is connected but doesn't yet offer the STRK20 privacy methods STRKWORLD needs, so the city stays closed. Your funds are fine. Connect a wallet that supports STRK20 private balances, or check again once Xverse adds them.",
      });
      // The pre-gate copy promised a walkable city with some doors shut.
      expect(allCopyStrings(COPY.unsupported).join(' ')).not.toMatch(/doors?/i);
      expect(COPY.unsupported.action).toBe('Connect a different wallet');
    });

    it('says "Your wallet" when the shell has no name for it', () => {
      expect(unsupportedCopy(null)).toEqual({
        title: "Your wallet can't open the privacy pool yet",
        body: "Your wallet is connected but doesn't yet offer the STRK20 privacy methods STRKWORLD needs, so the city stays closed. Your funds are fine. Connect a wallet that supports STRK20 private balances, or check again once your wallet adds them.",
      });
    });

    it('points at two wallet sites plainly, over https', () => {
      expect(COPY.connect.getWallet).toBe('Get a wallet:');
      expect(COPY.connect.installLinks).toEqual([
        { label: 'Ready', href: 'https://chromewebstore.google.com/detail/ready-x/dlcobpjiigpikoobohmabehhmhfoodbb' },
        { label: 'Xverse', href: 'https://chromewebstore.google.com/detail/xverse-wallet/idnnbdplmphpflfnlkomgpfbpcgelopg' },
      ]);
    });
  });

  describe('the staking counter (D-063, D-064)', () => {
    // Every line the counter can show: its own section plus its entries elsewhere.
    const stakeCopy = [
      ...allCopyStrings(COPY.stake),
      COPY.bank.stake,
      COPY.locked.notEnabled.stake,
      COPY.notices.stakeAlone,
      COPY.next.afterStake,
      COPY.glossary.xstrk,
    ];

    it('claims no amount privacy — the waiver is exchanged for honest copy', () => {
      // The register test's pattern, widened: this route is `anonymous`, so
      // the amounts in and out are public and the copy must not say otherwise.
      const claim =
        /hidden amount|amounts? (?:are|is|stays?) (?:hidden|private)|untraceable|completely private|private|anonymous|confidential|invisible|nobody can see/i;
      expect(stakeCopy.length).toBeGreaterThan(10);
      for (const line of stakeCopy) {
        expect(line, line).not.toMatch(claim);
      }
    });

    it('adds no disclosure text, since the lead waived it', () => {
      const stake = PRIVACY_REGISTER.find((entry) => entry.route === 'bank.stake');
      expect(stake?.disclosure).toBeNull();
      expect(stake?.disclosureWaivedBy).toBe('D-064');
      for (const line of stakeCopy) {
        expect(line, line).not.toMatch(/on-chain|observer|reveals?|visible|public|linkable/i);
      }
    });

    it('says plainly where the STRK comes from, where the xSTRK lands, and how unstaking works', () => {
      expect(COPY.stake.intro).toContain('STRK from your pool balance');
      expect(COPY.stake.intro).toMatch(/xSTRK you receive lands in your pool balance/);
      // D-085: unstaking is a counter now; the line points at it (D-091: its tab) and says how long Endur takes.
      expect(COPY.stake.unstaking).toBe(
        "To unstake, use the Unstake tab. Endur's withdrawal queue holds the STRK for about seven days, sometimes longer, before it can come back to your pool balance.",
      );
    });

    it('never quotes an xSTRK amount or a rate at review', () => {
      expect(COPY.stake.amountAtExecution).not.toMatch(/\d/);
      expect(COPY.glossary.xstrk).not.toMatch(/\d|rate|apy|apr|yield|earn/i);
    });
  });

  describe('the unstaking counter (D-085)', () => {
    const unstakeCopy = [...allCopyStrings(COPY.unstake), COPY.locked.notEnabled.unstake];

    it('says the request waits on a public stand-in address that is not linked to the wallet', () => {
      expect(COPY.unstake.intro).toMatch(/stand-in address/);
      expect(COPY.unstake.intro).toMatch(/anyone can look it up/);
      expect(COPY.unstake.intro).toMatch(/not linked to your wallet/);
      expect(COPY.unstake.standInTail).toMatch(/^is public/);
    });

    it('says claimed STRK returns to the pool balance', () => {
      expect(COPY.unstake.intro).toMatch(/claim it and it returns to your pool balance/);
      expect(COPY.unstake.reviewClaimTail).toMatch(/returns to your pool balance/);
    });

    it('claims no amount privacy, and leaves the disclosure to the register', () => {
      const claim = /hidden|private|anonymous|confidential|invisible|untraceable|nobody can see/i;
      expect(unstakeCopy.length).toBeGreaterThan(20);
      for (const line of unstakeCopy) {
        expect(line, line).not.toMatch(claim);
      }
      const routes = PRIVACY_REGISTER.filter((entry) => entry.route === 'bank.unstake' || entry.route === 'bank.unstake-claim');
      expect(routes).toHaveLength(2);
      for (const route of routes) {
        expect(route.grade).toBe('anonymous');
        expect(route.disclosure).toMatch(/stand-in address, not your wallet/);
        expect(route.disclosure).toMatch(/Claimed STRK returns to your pool balance/);
        expect(route.disclosureWaivedBy ?? null).toBeNull();
      }
    });
  });

  describe('the Post Office and every transfer line (D-065)', () => {
    // Every line a send can show: the Post Office's own section, the transfer
    // control and its notices, and the journey lines that point at the Post Office.
    const transferCopy = [
      ...allCopyStrings(COPY.postOffice),
      COPY.buildings['post-office'],
      COPY.bank.transfer,
      COPY.bank.recipient,
      COPY.locked.notEnabled.transfer,
      COPY.notices.recipientUnregistered,
      COPY.notices.recipientUnknown,
      COPY.errors['recipient-not-registered'],
      COPY.notices.oneRecipientPerSend,
      COPY.next.afterShield,
      COPY.next.afterShieldSend,
      COPY.next.afterSwap,
      COPY.next.afterTransfer,
      COPY.guide.route.swapOrSend,
      COPY.guide.route.send,
    ];

    it('claims no recipient privacy — a first send publishes the recipient', () => {
      const claim =
        /\b(?:hidden|hides?|hiding|conceal\w*|secret\w*|anonymous\w*|anonymi[sz]\w*|untraceable|unlinkable|invisible|unseen|confidential)\b|\bnobody\b|\bno[ -]one\b|without a trace|who (?:you )?(?:sent|send|paid|pay)|recipient (?:is|stays?|remains?) (?:private|safe)/i;
      expect(transferCopy.length).toBeGreaterThan(10);
      for (const line of transferCopy) {
        expect(line, line).not.toMatch(claim);
      }
      // D-065 lets "send privately" stay: it names the pool route, not a hidden recipient.
      expect(COPY.postOffice.intro).toMatch(/^Send privately /);
    });

    it('adds no disclosure text, since the lead declined one', () => {
      const transfer = PRIVACY_REGISTER.find((entry) => entry.route === 'post-office.transfer');
      expect(transfer).toMatchObject({ grade: 'anonymous', disclosure: null, disclosureWaivedBy: 'D-065' });
      for (const line of transferCopy) {
        expect(line, line).not.toMatch(/on-chain|observer|reveals?|visible|public|linkable/i);
      }
    });

    it('puts an unregistered recipient on the recipient, and says nothing was sent (D-074)', () => {
      const line = COPY.errors['recipient-not-registered'];
      expect(line).toBe(
        "That recipient hasn't set up private balances yet, so they can't receive a private transfer. Nothing was sent.",
      );
      // Not the player's own registration card, and nothing the player can register.
      expect(line).not.toBe(COPY.errors['not-registered']);
      expect(line).not.toMatch(/your wallet|this account|register inside/i);
    });

    it('states the one-recipient rule plainly', () => {
      expect(COPY.notices.oneRecipientPerSend).toBe('One recipient per send. Confirm this transfer, then send the next.');
      expect(COPY.postOffice.oneAtATime).toMatch(/one recipient/i);
    });
  });

  describe('the degen floor (D-067)', () => {
    // Every line the degen counter adds; the rest is the swap's own copy.
    const degenCopy = allCopyStrings(COPY.degen);

    it('never calls a listed token safe, vetted or anything like it', () => {
      const vouching =
        /\b(?:safe\w*|vetted|vets?|audit\w*|trust\w*|guarantee\w*|legit\w*|screened|scam[- ]?free|rug[- ]?proof|risk[- ]?free|low[- ]risk|reviewed|approved|endorse\w*|recommend\w*|curated)\b/i;
      expect(degenCopy.length).toBeGreaterThan(10);
      for (const line of degenCopy) {
        expect(line, line).not.toMatch(vouching);
      }
    });

    it('adds no privacy claim to the swap\'s own disclosure', () => {
      const claim =
        /\b(?:private\w*|privacy|hidden|hides?|conceal\w*|secret\w*|anonym\w*|untraceable|unlinkable|invisible|confidential|on-chain|observer|reveals?|visible|public|linkable)\b/i;
      for (const line of degenCopy) {
        expect(line, line).not.toMatch(claim);
      }
    });

    it('says plainly that avnu has not verified these tokens and that quotes can be poor', () => {
      expect(COPY.degen.eyebrow).toBe('Degen mode');
      expect(COPY.degen.intro).toMatch(/^Degen mode lists community tokens avnu has not verified/);
      expect(COPY.degen.intro).toMatch(/thin/);
      expect(COPY.degen.intro).toMatch(/protected minimum still applies/);
      expect(COPY.degen.tags).toMatch(/not a promise/);
    });

    it('labels the demo\'s list and rates as demo only, never as live data or prices', () => {
      expect(COPY.degen.demo).toMatch(/^Demo list and demo rates/);
      expect(COPY.degen.demo).toMatch(/not avnu's live tokens or market prices/);
    });

    it('explains a display-only token without implying anything about the token itself', () => {
      expect(COPY.degen.displayOnly).toBe('Display only');
      expect(COPY.degen.displayOnlyNote).toMatch(/this build cannot swap it/);
      expect(COPY.degen.displayOnlyNotice).toMatch(/this build cannot swap it/i);
    });
  });

  describe('the Privacy Plaza (D-076)', () => {
    const plazaCopy = allCopyStrings(COPY.plaza);

    it("ties the shell game to the pool in the lead's words, kept to what the pool hides", () => {
      expect(COPY.plaza.shells.pool).toBe(
        'In the pool, notes look alike from outside. Without your viewing key, no one can tell which ones are yours.',
      );
      expect(COPY.plaza.shells.fun).toBe('Just for fun: no money, no wallet, nothing saved.');
    });

    it('explains the anonymity set in three plain sentences, and that the edges are public', () => {
      expect(COPY.plaza.monument.set).toEqual([
        'An anonymity set is the crowd you hide in: everyone who could have made the move you made.',
        'Each account that joins the pool makes every other one harder to pick out.',
        'So the more people use the pool, the more privacy everyone in it gets.',
      ]);
      expect(COPY.plaza.monument.edges).toMatch(/^Deposits and withdrawals are public/);
    });

    it('says the figures are public and about nobody in particular, and labels demo figures', () => {
      expect(COPY.plaza.monument.intro).toMatch(/^Public figures for the whole STRK20 privacy pool/);
      expect(COPY.plaza.monument.intro).toMatch(/Nothing here is about you\.$/);
      expect(COPY.plaza.monument.demo).toMatch(/^Demo figures/);
    });

    it('never overclaims: no untraceable, unlinkable or guaranteed privacy', () => {
      const claim = /\b(?:untraceable|unlinkable|invisible|anonymous\w*|confidential|guarantee\w*|completely|always private)\b/i;
      expect(plazaCopy.length).toBeGreaterThan(20);
      for (const line of plazaCopy) expect(line, line).not.toMatch(claim);
    });
  });

  describe('the Vault (D-077, D-079)', () => {
    const { standIn, ...rest } = COPY.vault;
    const vaultCopy = allCopyStrings(rest);

    it('names Vesu and says where a supply comes from and a redeem lands, for any token', () => {
      expect(COPY.vault.eyebrow).toBe('Lending with Vesu');
      expect(COPY.vault.intro).toMatch(/^Supply from your pool balance to Vesu's vaults/);
      expect(COPY.vault.intro).toMatch(/back into your pool balance/);
      expect(COPY.vault.intro).not.toMatch(/STRK/);
      expect(`${COPY.vault.review.landsInLead} USDC ${COPY.vault.review.landsInTail}`).toBe('The USDC lands in your pool balance.');
      // The pre-D-077 locked line is unchanged: a locked build reads exactly as before.
      expect(COPY.vault.locked).toBe('The Vault — lending with Vesu. Not open yet.');
    });

    it('claims no privacy of its own: what is public is the register disclosure, at the commit point', () => {
      const claim =
        /\b(?:private\w*|privately|privacy|hidden|hides?|hiding|conceal\w*|secret\w*|anonym\w*|untraceable|unlinkable|invisible|confidential|shadow|stand-in|public|on-chain|visible)\b/i;
      expect(vaultCopy.length).toBeGreaterThan(20);
      for (const line of vaultCopy) expect(line, line).not.toMatch(claim);
    });

    it('says the stand-in address is public, and nothing is hidden, in its one line (D-079)', () => {
      const line = `${standIn.lead} 0x2491…91ac9, ${standIn.tail}`;
      expect(line).toBe('Your stand-in address, 0x2491…91ac9, is public: anyone can look up what it holds.');
      // The register's own words for it, "stand-in address", and no promise the other way.
      const hiding = /\b(?:private\w*|privately|privacy|hidden|hides?|hiding|conceal\w*|secret\w*|anonym\w*|untraceable|unlinkable|invisible|confidential|safe|protect\w*)\b/i;
      for (const text of allCopyStrings(standIn)) expect(text, text).not.toMatch(hiding);
      expect(standIn.voyager).toBe('View it on Voyager');
      // What opening the optional link tells Voyager, before it is opened.
      expect(standIn.voyagerNote).toBe('Opens a new tab. Voyager sees your IP address when it loads.');
    });

    it('says the pool fee is set in STRK, and to keep some STRK, when another token is lent (D-079)', () => {
      expect(COPY.vault.feeInStrk).toBe(
        'The pool fee is set in STRK, whichever token you lend. Your wallet chooses which token in your pool balance pays it, and that can be STRK, so keep some STRK there too.',
      );
      expect(COPY.vault.review.feeTokenByWallet).toBe('Set in STRK. Your wallet chooses which token in your pool balance pays it.');
      for (const line of [COPY.vault.feeInStrk, COPY.vault.review.feeTokenByWallet]) expect(line).not.toMatch(/\d/);
    });

    it('labels every rate as Vesu’s figure, and states none it cannot read (D-079)', () => {
      expect(`${COPY.vault.rates.label} 2.73%, ${COPY.vault.rates.source}`).toBe("Supply APY 2.73%, Vesu's figure");
      expect(COPY.vault.rates.unavailable).toBe("Vesu's rates can't be read right now.");
      expect(COPY.vault.position.asOf).toMatch(/do not update on their own/);
      expect(COPY.vault.position.again).toBe('Read my positions again');
    });

    it('says plainly that each move pays the pool fee from the pool balance', () => {
      expect(COPY.vault.feeNote).toBe(
        'Each supply and redeem pays the pool fee from your pool balance, so keep enough there to come back out.',
      );
      expect(COPY.vault.feeNote).not.toMatch(/\d/);
    });

    it('never promises a redeem figure the vault has not fixed, or a network fee STRKWORLD cannot state', () => {
      expect(COPY.vault.review.redeemAll).toMatch(/about$/);
      expect(COPY.vault.review.allNote).toMatch(/Vesu fixes the exact amount when the redeem runs/);
      expect(COPY.vault.review.networkByWallet).toMatch(/your wallet/);
      expect(COPY.vault.review.networkByWallet).not.toMatch(/\d/);
    });

    it('says a collateral-only market earns nothing and is redeemable, not suppliable, with no figure (D-081)', () => {
      expect(COPY.vault.collateralOnly).toBe(
        'Collateral only: Vesu lends none of it out here, so it earns nothing, and it is not offered for supply. You can still redeem it.',
      );
      for (const line of [COPY.vault.collateralOnly, COPY.vault.noSupply, COPY.vault.noRedeem]) expect(line).not.toMatch(/\d/);
      // Nothing about borrowing is promised to the player.
      expect(`${COPY.vault.collateralOnly} ${COPY.vault.noSupply}`).not.toMatch(/borrow/i);
    });

    it('treats an unconfirmed transaction as not confirmed yet, never as failed', () => {
      expect(COPY.vault.submitted.pending).toMatch(/has not confirmed it yet/);
      expect(COPY.vault.submitted.pending).not.toMatch(/fail|did not go through/i);
      expect(COPY.vault.submitted.reverted).toMatch(/did not go through/);
    });

    it('tells a wallet without shadow accounts so, and that nothing else is affected', () => {
      const line = COPY.errors['shadow-accounts-unsupported'];
      expect(line).toMatch(/^Your wallet doesn't support shadow accounts yet/);
      expect(line).toMatch(/Nothing was sent/);
      expect(line).toMatch(/every other building works as before/);
      expect(line).not.toBe(COPY.errors['unsupported-wallet']);
      expect(COPY.locked.notEnabled.vault).toBe("The Vault isn't switched on in this build yet.");
    });
  });

  describe('the Borrow counter (D-083)', () => {
    const { standIn, risk, refusals, warningNote, liquidatableNote, ...rest } = COPY.borrow;
    const borrowCopy = allCopyStrings(rest);
    const claim =
      /\b(?:private\w*|privately|privacy|hidden|hides?|hiding|conceal\w*|secret\w*|anonym\w*|untraceable|unlinkable|invisible|confidential|shadow|stand-in|public|on-chain|visible)\b/i;

    it('claims no privacy of its own: what is public, and that a loan can be liquidated, is the register disclosure', () => {
      expect(borrowCopy.length).toBeGreaterThan(30);
      for (const line of borrowCopy) expect(line, line).not.toMatch(claim);
      for (const line of [...allCopyStrings(risk), ...allCopyStrings(refusals), warningNote, liquidatableNote]) {
        expect(line, line).not.toMatch(claim);
      }
    });

    it('explains liquidation plainly, and says the stand-in address is public and liquidatable', () => {
      expect(risk.lines.join(' ')).toMatch(/anyone can liquidate the loan/);
      expect(risk.lines.join(' ')).toMatch(/max LTV/);
      expect(risk.lines.join(' ')).toMatch(/stale/);
      const line = `${standIn.lead} 0x2491…91ac9, ${standIn.tail}`;
      expect(line).toBe('Your borrow stand-in address, 0x2491…91ac9, is public: anyone can look up its loans, and liquidate one that passes its max LTV.');
      expect(`${COPY.borrow.loans.liquidationLead} STRK ${COPY.borrow.loans.liquidationMid} $0.0147 ${COPY.borrow.loans.liquidationAnd} USDC ${COPY.borrow.loans.liquidationTail}`)
        .toBe('If STRK falls to $0.0147 and USDC holds its price, anyone can liquidate this loan.');
    });

    it('names Vesu, says where a loan comes from and lands, and never promises a repay-all figure', () => {
      expect(COPY.borrow.eyebrow).toBe('Borrowing with Vesu');
      expect(COPY.borrow.intro).toMatch(/pool balance/);
      expect(COPY.borrow.review.bufferNote).toMatch(/Vesu fixes the exact amount/);
      expect(COPY.borrow.review.bufferNote).toMatch(/returns to your pool balance/);
      expect(COPY.locked.notEnabled.borrow).toBe("Borrowing isn't switched on in this build yet.");
    });

    it('words every refusal the seam can name', async () => {
      expect(Object.keys(refusals).sort()).toEqual([
        'above-max-ltv', 'amount', 'collateral-below-floor', 'debt-below-floor', 'debt-cap', 'nothing-to-repay',
        'pair-not-offered', 'repay-exceeds-debt', 'review-expired', 'stale-price', 'too-close-to-liquidation',
        'unknown-pair', 'utilization', 'withdraw-all-with-debt', 'withdraw-exceeds-collateral',
      ]);
    });
  });

  it('never promises that timing or a batch hides more than it does', () => {
    for (const line of allCopyStrings()) {
      expect(line.toLowerCase(), line).not.toContain('untraceable');
      expect(line.toLowerCase(), line).not.toContain('completely private');
      expect(line.toLowerCase(), line).not.toContain('anonymous forever');
    }
  });
});
