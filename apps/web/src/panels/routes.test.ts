import { describe, expect, it } from 'vitest';
import { PRIVACY_REGISTER, type RouteGrade } from '@strkworld/shared/src/privacy-grades.js';
import { COPY } from '../copy.js';
import {
  buildingDoor,
  findRoute,
  isRouteOpen,
  routeDisclosure,
  routeDoor,
  routeReturnsToPool,
} from './routes.js';
import { resolveRoom } from './panel-framework.js';

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

  it('opens an approved and disclosed deviation', () => {
    expect(routeDoor('vault.supply', [approvedDeviation]).open).toBe(true);
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
});
