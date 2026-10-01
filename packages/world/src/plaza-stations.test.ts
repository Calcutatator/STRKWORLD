import { describe, expect, it, vi } from 'vitest';
import { STREET_ORIGIN_X, type ShellEvents, type StationId, type WorldEvents } from '@strkworld/shared';
import { PLAZA_MONUMENT_STATION, PLAZA_SHELLS_STATION } from './map/plaza.js';
import {
  EMPTY_PLAZA_STATS,
  MAX_PLAZA_FIGURE_LENGTH,
  MAX_PLAZA_HELD_LINES,
  createPlazaController,
  normalizePlazaStats,
  type PlazaStatsPresentation,
} from './plaza-stations.js';

/**
 * The Privacy Plaza's stations on the street (D-076): E at an approach, the
 * fixed rooms' control handoff, the "plaza in view" signal and the monument's
 * figures, all without a renderer.
 */

type Listener = (payload: unknown) => void;

function setup() {
  const journal: string[] = [];
  const emitted: Array<{ event: keyof WorldEvents; payload: unknown }> = [];
  const shell = new Map<keyof ShellEvents, Set<Listener>>();
  let duringEmit: ((event: keyof WorldEvents) => void) | null = null;
  let suspended = false;
  const input = {
    suspend: vi.fn(() => {
      journal.push('input.suspend');
      suspended = true;
    }),
    resume: vi.fn(() => {
      journal.push('input.resume');
      suspended = false;
    }),
    get suspended() {
      return suspended;
    },
  };
  const highlights: Array<StationId | null> = [];
  const stats: PlazaStatsPresentation[] = [];
  const controller = createPlazaController({
    out: {
      emit(event, payload) {
        journal.push(`out:${event}`);
        emitted.push({ event, payload });
        duringEmit?.(event);
      },
    },
    in: {
      on(event, handler) {
        const set = shell.get(event) ?? new Set<Listener>();
        set.add(handler as Listener);
        shell.set(event, set);
        return () => set.delete(handler as Listener);
      },
    },
    input,
    onHighlight: (station) => highlights.push(station),
    onStats: (next) => stats.push(next),
  });
  const shellEmit = <K extends keyof ShellEvents>(event: K, payload: ShellEvents[K] | unknown): void => {
    for (const handler of [...(shell.get(event) ?? [])]) handler(payload);
  };
  return {
    controller,
    journal,
    emitted,
    input,
    highlights,
    stats,
    shellEmit,
    listeners: () => [...shell.values()].reduce((total, set) => total + set.size, 0),
    /** Run `run` while the next World event is being delivered, as the Shell does. */
    whileDelivering(run: (event: keyof WorldEvents) => void) {
      duringEmit = (event) => {
        duringEmit = null;
        run(event);
      };
    },
  };
}

/** Street tiles count from the street's first column (D-078), as the plaza does. */
const X = STREET_ORIGIN_X;
/** The tile just south of the monument (its approach), and one beside the table. */
const AT_MONUMENT = { x: X + 5, y: 25 };
const AT_TABLE = { x: X + 10, y: 23 };
const ON_ROAD = { x: X + 5, y: 15 };
const FAR = { x: X + 24, y: 15 };

describe('the plaza stations (D-076)', () => {
  it('announces the plaza coming into view and leaving it, once each way', () => {
    const plaza = setup();
    plaza.controller.update(FAR);
    expect(plaza.emitted).toEqual([]);
    plaza.controller.update(ON_ROAD);
    plaza.controller.update(AT_MONUMENT);
    plaza.controller.update(FAR);
    expect(plaza.emitted).toEqual([
      { event: 'plaza:nearby', payload: { near: true } },
      { event: 'plaza:nearby', payload: { near: false } },
    ]);
    expect(plaza.controller.state.near).toBe(false);
  });

  it('highlights the station whose approach the player stands in, and clears it on leaving', () => {
    const plaza = setup();
    plaza.controller.update(ON_ROAD);
    plaza.controller.update(AT_MONUMENT);
    plaza.controller.update({ x: X + 6, y: 25 });
    plaza.controller.update(AT_TABLE);
    plaza.controller.update({ x: X + 5, y: 20 });
    expect(plaza.highlights).toEqual([PLAZA_MONUMENT_STATION, PLAZA_SHELLS_STATION, null]);
    expect(plaza.controller.state.highlightedStation).toBeNull();
  });

  it('does nothing on E away from a station', () => {
    const plaza = setup();
    plaza.controller.update({ x: X + 5, y: 20 });
    expect(plaza.controller.activate()).toBe(false);
    expect(plaza.input.suspend).not.toHaveBeenCalled();
    expect(plaza.emitted.filter((entry) => entry.event === 'station:activated')).toEqual([]);
  });

  it('suspends input before it activates the station, and keeps it while the Shell owns the controls', () => {
    const plaza = setup();
    plaza.controller.update(AT_TABLE);
    plaza.whileDelivering((event) => {
      if (event === 'station:activated') plaza.shellEmit('world:control-owner', { building: 'plaza', owner: 'shell' });
    });
    expect(plaza.controller.activate()).toBe(true);
    // Suspended first; the Shell's claim, during delivery, holds it (the fixed rooms' order).
    expect(plaza.journal.slice(-3)).toEqual(['input.suspend', 'out:station:activated', 'input.suspend']);
    expect(plaza.emitted.at(-1)).toEqual({
      event: 'station:activated',
      payload: { building: 'plaza', station: PLAZA_SHELLS_STATION },
    });
    expect(plaza.input.suspended).toBe(true);
    expect(plaza.controller.state.controlOwner).toBe('shell');
    // E again while the window is open does nothing.
    expect(plaza.controller.activate()).toBe(false);

    // The window closes: the Shell hands the controls back.
    plaza.shellEmit('world:control-owner', { building: 'plaza', owner: 'world' });
    expect(plaza.input.suspended).toBe(false);
    expect(plaza.controller.state.controlOwner).toBe('world');
    // And the player can use the station again from where they stand.
    expect(plaza.controller.activate()).toBe(true);
  });

  it('takes its input straight back when no window claims the controls', () => {
    const plaza = setup();
    plaza.controller.update(AT_MONUMENT);
    expect(plaza.controller.activate()).toBe(true);
    expect(plaza.journal.slice(-3)).toEqual(['input.suspend', 'out:station:activated', 'input.resume']);
    expect(plaza.input.suspended).toBe(false);
  });

  it('ignores control commands that are stale, for another building, or malformed', () => {
    const plaza = setup();
    plaza.controller.update(AT_MONUMENT);
    plaza.shellEmit('world:control-owner', { building: 'plaza', owner: 'shell' });
    plaza.shellEmit('world:control-owner', { building: 'bank', owner: 'shell' });
    plaza.shellEmit('world:control-owner', null);
    const hostile = {};
    Object.defineProperty(hostile, 'building', { get: () => 'plaza' });
    Object.defineProperty(hostile, 'owner', { get: () => 'shell' });
    plaza.shellEmit('world:control-owner', hostile);
    expect(plaza.input.suspend).not.toHaveBeenCalled();
    expect(plaza.controller.state.controlOwner).toBe('world');
    // A hand-back with nothing claimed resumes nothing.
    plaza.shellEmit('world:control-owner', { building: 'plaza', owner: 'world' });
    expect(plaza.input.resume).not.toHaveBeenCalled();
  });

  it('does not open a station while something else already suspended input', () => {
    const plaza = setup();
    plaza.controller.update(AT_MONUMENT);
    plaza.input.suspend();
    plaza.input.suspend.mockClear();
    expect(plaza.controller.activate()).toBe(false);
    expect(plaza.input.suspend).not.toHaveBeenCalled();
    expect(plaza.emitted.filter((entry) => entry.event === 'station:activated')).toEqual([]);
  });

  it('hands input back and rethrows when delivering the activation fails', () => {
    const plaza = setup();
    plaza.controller.update(AT_MONUMENT);
    const error = new Error('shell fell over');
    plaza.whileDelivering(() => {
      throw error;
    });
    expect(() => plaza.controller.activate()).toThrow(error);
    expect(plaza.input.suspended).toBe(false);
    expect(plaza.controller.state.controlOwner).toBe('world');
  });

  it('keeps a failed "in view" announcement retryable', () => {
    const plaza = setup();
    plaza.whileDelivering(() => {
      throw new Error('bus down');
    });
    expect(() => plaza.controller.update(ON_ROAD)).toThrow('bus down');
    expect(plaza.controller.state.near).toBe(false);
    plaza.controller.update(AT_MONUMENT);
    expect(plaza.controller.state.near).toBe(true);
    expect(plaza.emitted.filter((entry) => entry.event === 'plaza:nearby')).toHaveLength(2);
  });

  it("forwards the Shell's figures, checked", () => {
    const plaza = setup();
    plaza.shellEmit('plaza:stats', { accounts: '2,932', valueUsd: '$1.18M', topHoldings: ['xSTRK · $453K'] });
    plaza.shellEmit('plaza:stats', { accounts: null, valueUsd: null, topHoldings: null });
    expect(plaza.stats).toEqual([
      { accounts: '2,932', valueUsd: '$1.18M', topHoldings: ['xSTRK · $453K'] },
      EMPTY_PLAZA_STATS,
    ]);
  });

  it('takes "in view" back on destroy, unsubscribes, and ignores everything after', () => {
    const plaza = setup();
    expect(plaza.listeners()).toBe(2);
    plaza.controller.update(AT_MONUMENT);
    plaza.controller.destroy();
    plaza.controller.destroy();
    expect(plaza.listeners()).toBe(0);
    expect(plaza.controller.activate()).toBe(false);
    plaza.controller.update(FAR);
    expect(plaza.emitted.filter((entry) => entry.event === 'plaza:nearby').map((entry) => entry.payload)).toEqual([
      { near: true },
      { near: false },
    ]);
    // A World torn down away from the plaza has nothing to take back.
    const away = setup();
    away.controller.update(FAR);
    away.controller.destroy();
    expect(away.emitted.filter((entry) => entry.event === 'plaza:nearby')).toEqual([]);
  });
});

describe('the monument figures (D-076; USD value D-080)', () => {
  it('reads only short strings from own data fields', () => {
    expect(normalizePlazaStats({
      accounts: ' 2,932 ',
      valueUsd: '$1.18M',
      topHoldings: ['xSTRK · $453K'],
    })).toEqual({
      accounts: '2,932',
      valueUsd: '$1.18M',
      topHoldings: ['xSTRK · $453K'],
    });
    expect(normalizePlazaStats({ accounts: 2932, valueUsd: 1_177_415, topHoldings: 'xSTRK' })).toEqual(EMPTY_PLAZA_STATS);
    expect(normalizePlazaStats({ accounts: 'x'.repeat(MAX_PLAZA_FIGURE_LENGTH + 1), valueUsd: '', topHoldings: [] })).toEqual(EMPTY_PLAZA_STATS);
    expect(normalizePlazaStats({ accounts: 'two\nlines', valueUsd: null, topHoldings: null }).accounts).toBeNull();
    expect(normalizePlazaStats(null)).toEqual(EMPTY_PLAZA_STATS);
  });

  it('refuses accessors, bad lines and too many holdings', () => {
    const hostile = {};
    let read = false;
    Object.defineProperty(hostile, 'accounts', {
      get() {
        read = true;
        return '1';
      },
    });
    expect(normalizePlazaStats(hostile).accounts).toBeNull();
    expect(read).toBe(false);
    expect(normalizePlazaStats({ topHoldings: ['xSTRK · $1', 7] }).topHoldings).toBeNull();
    expect(normalizePlazaStats({ topHoldings: Array.from({ length: MAX_PLAZA_HELD_LINES + 1 }, () => 'xSTRK · $1') }).topHoldings).toBeNull();
    expect(normalizePlazaStats({ topHoldings: Array.from({ length: MAX_PLAZA_HELD_LINES }, () => 'xSTRK · $1') }).topHoldings).toHaveLength(MAX_PLAZA_HELD_LINES);
  });
});
