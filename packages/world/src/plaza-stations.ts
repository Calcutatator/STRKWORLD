import type { EventBus, ShellEvents, StationId, WorldEvents } from '@strkworld/shared';
import { isPlazaNearby, plazaStationAtApproach } from './map/plaza.js';

/**
 * The Privacy Plaza's stations on the street (D-076), renderer-free.
 *
 * The plaza is outdoors on a shared street, so walking past must not open
 * anything: the player walks up, then presses E. D-117 made that every
 * station's rule (the session's interaction system offers the highlighted
 * station here and calls `activate`). The handoff is the fixed rooms' own,
 * with the plaza as the building: the World suspends input before
 * it emits `station:activated`, the Shell claims the controls with
 * `world:control-owner` while that event is delivered, and hands them back
 * the same way when its window closes. If the Shell does not claim them, the
 * World takes its input straight back. Nothing here leaves the street, enters
 * a building or changes lobby presence.
 *
 * It also reports when the plaza comes into view (`plaza:nearby`), so the
 * Shell reads the pool's public stats only while someone can see them, and
 * forwards the Shell's pre-formatted figures (`plaza:stats`) to the monument.
 */

/**
 * The monument's figures as the World draws them; a null part reads "…".
 * D-080: `held`'s per-token amounts were replaced with the pool's USD value
 * and its top holdings by value. D-098: the total now has its own shaft face
 * (where the 24-hour deposit count was), so the die's held face cycles the
 * top holdings alone.
 */
export interface PlazaStatsPresentation {
  readonly accounts: string | null;
  /** Compact total held in the pool, e.g. "$1.18M". */
  readonly valueUsd: string | null;
  /** Compact "SYMBOL · $usd" lines, most valuable first. */
  readonly topHoldings: readonly string[] | null;
}

export const EMPTY_PLAZA_STATS: PlazaStatsPresentation = Object.freeze({
  accounts: null,
  valueUsd: null,
  topHoldings: null,
});

/** Longest figure the monument prints; anything longer is not a figure. */
export const MAX_PLAZA_FIGURE_LENGTH = 24;
/** Most holding lines the monument cycles through. */
export const MAX_PLAZA_HELD_LINES = 16;

export interface PlazaInputGate {
  suspend(): void;
  resume(): void;
  readonly suspended?: boolean;
}

export interface PlazaState {
  readonly near: boolean;
  readonly highlightedStation: StationId | null;
  readonly controlOwner: 'world' | 'shell';
}

export interface PlazaController {
  readonly state: PlazaState;
  /** The player's street tile changed. */
  update(tile: { readonly x: number; readonly y: number }): void;
  /** E on the street: use the station the player stands at. Whether one was used. */
  activate(): boolean;
  destroy(): void;
}

export interface PlazaControllerOptions {
  readonly out: Pick<EventBus<WorldEvents>, 'emit'>;
  readonly in?: Pick<EventBus<ShellEvents>, 'on'>;
  readonly input: PlazaInputGate;
  /** The station E would use changed; null for none. */
  readonly onHighlight?: (station: StationId | null) => void;
  /** New figures from the Shell, already checked. */
  readonly onStats?: (stats: PlazaStatsPresentation) => void;
}

export function createPlazaController(options: PlazaControllerOptions): PlazaController {
  let near = false;
  let highlighted: StationId | null = null;
  let controlOwner: 'world' | 'shell' = 'world';
  // True only while this controller's own `station:activated` is delivered:
  // the one moment the Shell may claim the controls.
  let activating = false;
  let destroyed = false;
  const stops: Array<() => void> = [];

  try {
    const stopOwner = options.in?.on('world:control-owner', (payload) => {
      if (destroyed || ownData(payload, 'building') !== 'plaza') return;
      const owner = ownData(payload, 'owner');
      if (owner === 'shell') {
        // A claim outside an activation is stale: nothing of ours is open.
        if (!activating || controlOwner === 'shell') return;
        controlOwner = 'shell';
        try {
          options.input.suspend();
        } catch (error) {
          controlOwner = 'world';
          throw error;
        }
      } else if (owner === 'world') {
        if (controlOwner !== 'shell') return;
        controlOwner = 'world';
        try {
          options.input.resume();
        } catch (error) {
          // The gate fails closed; keep the Shell's claim so the same
          // hand-back can be retried.
          controlOwner = 'shell';
          throw error;
        }
      }
    });
    if (stopOwner) stops.push(stopOwner);
    const stopStats = options.in?.on('plaza:stats', (payload) => {
      if (destroyed) return;
      options.onStats?.(normalizePlazaStats(payload));
    });
    if (stopStats) stops.push(stopStats);
  } catch (error) {
    for (const stop of stops.splice(0)) {
      try {
        stop();
      } catch {
        // Preserve the registration failure.
      }
    }
    throw error;
  }

  return {
    get state(): PlazaState {
      return { near, highlightedStation: highlighted, controlOwner };
    },

    update(tile): void {
      if (destroyed) return;
      const next = plazaStationAtApproach(tile.x, tile.y)?.station ?? null;
      if (next !== highlighted) {
        highlighted = next;
        options.onHighlight?.(next);
      }
      const inView = isPlazaNearby(tile.x, tile.y);
      if (inView === near || destroyed) return;
      near = inView;
      try {
        options.out.emit('plaza:nearby', Object.freeze({ near: inView }));
      } catch (error) {
        // Keep the change retryable: the next tile report announces it again.
        if (near === inView) near = !inView;
        throw error;
      }
    },

    activate(): boolean {
      if (destroyed || activating || controlOwner === 'shell') return false;
      const station = highlighted;
      if (!station) return false;
      try {
        if (options.input.suspended === true) return false;
      } catch {
        return false;
      }
      activating = true;
      try {
        options.input.suspend();
      } catch (error) {
        activating = false;
        throw error;
      }
      let deliveryError: unknown;
      let deliveryFailed = false;
      try {
        options.out.emit('station:activated', Object.freeze({ building: 'plaza', station }));
      } catch (error) {
        deliveryError = error;
        deliveryFailed = true;
      } finally {
        activating = false;
      }
      // No window claimed the controls (or delivery failed): take them back,
      // so a missing Shell can never strand the player.
      if (!destroyed && controlOwner === 'world') {
        try {
          options.input.resume();
        } catch (error) {
          if (deliveryFailed) throw new AggregateError([deliveryError, error], 'Plaza station activation failed');
          throw error;
        }
      }
      if (deliveryFailed) throw deliveryError;
      return true;
    },

    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      const wasNear = near;
      near = false;
      highlighted = null;
      controlOwner = 'world';
      const errors: unknown[] = [];
      // Take "in view" back: a World torn down at the plaza (a rebuild, a
      // reload of the room) must not leave the Shell reading for nobody, and
      // the next World's plaza coming into view then tells it again.
      if (wasNear) {
        try {
          options.out.emit('plaza:nearby', Object.freeze({ near: false }));
        } catch (error) {
          errors.push(error);
        }
      }
      for (const stop of stops.splice(0)) {
        try {
          stop();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'Plaza cleanup failed');
    },
  };
}

/**
 * The Shell's figures, read strictly: own data fields, strings only, short,
 * and at most `MAX_PLAZA_HELD_LINES` holding lines. Anything else reads as
 * not known, which the monument draws as "…"; it is never a number to
 * compute on.
 */
export function normalizePlazaStats(value: unknown): PlazaStatsPresentation {
  return Object.freeze({
    accounts: figure(ownData(value, 'accounts')),
    valueUsd: figure(ownData(value, 'valueUsd')),
    topHoldings: figureLines(ownData(value, 'topHoldings')),
  });
}

/** A bounded array of short figure strings, or null if anything about it is off. */
function figureLines(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const length = ownData(value, 'length');
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length <= 0 || length > MAX_PLAZA_HELD_LINES) {
    return null;
  }
  const read: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const line = figure(ownData(value, String(index)));
    if (line === null) break;
    read.push(line);
  }
  return read.length === length ? Object.freeze(read) : null;
}

function figure(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text.length === 0 || text.length > MAX_PLAZA_FIGURE_LENGTH || /[\n\r]/.test(text)) return null;
  return text;
}

function ownData(value: unknown, key: string): unknown {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}
