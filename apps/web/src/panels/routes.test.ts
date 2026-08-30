import { describe, expect, it } from 'vitest';
import { PRIVACY_REGISTER, type RouteGrade } from '../privacy/register.js';
import { COPY } from '../copy.js';
import type { Intent } from '@strkworld/privacy';
import {
  buildingDoor,
  disclosuresForIntents,
  findRoute,
  isRouteOpen,
  routeDisclosure,
  routeDoor,
  routeReturnsToPool,
  ROUTE_BY_INTENT_KIND,
} from './routes.js';
import { resolveRoom } from './panel-framework.js';
import { BUILDING_PANELS } from './registry.js';

const approvedDeviation: RouteGrade = {
  building: 'vault',
  route: 'vault.supply',
  grade: 'anonymous',
  observable: 'test fixture',
  disclosure: 'A disclosure.',
  approvedBy: 'calc',
  approvedOn: '2026-08-16',
  rationale: 'test fixture',
  returnToPool: false,
};

const unapprovedDeviation: RouteGrade = {
  ...approvedDeviation,
  approvedBy: null,
  approvedOn: null,
  disclosure: null,
  rationale: null,
};

const approvedButUndisclosed: RouteGrade = { ...approvedDeviation, disclosure: null };

describe('route gate', () => {
  it('keeps the canonical register immutable at the Web seam', () => {
    const shield = PRIVACY_REGISTER.find((entry) => entry.route === 'bank.shield')!;

    expect(Object.isFrozen(PRIVACY_REGISTER)).toBe(true);
    expect(Object.isFrozen(shield)).toBe(true);
    expect(Reflect.set(PRIVACY_REGISTER, 0, shield)).toBe(false);
    expect(Reflect.set(shield, 'grade', 'private')).toBe(false);
    expect(routeDoor('bank.shield').open).toBe(true);
    expect(shield.grade).toBe('public-edge');
  });

  it('opens the four approved v1 routes', () => {
    for (const route of ['bank.shield', 'bank.unshield', 'post-office.transfer', 'exchange.swap', 'bridge.deposit']) {
      expect(isRouteOpen(route), route).toBe(true);
    }
  });

  it('locks a route id the register does not carry', () => {
    const door = routeDoor('bank.something-new');
    expect(door.open).toBe(false);
    expect(door.reason).toBe('unknown-route');
    expect(door.message).toBe(COPY.locked.unknownRoute);
  });

  it('locks an unapproved deviation', () => {
    const door = routeDoor('vault.supply', [unapprovedDeviation]);
    expect(door.open).toBe(false);
    expect(door.reason).toBe('unapproved-route');
  });

  it('locks an approved deviation that has no player-facing copy', () => {
    expect(routeDoor('vault.supply', [approvedButUndisclosed]).open).toBe(false);
  });

  it('does not admit a route whose identifier is inherited', () => {
    const inherited = Object.create(approvedDeviation) as RouteGrade;
    expect(routeDoor('vault.supply', [inherited]).open).toBe(false);
  });

  it('does not admit approval fields inherited by an otherwise named route', () => {
    const inherited = Object.create(approvedDeviation) as RouteGrade;
    Object.defineProperty(inherited, 'route', { value: approvedDeviation.route });
    expect(routeDoor('vault.supply', [inherited]).open).toBe(false);
  });

  it('does not admit a building whose identity is inherited', () => {
    const inherited = Object.create(approvedDeviation) as RouteGrade;
    for (const field of ['route', 'grade', 'observable', 'disclosure', 'approvedBy', 'approvedOn', 'rationale', 'returnToPool'] as const) {
      Object.defineProperty(inherited, field, { value: approvedDeviation[field] });
    }
    expect(buildingDoor('vault', [inherited]).open).toBe(false);
  });

  it.each([null, {}, 'not-a-register'])('fails closed for a malformed register container: %s', (malformed) => {
    const register = malformed as unknown as readonly RouteGrade[];
    expect(() => routeDoor('bank.shield', register)).not.toThrow();
    expect(routeDoor('bank.shield', register)).toMatchObject({ open: false, reason: 'unknown-route' });
    expect(() => buildingDoor('bank', register)).not.toThrow();
    expect(buildingDoor('bank', register)).toMatchObject({ open: false, reason: 'coming-soon' });
  });

  it('opens an approved and disclosed deviation', () => {
    expect(routeDoor('vault.supply', [approvedDeviation]).open).toBe(true);
  });

  it('returns immutable route decisions', () => {
    const open = routeDoor('bank.shield');
    const locked = routeDoor('not-a-route');

    expect(Object.isFrozen(open)).toBe(true);
    expect(Object.isFrozen(locked)).toBe(true);
    expect(Reflect.set(open, 'open', false)).toBe(false);
    expect(Reflect.set(locked, 'message', 'forged')).toBe(false);
    expect(routeDoor('bank.shield')).toMatchObject({ open: true, reason: null, message: '' });
    expect(routeDoor('not-a-route').message).toBe(COPY.locked.unknownRoute);
  });

  it('returns the register disclosure verbatim, never a local paraphrase', () => {
    for (const entry of PRIVACY_REGISTER) {
      expect(routeDisclosure(entry.route)).toBe(entry.disclosure);
    }
    // Identity, not just equality of text: the same string object comes back.
    const shield = findRoute('bank.shield');
    expect(routeDisclosure('bank.shield')).toBe(shield?.disclosure);
  });

  it('reports the D-021 return-to-pool routes', () => {
    expect(routeReturnsToPool('bridge.deposit')).toBe(true);
    expect(routeReturnsToPool('exchange.swap')).toBe(false);
    expect(routeReturnsToPool('nope')).toBe(false);
  });
});

describe('building doors', () => {
  it('opens the four active buildings', () => {
    for (const building of ['bank', 'exchange', 'post-office', 'bridge'] as const) {
      expect(buildingDoor(building).open, building).toBe(true);
    }
  });

  it('keeps the Vault shut — it has no graded route in v1', () => {
    const door = buildingDoor('vault');
    expect(door.open).toBe(false);
    expect(door.reason).toBe('coming-soon');
    expect(door.message).toBe(COPY.locked.comingSoon);
  });

  it('locks a building whose only route is an unapproved deviation', () => {
    const door = buildingDoor('vault', [unapprovedDeviation]);
    expect(door.reason).toBe('unapproved-route');
  });
});

describe('room resolution', () => {
  const panels = { bank: 'bank-panel' } as const;

  it('renders the panel for a graded building that has a room', () => {
    const room = resolveRoom('bank', panels);
    expect(room.kind).toBe('panel');
    expect(room.kind === 'panel' && room.panel).toBe('bank-panel');
  });

  it('separates "not built yet" from "locked"', () => {
    const unbuilt = resolveRoom('exchange', panels);
    expect(unbuilt.kind).toBe('unbuilt');
    expect(unbuilt.kind === 'unbuilt' && unbuilt.message).toBe(COPY.unbuilt);
  });

  it('renders a locked door for the Vault even if somebody registers a panel', () => {
    const room = resolveRoom('vault', { ...panels, vault: 'vault-panel' });
    expect(room.kind).toBe('locked');
    expect(room.kind === 'locked' && room.reason).toBe('coming-soon');
  });

  it('puts the privacy gate ahead of the panel registry', () => {
    const room = resolveRoom('vault', { vault: 'vault-panel' }, [unapprovedDeviation]);
    expect(room.kind).toBe('locked');
    expect(room.kind === 'locked' && room.reason).toBe('unapproved-route');
  });

  it('does not admit an inherited panel descriptor', () => {
    const panels = Object.create({ exchange: 'forged-panel' }) as { exchange?: string };
    const room = resolveRoom('exchange', panels);
    expect(room.kind).toBe('unbuilt');
  });

  it('does not render a structured panel under the wrong building key', () => {
    const panels = { exchange: BUILDING_PANELS.bank };
    const room = resolveRoom('exchange', panels);
    expect(room).toMatchObject({ kind: 'unbuilt', building: 'exchange' });
  });

  it.each([null, {}, 'not-a-registry'])('fails closed for a malformed panel registry container: %s', (malformed) => {
    const panels = malformed as unknown as { exchange?: string };
    expect(() => resolveRoom('exchange', panels)).not.toThrow();
    expect(resolveRoom('exchange', panels)).toMatchObject({ kind: 'unbuilt', building: 'exchange' });
  });
});

describe('default panel registry', () => {
  it('does not let consumers rewrite the authored panel descriptors', () => {
    const exchange = BUILDING_PANELS.exchange;
    expect(exchange).toBeDefined();
    expect(Object.isFrozen(BUILDING_PANELS)).toBe(true);
    expect(Object.isFrozen(exchange)).toBe(true);
    expect(Reflect.set(BUILDING_PANELS, 'exchange', { forged: true })).toBe(false);
    expect(Reflect.set(exchange!, 'title', 'forged')).toBe(false);
    expect(BUILDING_PANELS.exchange).toBe(exchange);
    expect(BUILDING_PANELS.exchange?.title).toBe(COPY.buildings.exchange);
  });
});

describe('disclosures for a batch', () => {
  const TOKEN = '0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d';
  const BOB = '0x02b4c7d1a1f8f39e0e6e8b9a2c7d0e3f4a5b6c7d8e9f0a1b2c3d4e5f60718293';
  const shield: Intent = { kind: 'shield', token: TOKEN, amount: 1n };
  const transfer: Intent = { kind: 'transfer', token: TOKEN, amount: 1n, recipient: BOB };

  it('returns the register string for each route in the batch, verbatim', () => {
    const entry = findRoute('bank.shield');
    expect(disclosuresForIntents([shield])).toEqual([entry?.disclosure]);
  });

  it('says nothing for a batch that needs no disclosure', () => {
    expect(disclosuresForIntents([transfer, transfer])).toEqual([]);
  });

  it('de-duplicates, because one route said twice is not two disclosures', () => {
    expect(disclosuresForIntents([shield, shield, shield])).toHaveLength(1);
  });

  it('covers every intent kind the seam can carry', () => {
    const kinds: Intent['kind'][] = ['shield', 'unshield', 'transfer', 'swap'];
    for (const kind of kinds) {
      expect(ROUTE_BY_INTENT_KIND[kind], kind).toBeTruthy();
      // Every mapped id must exist in the register, or the door fails closed
      // and the control silently stops working.
      expect(findRoute(ROUTE_BY_INTENT_KIND[kind]), kind).toBeDefined();
    }
  });

  it('keeps the intent-to-route authority immutable at the public seam', () => {
    expect(Object.isFrozen(ROUTE_BY_INTENT_KIND)).toBe(true);
    expect(Reflect.set(ROUTE_BY_INTENT_KIND, 'shield', 'exchange.swap')).toBe(false);
    expect(ROUTE_BY_INTENT_KIND.shield).toBe('bank.shield');
  });
});
