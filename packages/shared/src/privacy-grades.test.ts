import { describe, expect, it } from 'vitest';
import {
  DISCLOSURE_WAIVERS,
  PRIVACY_REGISTER,
  isDisclosureWaived,
  isRoutePlayable,
  routesAwaitingApproval,
  routesAwaitingCopy,
  type RouteGrade,
} from './privacy-grades.js';

/** Every route approved and disclosed before D-063. */
const APPROVED_ROUTES = [
  'post-office.transfer',
  'bank.shield',
  'bank.unshield',
  'exchange.swap',
  'bridge.deposit',
] as const;

function registered(route: string): RouteGrade {
  const matches = PRIVACY_REGISTER.filter((entry) => entry.route === route);
  expect(matches, route).toHaveLength(1);
  return matches[0]!;
}

const APPROVED_DEVIATION: RouteGrade = {
  building: 'vault',
  route: 'vault.supply',
  grade: 'anonymous',
  observable: 'The amount is public.',
  disclosure: 'The amount will be visible.',
  approvedBy: 'project lead',
  approvedOn: '2026-08-20',
  rationale: 'The route preserves sender privacy.',
  returnToPool: false,
};

const REQUIRED_APPROVAL_FIELDS = [
  'approvedBy',
  'approvedOn',
  'rationale',
  'disclosure',
] as const;

const INVALID_FIELD_VALUES = [
  ['missing', undefined],
  ['null', null],
  ['empty', ''],
  ['whitespace', ' \t '],
] as const;

const INCOMPLETE_APPROVALS = REQUIRED_APPROVAL_FIELDS.flatMap((field) =>
  INVALID_FIELD_VALUES.map(([kind, value]) => [field, kind, value] as const),
);

describe('privacy deviation admission', () => {
  it.each(INCOMPLETE_APPROVALS)(
    'rejects a deviation with %s %s metadata',
    (field, _kind, value) => {
      const route: Record<string, unknown> = { ...APPROVED_DEVIATION };
      if (value === undefined) {
        delete route[field];
      } else {
        route[field] = value;
      }

      expect(isRoutePlayable(route as unknown as RouteGrade)).toBe(false);
    },
  );

  it('keeps complete canonical approvals admitted', () => {
    // D-063 adds a registered-but-unapproved route, so the register is no
    // longer uniformly playable; every approved route still is. D-072 adds
    // the entry gate's deposit, D-077 the Vault's two routes, and D-083 the
    // Borrow counter's one, last. D-085 adds Endur unstaking's two routes
    // after staking.
    expect(PRIVACY_REGISTER.map((route) => route.route)).toEqual([
      ...APPROVED_ROUTES,
      'bank.stake',
      'bank.unstake',
      'bank.unstake-claim',
      'entry.shield',
      'vault.supply',
      'vault.redeem',
      'vault.borrow',
    ]);
    expect(APPROVED_ROUTES.every((route) => isRoutePlayable(registered(route)))).toBe(true);
    expect(isRoutePlayable(APPROVED_DEVIATION)).toBe(true);
  });

  it('keeps an unapproved deviation denied', () => {
    expect(isRoutePlayable({
      ...APPROVED_DEVIATION,
      approvedBy: null,
      approvedOn: null,
      rationale: null,
      disclosure: null,
    })).toBe(false);
  });
});

describe('Endur private staking register entry (D-063)', () => {
  it('grades the Bank stake route anonymous, like the private swap', () => {
    const stake = registered('bank.stake');
    expect(stake.building).toBe('bank');
    expect(stake.grade).toBe('anonymous');
    expect(stake.grade).toBe(registered('exchange.swap').grade);
    // The minted xSTRK is already an open pool note.
    expect(stake.returnToPool).toBe(false);
  });

  it('is approved by the lead with its in-game disclosure waived by D-064', () => {
    const stake = registered('bank.stake');
    expect(stake.approvedBy).toBe('calc');
    expect(stake.approvedOn).toBe('2026-09-27');
    expect(stake.rationale).toMatch(/D-064/);
    expect(stake.disclosure).toBeNull();
    expect(stake.disclosureWaivedBy).toBe('D-064');
    expect(isDisclosureWaived(stake)).toBe(true);
    expect(isRoutePlayable(stake)).toBe(true);
    // Waived is neither "awaiting approval" nor "approved but awaiting copy".
    expect(routesAwaitingApproval()).toEqual([]);
    expect(routesAwaitingCopy()).toEqual([]);
  });

  it('still records exactly what an observer sees, without claiming hidden amounts', () => {
    const { observable, rationale } = registered('bank.stake');
    expect(observable).toMatch(/Who staked is hidden/);
    expect(observable).toMatch(/how much went in and came out is not/);
    expect(observable).toMatch(/1 to 14 days/);
    for (const text of [observable, rationale ?? '']) {
      expect(text).not.toMatch(/hidden amount|amounts? (?:are|is) hidden|untraceable|completely private/i);
    }
  });

  it('accepts a waiver only as an own decision id, and never without approval', () => {
    const stake = registered('bank.stake');
    // Without approval metadata a waiver unlocks nothing.
    expect(isRoutePlayable({ ...stake, approvedBy: null, approvedOn: null, rationale: null })).toBe(false);
    // A waiver must name a decision entry.
    for (const bad of ['', 'yes', 'D-', 'D-64', 'd-064', ' D-064', true, 64]) {
      const entry = { ...stake, disclosureWaivedBy: bad as unknown as string };
      expect(isDisclosureWaived(entry), String(bad)).toBe(false);
      expect(isRoutePlayable(entry), String(bad)).toBe(false);
    }
    // An inherited waiver cannot switch a disclosure off.
    const { disclosureWaivedBy: _omit, ...own } = stake;
    const inherited = Object.assign(Object.create({ disclosureWaivedBy: 'D-064' }), own);
    expect(isDisclosureWaived(inherited)).toBe(false);
    expect(isRoutePlayable(inherited)).toBe(false);
    // Every other deviation still shows its own disclosure.
    for (const route of PRIVACY_REGISTER) {
      if (Object.hasOwn(DISCLOSURE_WAIVERS, route.route) || route.grade === 'private') continue;
      expect(isDisclosureWaived(route), route.route).toBe(false);
      expect(route.disclosure, route.route).toBeTruthy();
    }
  });

  it('keeps braces out of the copy so the CI register parser cannot lose the entry', () => {
    const stake = registered('bank.stake');
    for (const text of [stake.observable, stake.disclosure ?? '']) {
      expect(text).not.toMatch(/[{}]/);
    }
  });
});

describe('disclosure waivers are granted per route, by one decision each (D-064)', () => {
  it('lists exactly the granted waivers, frozen', () => {
    expect(DISCLOSURE_WAIVERS).toEqual({ 'bank.stake': 'D-064', 'post-office.transfer': 'D-065' });
    expect(Object.isFrozen(DISCLOSURE_WAIVERS)).toBe(true);
  });

  it('refuses a waiver that borrows a real decision for another route', () => {
    const unshield = PRIVACY_REGISTER.find((route) => route.route === 'bank.unshield')!;
    for (const decision of ['D-020', 'D-064']) {
      const forged = { ...unshield, disclosure: null, disclosureWaivedBy: decision };
      expect(isDisclosureWaived(forged), decision).toBe(false);
      expect(isRoutePlayable(forged), decision).toBe(false);
    }
  });

  it('refuses the right route citing the wrong decision', () => {
    const stake = PRIVACY_REGISTER.find((route) => route.route === 'bank.stake')!;
    expect(isDisclosureWaived({ ...stake, disclosureWaivedBy: 'D-063' })).toBe(false);
    expect(isRoutePlayable({ ...stake, disclosureWaivedBy: 'D-063' })).toBe(false);
  });
});

describe('the entry gate deposit register entry (D-072)', () => {
  it('is the Bank shield on a second surface: same building, grade and disclosure', () => {
    const entry = registered('entry.shield');
    const shield = registered('bank.shield');
    expect(entry.building).toBe('bank');
    expect(entry.grade).toBe('public-edge');
    expect(entry.grade).toBe(shield.grade);
    expect(entry.disclosure).toBe(shield.disclosure);
    expect(entry.returnToPool).toBe(false);
  });

  it('is approved by the lead on the day of D-072, with its disclosure shown, not waived', () => {
    const entry = registered('entry.shield');
    expect(entry.approvedBy).toBe('calc');
    expect(entry.approvedOn).toBe('2026-09-29');
    expect(entry.rationale).toMatch(/D-072/);
    expect(entry.disclosureWaivedBy).toBeUndefined();
    expect(isDisclosureWaived(entry)).toBe(false);
    expect(isRoutePlayable(entry)).toBe(true);
    expect(isRoutePlayable({ ...entry, disclosure: null })).toBe(false);
  });

  it('keeps braces out of its copy so the CI register parser cannot lose it', () => {
    const entry = registered('entry.shield');
    for (const text of [entry.observable, entry.disclosure ?? '', entry.rationale ?? '']) {
      expect(text).not.toMatch(/[{}]/);
    }
  });
});

describe('the Vault register entries (D-077, D-079, D-081)', () => {
  const VAULT_ROUTES = ['vault.supply', 'vault.redeem'] as const;

  it.each(VAULT_ROUTES)('grades %s anonymous under the Vault, like Endur staking', (route) => {
    const entry = registered(route);
    expect(entry.building).toBe('vault');
    expect(entry.grade).toBe('anonymous');
    expect(entry.grade).toBe(registered('bank.stake').grade);
    expect(entry.returnToPool).toBe(false);
  });

  it.each(VAULT_ROUTES)('is approved by the lead on the day of D-077, with its disclosure shown, not waived', (route) => {
    const entry = registered(route);
    expect(entry.approvedBy).toBe('calc');
    expect(entry.approvedOn).toBe('2026-09-29');
    expect(entry.rationale).toMatch(/D-077/);
    expect(entry.disclosureWaivedBy).toBeUndefined();
    expect(isDisclosureWaived(entry)).toBe(false);
    expect(isRoutePlayable(entry)).toBe(true);
    expect(isRoutePlayable({ ...entry, disclosure: null })).toBe(false);
  });

  it('shows one disclosure for both, saying plainly what is public and that only the link is hidden', () => {
    const [supply, redeem] = VAULT_ROUTES.map(registered);
    expect(redeem!.disclosure).toBe(supply!.disclosure);
    const disclosure = supply!.disclosure ?? '';
    expect(disclosure).toMatch(/^Your Vault position sits on a stand-in address, not your wallet\./);
    expect(disclosure).toMatch(/its balance and every supply and redeem you make through it, with their amounts, are public on-chain/);
    expect(disclosure).toMatch(/Only its link to your wallet is hidden/);
    // Not a promise that nobody can ever tell.
    expect(disclosure).toMatch(/matching amounts or timing can still give that link away/);
    expect(disclosure).not.toMatch(/\b(?:untraceable|invisible|anonymous|confidential|private)\b/i);
  });

  it('records what an observer sees: a public, persistent address that links every Vault action', () => {
    for (const route of VAULT_ROUTES) {
      const { observable } = registered(route);
      expect(observable).toMatch(/public/);
      expect(observable).toMatch(/same address|one address/);
      expect(observable).toMatch(/Only the link from that address to the wallet is hidden/);
    }
    expect(registered('vault.supply').observable).toMatch(/strkworld-vault, nonce 0/);
  });

  it('records what an observer sees in every token and pool the Vault lends in, under the same grade and disclosure (D-079, D-081)', () => {
    for (const route of VAULT_ROUTES) {
      const entry = registered(route);
      expect(entry.observable).toMatch(/pinned Vesu vault for (?:that|the) token, in the Vesu Prime pool or a curated pool/);
      expect(entry.observable).toMatch(/in any token and any pool/);
      expect(entry.observable).toMatch(/in whichever token the wallet pays it with/);
      // Generic since D-081: the observable names no token list, so a new
      // pinned market needs no register edit, and neither do the player's words.
      expect(entry.observable).not.toMatch(/\b(?:ETH|USDC|USDT|WBTC|strkBTC|Re7)\b/);
      expect(entry.disclosure).not.toMatch(/\b(?:STRK|ETH|USDC|USDT|WBTC|vSTRK|strkBTC|Prime|curated|Re7)\b/);
      expect(entry.grade).toBe('anonymous');
    }
    expect(registered('vault.redeem').observable).toMatch(/whose token and amount are plaintext/);
  });

  it('keeps braces out of their copy so the CI register parser cannot lose them', () => {
    for (const route of VAULT_ROUTES) {
      const entry = registered(route);
      for (const text of [entry.observable, entry.disclosure ?? '', entry.rationale ?? '']) {
        expect(text).not.toMatch(/[{}]/);
      }
    }
  });
});

describe('The Borrow counter register entry (D-083)', () => {
  it('grades borrowing anonymous under the Vault, approved, with its own disclosure', () => {
    const borrow = registered('vault.borrow');
    expect(borrow.building).toBe('vault');
    expect(borrow.grade).toBe('anonymous');
    expect(borrow.approvedBy).toBe('calc');
    expect(isRoutePlayable(borrow)).toBe(true);
    expect(borrow.disclosure).not.toBe(registered('vault.supply').disclosure);
    expect(borrow.returnToPool).toBe(false);
  });

  it('says plainly the loan is public and can be liquidated, and claims nothing more hidden than the link', () => {
    const { disclosure, observable } = registered('vault.borrow');
    expect(disclosure).toMatch(/public on-chain/);
    expect(disclosure).toMatch(/liquidate/);
    expect(disclosure).toMatch(/not your wallet and not your Vault one/);
    expect(disclosure).toMatch(/Only its link to your wallet is hidden/);
    expect(observable).toMatch(/strkworld-borrow, nonce 0/);
    expect(observable).toMatch(/liquidate/);
  });
});
