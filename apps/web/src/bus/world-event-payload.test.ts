import { describe, expect, it } from 'vitest';
import {
  ownBuildingPayload,
  ownLockedBuildingPayload,
  ownMovementPayload,
  ownStationPayload,
} from './world-event-payload.js';

describe('World event payload ownership', () => {
  it('owns valid semantic payloads', () => {
    expect(ownBuildingPayload({ building: 'bank' })).toEqual({ building: 'bank' });
    expect(ownLockedBuildingPayload({ building: 'vault', reason: 'coming-soon' })).toEqual({ building: 'vault', reason: 'coming-soon' });
    expect(ownStationPayload({ building: 'bank', station: 'bank:not-registered' })).toEqual({ building: 'bank', station: 'bank:not-registered' });
    expect(ownMovementPayload({ position: { x: -1.5, y: 2 }, facing: 'left' })).toEqual({ position: { x: -1.5, y: 2 }, facing: 'left' });
  });

  it('rejects unknown semantic values and non-finite positions', () => {
    expect(ownBuildingPayload({ building: 'casino' })).toBeNull();
    expect(ownLockedBuildingPayload({ building: 'vault', reason: 'open' })).toBeNull();
    expect(ownStationPayload({ building: 'bank', station: 'exchange:swap' })).toBeNull();
    expect(ownMovementPayload({ position: { x: Number.NaN, y: 2 }, facing: 'left' })).toBeNull();
    expect(ownMovementPayload({ position: { x: 1, y: Number.POSITIVE_INFINITY }, facing: 'left' })).toBeNull();
    expect(ownMovementPayload({ position: { x: 1, y: 2 }, facing: 'diagonal' })).toBeNull();
  });

  it('does not invoke accessors or leak proxy traps', () => {
    let reads = 0;
    const accessor = Object.defineProperty({}, 'building', { get() { reads += 1; return 'bank'; } });
    const proxy = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('trap'); } });
    const position = Object.defineProperty({}, 'x', { get() { reads += 1; return 1; } });

    expect(ownBuildingPayload(accessor)).toBeNull();
    expect(ownBuildingPayload(proxy)).toBeNull();
    expect(ownMovementPayload({ position, facing: 'down' })).toBeNull();
    expect(reads).toBe(0);
  });
});
