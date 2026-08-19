import { describe, expect, it } from 'vitest';
import {
  PRIVACY_REGISTER,
  isRoutePlayable,
  type RouteGrade,
} from './privacy-grades.js';

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
    expect(PRIVACY_REGISTER.every((route) => isRoutePlayable(route))).toBe(true);
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
