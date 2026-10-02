import type { Placement, PlacementCheck } from '@strkworld/privacy';
import { browserViewerStorage, type ViewerStorage } from '../store/viewer-storage.js';

/**
 * Leaderboard phase 1, the Shell's half of the placement stand: turn a
 * placement check into what the panel shows, and keep the one thing the
 * device remembers between checks.
 *
 * The privacy package works out the placement on the player's device and
 * hands back counts only. It is shown only in the stand's panel: never on the
 * avatar, the HUD, presence or the lobby, and nothing here sends it anywhere.
 * The device keeps `{ placement, count, checkedAt, season }` in `localStorage`
 * and nothing else: no commitment, no address, no history.
 *
 * Type imports only: a value import of the seam would pull `starknet` into
 * the entry chunk (`architecture.test.ts`).
 */

/** The one storage key, per device. */
export const PLACEMENT_STORAGE_KEY = 'strkworld:placement';

/** What this device remembers between checks: exactly four fields. */
export interface PlacementRecord {
  readonly placement: Placement | null;
  readonly count: number;
  readonly checkedAt: number;
  readonly season: string;
}

/** The return hook: "+N since your last check, up X places". */
export interface PlacementProgress {
  readonly newActions: number;
  /** Places climbed since then; negative when others passed you. */
  readonly placesUp: number;
}

export interface PlacementView {
  readonly season: string;
  /** Every private action counted: receipts plus DeFi ticks. */
  readonly count: number;
  /** The count ranked against the histogram. */
  readonly ranked: number;
  /** DeFi actions counted on this device but not in the ranking yet. */
  readonly defiOnly: number;
  readonly placement: Placement | null;
  /** False when the ranking could not be reached: only the player's own count shows. */
  readonly ranking: boolean;
  readonly progress: PlacementProgress | null;
}

/** The panel's view of a check, against what this device saw last time. */
export function placementView(check: PlacementCheck, previous: PlacementRecord | null): PlacementView {
  const count = check.receipts + check.defi;
  return Object.freeze({
    season: check.season,
    count,
    ranked: check.ranked,
    defiOnly: check.defi,
    placement: check.placement,
    ranking: check.histogram !== null,
    progress: placementProgress(previous, { placement: check.placement, count, season: check.season }),
  });
}

/** "+N since your last check, up X places", within one season only; null on a first check. */
export function placementProgress(
  previous: PlacementRecord | null,
  current: Pick<PlacementRecord, 'placement' | 'count' | 'season'>,
): PlacementProgress | null {
  if (!previous || previous.season !== current.season) return null;
  const newActions = Math.max(0, current.count - previous.count);
  const placesUp = previous.placement && current.placement ? previous.placement.rank - current.placement.rank : 0;
  return Object.freeze({ newActions, placesUp });
}

/** What this device remembers of a check. */
export function placementRecord(view: PlacementView, checkedAt: number): PlacementRecord {
  return Object.freeze({ placement: view.placement, count: view.count, checkedAt, season: view.season });
}

/** The last check on this device, read strictly; anything else is a first check. Never throws. */
export function readPlacementRecord(storage: ViewerStorage = browserViewerStorage): PlacementRecord | null {
  try {
    const raw = storage.read(PLACEMENT_STORAGE_KEY);
    if (raw === null) return null;
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    if (Object.keys(value).sort().join(',') !== 'checkedAt,count,placement,season') return null;
    const { placement, count, checkedAt, season } = value as Record<string, unknown>;
    if (typeof season !== 'string' || !/^[a-z0-9]{1,8}$/.test(season)) return null;
    if (!Number.isSafeInteger(count) || (count as number) < 0) return null;
    if (!Number.isSafeInteger(checkedAt) || (checkedAt as number) < 0) return null;
    return Object.freeze({ placement: ownPlacement(placement), count: count as number, checkedAt: checkedAt as number, season });
  } catch {
    return null;
  }
}

/** Remember this check on this device: the four fields, and nothing else. A refused write is not an error. */
export function writePlacementRecord(record: PlacementRecord, storage: ViewerStorage = browserViewerStorage): boolean {
  try {
    const placement = record.placement
      ? { rank: record.placement.rank, total: record.placement.total, topPercent: record.placement.topPercent }
      : null;
    return storage.write(
      PLACEMENT_STORAGE_KEY,
      JSON.stringify({ placement, count: record.count, checkedAt: record.checkedAt, season: record.season }),
    );
  } catch {
    return false;
  }
}

function ownPlacement(value: unknown): Placement | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const { rank, total, topPercent } = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(rank) || (rank as number) < 1
    || !Number.isSafeInteger(total) || (total as number) < (rank as number)
    || !Number.isSafeInteger(topPercent) || (topPercent as number) < 1 || (topPercent as number) > 100
  ) {
    return null;
  }
  return Object.freeze({ rank: rank as number, total: total as number, topPercent: topPercent as number });
}
