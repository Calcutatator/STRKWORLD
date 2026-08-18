import { describe, expect, it } from 'vitest';
import type { WorldEvents } from '@strkworld/shared';
import {
  createStreetMovementAdapter,
  createStreetMovementReporter,
  type MovementInput,
} from './street-movement.js';

const idle: MovementInput = { left: false, right: false, up: false, down: false };

function capture() {
  const events: Array<{ event: keyof WorldEvents; payload: unknown }> = [];
  const out = { emit: (event: keyof WorldEvents, payload: unknown) => events.push({ event, payload }) };
  return { events, reporter: createStreetMovementReporter(out) };
}

describe('street movement seam', () => {
  it('emits the initial placement with only the frozen movement payload', () => {
    const h = capture();
    h.reporter.initial({ x: 784, y: 496 });

    expect(h.events).toEqual([
      { event: 'player:moved', payload: { position: { x: 784, y: 496 }, facing: 'down' } },
    ]);
    expect(Object.keys(h.events[0]!.payload as object)).toEqual(['position', 'facing']);
  });

  it('tracks input facing and retains it while stopped', () => {
    const h = capture();
    h.reporter.update({ x: 100, y: 100 }, { ...idle, right: true });
    h.reporter.update({ x: 100, y: 100 }, idle);

    expect(h.events.map((event) => event.payload)).toEqual([
      { position: { x: 100, y: 100 }, facing: 'right' },
      { position: { x: 100, y: 100 }, facing: 'right' },
    ]);
  });

  it('never adds building, room, station, mode, or financial fields', () => {
    const h = capture();
    h.reporter.update({ x: 1, y: 2 }, { ...idle, up: true });
    const payload = h.events[0]!.payload as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['facing', 'position']);
    expect(payload).not.toHaveProperty('building');
    expect(payload).not.toHaveProperty('station');
    expect(payload).not.toHaveProperty('mode');
  });

  it('orders the initial placement and street movement before door events', () => {
    const h = capture();
    const adapter = createStreetMovementAdapter({
      emit: (event, payload) => h.events.push({ event, payload }),
    });
    adapter.initial({ x: 10, y: 20 });
    adapter.streetUpdate({ x: 11, y: 20 }, { ...idle, right: true }, () => {
      h.events.push({ event: 'building:entered', payload: { building: 'bank' } });
    });

    expect(h.events.map(({ event }) => event)).toEqual([
      'player:moved',
      'player:moved',
      'building:entered',
    ]);
  });

  it('keeps interior updates silent and does not change street facing', () => {
    const h = capture();
    const adapter = createStreetMovementAdapter({
      emit: (event, payload) => h.events.push({ event, payload }),
    });
    adapter.initial({ x: 10, y: 20 });
    adapter.streetUpdate({ x: 11, y: 20 }, { ...idle, right: true }, () => {});
    adapter.interiorUpdate(() => {
      h.events.push({ event: 'station:activated', payload: { building: 'bank', station: 'bank:shielding' } });
    });

    expect(h.events.map(({ event }) => event)).toEqual([
      'player:moved',
      'player:moved',
      'station:activated',
    ]);
    expect(adapter.facing).toBe('right');
  });

  it('orders restored street placement before building exit', () => {
    const h = capture();
    const adapter = createStreetMovementAdapter({
      emit: (event, payload) => h.events.push({ event, payload }),
    });
    adapter.streetUpdate({ x: 11, y: 20 }, { ...idle, left: true }, () => {});
    adapter.exit({ x: 12, y: 20 }, () => {
      h.events.push({ event: 'building:exited', payload: { building: 'bank' } });
    });

    expect(h.events.map(({ event }) => event)).toEqual([
      'player:moved',
      'player:moved',
      'building:exited',
    ]);
    expect(h.events[1]!.payload).toEqual({ position: { x: 12, y: 20 }, facing: 'left' });
  });
});
