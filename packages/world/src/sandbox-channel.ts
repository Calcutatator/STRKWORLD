import {
  SANDBOX_AREA,
  SANDBOX_COLOURS,
  SANDBOX_MAX_BLOCKS,
  SANDBOX_MAX_HEIGHT,
  type SandboxColumn,
  type SandboxSnapshot,
  type SandboxTile,
} from '@strkworld/shared';

/**
 * The World's view of the shared block sandbox (D-060).
 *
 * The Shell supplies it — backed by the lobby in multiplayer and by a local
 * authority when playing solo — so the World never imports the lobby. The
 * World reads stack heights for movement and drawing and sends pick/place
 * intents; the authority decides, and the next snapshot is the only truth.
 */
export interface SandboxChannel {
  /** Replays the latest snapshot synchronously, then every change. */
  subscribe(listener: (snapshot: SandboxSnapshot) => void): () => void;
  /** Sky drops, as animation hints only. */
  subscribeDrops?(listener: (tile: SandboxTile) => void): () => void;
  pick(tile: SandboxTile): void;
  place(tile: SandboxTile): void;
}

export const EMPTY_SANDBOX_SNAPSHOT: SandboxSnapshot = Object.freeze({
  columns: Object.freeze([]) as readonly SandboxColumn[],
  carrying: null,
});

/** Is this street tile inside the sandbox square? */
export function isSandboxTile(tileX: number, tileY: number): boolean {
  return (
    Number.isInteger(tileX) &&
    Number.isInteger(tileY) &&
    tileX >= SANDBOX_AREA.x &&
    tileX < SANDBOX_AREA.x + SANDBOX_AREA.width &&
    tileY >= SANDBOX_AREA.y &&
    tileY < SANDBOX_AREA.y + SANDBOX_AREA.height
  );
}

export function isSandboxColour(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < SANDBOX_COLOURS;
}

/**
 * Validate an untrusted snapshot. Malformed columns and colours are dropped
 * rather than repaired: a block the authority did not clearly send is not
 * drawn and cannot be stood on. The result is frozen.
 */
export function normalizeSandboxSnapshot(value: unknown): SandboxSnapshot {
  if (value === null || typeof value !== 'object') return EMPTY_SANDBOX_SNAPSHOT;
  const record = value as { readonly columns?: unknown; readonly carrying?: unknown };
  let rawColumns: unknown;
  let rawCarrying: unknown;
  try {
    rawColumns = record.columns;
    rawCarrying = record.carrying;
  } catch {
    return EMPTY_SANDBOX_SNAPSHOT;
  }
  const columns: SandboxColumn[] = [];
  const seen = new Set<string>();
  let blocks = 0;
  if (Array.isArray(rawColumns)) {
    for (const entry of rawColumns) {
      const column = normalizeColumn(entry);
      if (!column) continue;
      const key = `${column.x},${column.y}`;
      if (seen.has(key)) continue;
      if (blocks + column.colours.length > SANDBOX_MAX_BLOCKS) break;
      seen.add(key);
      blocks += column.colours.length;
      columns.push(column);
    }
  }
  return Object.freeze({
    columns: Object.freeze(columns),
    carrying: isSandboxColour(rawCarrying) ? rawCarrying : null,
  });
}

function normalizeColumn(value: unknown): SandboxColumn | null {
  if (value === null || typeof value !== 'object') return null;
  let x: unknown;
  let y: unknown;
  let colours: unknown;
  try {
    ({ x, y, colours } = value as { x?: unknown; y?: unknown; colours?: unknown });
  } catch {
    return null;
  }
  if (typeof x !== 'number' || typeof y !== 'number' || !isSandboxTile(x, y)) return null;
  if (!Array.isArray(colours) || colours.length === 0 || colours.length > SANDBOX_MAX_HEIGHT) return null;
  const clean: number[] = [];
  for (const colour of colours) {
    if (!isSandboxColour(colour)) return null;
    clean.push(colour);
  }
  return Object.freeze({ x, y, colours: Object.freeze(clean) });
}

export function normalizeSandboxTile(value: unknown): SandboxTile | null {
  if (value === null || typeof value !== 'object') return null;
  let x: unknown;
  let y: unknown;
  try {
    ({ x, y } = value as { x?: unknown; y?: unknown });
  } catch {
    return null;
  }
  if (typeof x !== 'number' || typeof y !== 'number' || !isSandboxTile(x, y)) return null;
  return Object.freeze({ x, y });
}
