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

  it('says in plain words which actions need the unconfigured relay, and that nothing was sent (D-070)', () => {
    expect(COPY.errors['relay-not-configured']).toBe(
      "Unshield, send, stake and swap need the private relay, which isn't set up on this site yet. Nothing was sent.",
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
        { label: 'Ready', href: 'https://www.ready.co' },
        { label: 'Xverse', href: 'https://www.xverse.app' },
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
      expect(COPY.stake.unstaking).toBe(
        "Unstaking isn't available in the game yet. Endur's own withdrawal queue takes 1 to 14 days.",
      );
    });

    it('never quotes an xSTRK amount or a rate at review', () => {
      expect(COPY.stake.amountAtExecution).not.toMatch(/\d/);
      expect(COPY.glossary.xstrk).not.toMatch(/\d|rate|apy|apr|yield|earn/i);
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

  it('never promises that timing or a batch hides more than it does', () => {
    for (const line of allCopyStrings()) {
      expect(line.toLowerCase(), line).not.toContain('untraceable');
      expect(line.toLowerCase(), line).not.toContain('completely private');
      expect(line.toLowerCase(), line).not.toContain('anonymous forever');
    }
  });
});
