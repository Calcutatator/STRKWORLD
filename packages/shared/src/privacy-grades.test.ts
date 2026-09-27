import { describe, expect, it } from 'vitest';
import {
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
    // longer uniformly playable; every approved route still is.
    expect(PRIVACY_REGISTER.map((route) => route.route)).toEqual([...APPROVED_ROUTES, 'bank.stake']);
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
      if (route.route === 'bank.stake' || route.grade === 'private') continue;
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
