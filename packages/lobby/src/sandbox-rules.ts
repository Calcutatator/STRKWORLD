/**
 * The block sandbox rules (D-060). Pure, synchronous, transport-free.
 *
 * One authority object owns every stack and every carried block. The lobby
 * room runs one instance per room and the Shell runs one locally for solo
 * play, so both paths apply exactly the same rules. Nothing here imports
 * Colyseus, touches the network or reads a clock; the only nondeterminism is
 * the injectable `random` source used by `spawn` and `returnCarried`.
 *
 * ## Coordinates
 *
 * Players are located in World pixels, tiles in street tile coordinates, with
 * `SANDBOX_TILE_SIZE` (32) pixels per tile. A player's tile is
 * `floor(x / 32), floor(y / 32)`; the level they stand on is the height of
 * the stack on that tile, and 0 anywhere outside `SANDBOX_AREA`.
 *
 * ## Reach
 *
 * "Next to the requester" means: the target tile is not the player's own tile
 * and its centre is within `SANDBOX_ACTION_RANGE` (48) pixels of the player's
 * position, measured as a square (Chebyshev) box — the same distance this
 * package uses for interest. From anywhere inside your own tile that box holds
 * all eight neighbouring tile centres, so the tile you face is always in range.
 *
 * ## Occupancy
 *
 * Nobody picks from or places onto the tile another player stands on: a
 * neighbour cannot pull the block out from under someone, nor bury them.
 *
 * ## Conservation
 *
 * Blocks are never destroyed by play. A carried block whose carrier leaves
 * the street is put back with `returnCarried` — it falls from the sky onto a
 * random allowed tile, as a spawn would — and is discarded only when no tile
 * is allowed at all. So the reach and step rules can be ignored by a hostile
 * client without it being able to empty the sandbox: blocks move, the total
 * stays.
 *
 * ## Anonymity
 *
 * Stacks carry colours only. The `key` of a `SandboxPlayer` exists solely so
 * the authority can remember who holds which carried block; it never appears
 * in `columns()`, a spawn or a return result, and a snapshot only ever
 * reports the requesting key's own carried colour.
 */

import {
  SANDBOX_AREA,
  SANDBOX_COLOURS,
  SANDBOX_ENTRANCE,
  SANDBOX_MAX_BLOCKS,
  SANDBOX_MAX_HEIGHT,
  SANDBOX_REACH_ABOVE,
  SANDBOX_REACH_BELOW,
  SANDBOX_STEP_HEIGHT,
  type SandboxColumn,
  type SandboxSnapshot,
  type SandboxTile,
} from '@strkworld/shared';

/** World pixels per street tile. */
export const SANDBOX_TILE_SIZE = 32;

/**
 * How far a target tile's centre may be from the player's position, in World
 * pixels, as a square (Chebyshev) distance. 1.5 tiles.
 */
export const SANDBOX_ACTION_RANGE = 48;

/** Delay between sky drops while the sandbox holds fewer than `SANDBOX_FAST_SPAWN_LIMIT` blocks. */
export const SANDBOX_SPAWN_INTERVAL_MS = 1500;

/** Delay between sky drops once the sandbox holds `SANDBOX_FAST_SPAWN_LIMIT` blocks or more. */
export const SANDBOX_SLOW_SPAWN_INTERVAL_MS = 5000;

/** Total blocks (placed and carried) at which drops slow from the fast to the slow interval. */
export const SANDBOX_FAST_SPAWN_LIMIT = 120;

/** Someone who can act on the sandbox. `x`/`y` are World pixels. */
export interface SandboxPlayer {
  /** Opaque, caller-chosen. Only used to remember carried blocks. */
  readonly key: string;
  readonly x: number;
  readonly y: number;
}

export interface SandboxAuthority {
  /** Every non-empty stack, sorted by `(y, x)`. Frozen; the same array until the next change. */
  columns(): readonly SandboxColumn[];
  /** The colour `key` is carrying, or null. */
  carrying(key: string): number | null;
  /** What `key` needs to draw the sandbox. Frozen. */
  snapshotFor(key: string): SandboxSnapshot;
  /** Placed plus carried blocks. Never exceeds `SANDBOX_MAX_BLOCKS`. */
  readonly totalBlocks: number;
  /**
   * Take the top block of a neighbouring stack that no player in `others`
   * stands on. False, and nothing changes, when a rule fails.
   */
  pick(player: SandboxPlayer, tile: SandboxTile, others: readonly SandboxPlayer[]): boolean;
  /**
   * Put the carried block on a neighbouring stack that no player in `others`
   * stands on; in the entrance, only where the stack stays within one step.
   * False, and nothing changes, when a rule fails.
   */
  place(player: SandboxPlayer, tile: SandboxTile, others: readonly SandboxPlayer[]): boolean;
  /**
   * Drop one block of a random colour onto a random allowed tile: inside the
   * area but outside `SANDBOX_ENTRANCE`, more than one tile (Chebyshev) from
   * every player's tile, and below the height cap. Null, and nothing changes,
   * when the block cap is reached, no tile is allowed or `players` is not an
   * array.
   *
   * Uniform over the allowed tiles enumerated in `(y, x)` order — the first
   * draw picks the index into that list, the second the colour — so a
   * scripted `random` places blocks exactly.
   */
  spawn(players: readonly SandboxPlayer[]): SandboxTile | null;
  /**
   * Put back the block `key` carries: it falls from the sky, keeping its
   * colour, onto a random tile chosen by the spawn rules — inside the area
   * but outside the entrance, more than one tile from every player in
   * `players`, below the height cap.
   * Returns that tile, and `key` then carries nothing.
   *
   * Include the carrier's last position in `players`: the block must never
   * land where its carrier stood, or the drop would mark where they left the
   * street. Returns null when `key` carries nothing; when no tile is allowed
   * (or `players` is not an array) the block is discarded instead and null is
   * returned. Draws once — the tile — and never when nothing falls.
   */
  returnCarried(key: string, players: readonly SandboxPlayer[]): SandboxTile | null;
  /** Discard the block `key` is carrying, if any. Prefer `returnCarried`. */
  release(key: string): void;
}

export interface SandboxAuthorityOptions {
  /**
   * Uniform `[0, 1)` source. Defaults to `Math.random`. `spawn` draws exactly
   * twice per new block — first the tile, then the colour — and
   * `returnCarried` once, the tile; neither draws when it returns null.
   * Out-of-range samples are clamped rather than trusted.
   */
  readonly random?: () => number;
}

/** Whether a street tile lies inside `SANDBOX_AREA`. Integers only. */
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

/**
 * Whether a street tile lies in `SANDBOX_ENTRANCE`, where nothing falls and
 * stacks stay within one step.
 */
export function isEntranceTile(tileX: number, tileY: number): boolean {
  return (
    Number.isInteger(tileX) &&
    Number.isInteger(tileY) &&
    tileX >= SANDBOX_ENTRANCE.x &&
    tileX < SANDBOX_ENTRANCE.x + SANDBOX_ENTRANCE.width &&
    tileY >= SANDBOX_ENTRANCE.y &&
    tileY < SANDBOX_ENTRANCE.y + SANDBOX_ENTRANCE.height
  );
}

/** The canonical `"x,y"` key of a tile, as used for stack maps and the room schema. */
export function sandboxTileKey(tileX: number, tileY: number): string {
  return `${tileX},${tileY}`;
}

/** The street tile under a World-pixel position, or null for a non-finite one. */
export function sandboxTileAt(x: number, y: number): SandboxTile | null {
  if (typeof x !== 'number' || typeof y !== 'number') return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x: Math.floor(x / SANDBOX_TILE_SIZE),
    y: Math.floor(y / SANDBOX_TILE_SIZE),
  };
}

/**
 * The level someone standing on a tile stands at: its stack height, and 0
 * outside the area or on an empty tile.
 *
 * Accepts either a column list (as in a snapshot) or a map keyed by
 * `sandboxTileKey` whose values are colour stacks.
 */
export function sandboxLevelAt(
  columns: readonly SandboxColumn[] | ReadonlyMap<string, readonly number[]>,
  tileX: number,
  tileY: number,
): number {
  if (!isSandboxTile(tileX, tileY)) return 0;
  if (Array.isArray(columns)) {
    for (const column of columns as readonly SandboxColumn[]) {
      if (column.x === tileX && column.y === tileY) return column.colours.length;
    }
    return 0;
  }
  const stacks = columns as ReadonlyMap<string, readonly number[]>;
  if (typeof stacks.get !== 'function') return 0;
  return stacks.get(sandboxTileKey(tileX, tileY))?.length ?? 0;
}

/** The delay before the next sky drop, given the current block total. */
export function sandboxSpawnDelay(totalBlocks: number): number {
  return totalBlocks < SANDBOX_FAST_SPAWN_LIMIT
    ? SANDBOX_SPAWN_INTERVAL_MS
    : SANDBOX_SLOW_SPAWN_INTERVAL_MS;
}

export function createSandboxAuthority(
  options: SandboxAuthorityOptions = {},
): SandboxAuthority {
  const random =
    options !== null && typeof options === 'object' && typeof options.random === 'function'
      ? options.random
      : Math.random;
  return new Authority(random);
}

// ---------------------------------------------------------------------------

interface Stack {
  readonly x: number;
  readonly y: number;
  readonly colours: number[];
}

const EMPTY_COLUMNS: readonly SandboxColumn[] = Object.freeze([]);

class Authority implements SandboxAuthority {
  readonly #random: () => number;
  /** Tile key to stack. A stack is deleted the moment it empties. */
  readonly #stacks = new Map<string, Stack>();
  /** Player key to carried colour. */
  readonly #carried = new Map<string, number>();
  #placed = 0;
  /** Cached frozen `columns()` result; null after any change to a stack. */
  #view: readonly SandboxColumn[] | null = EMPTY_COLUMNS;

  constructor(random: () => number) {
    this.#random = random;
  }

  get totalBlocks(): number {
    return this.#placed + this.#carried.size;
  }

  columns(): readonly SandboxColumn[] {
    if (this.#view === null) this.#view = freezeColumns(this.#stacks);
    return this.#view;
  }

  carrying(key: string): number | null {
    if (typeof key !== 'string') return null;
    return this.#carried.get(key) ?? null;
  }

  snapshotFor(key: string): SandboxSnapshot {
    return Object.freeze({ columns: this.columns(), carrying: this.carrying(key) });
  }

  pick(player: SandboxPlayer, tile: SandboxTile, others: readonly SandboxPlayer[]): boolean {
    const actor = readPlayer(player);
    const target = readTile(tile);
    if (actor === null || target === null) return false;
    if (this.#carried.has(actor.key)) return false;
    if (!inRange(actor, target)) return false;
    // Nobody pulls the floor out from under someone standing on it. As with
    // place, a list that cannot be read fails closed.
    if (!Array.isArray(others) || isOccupied(target, others)) return false;

    const key = sandboxTileKey(target.x, target.y);
    const stack = this.#stacks.get(key);
    if (stack === undefined || stack.colours.length < 1) return false;
    if (!withinReach(this.#levelOf(actor), stack.colours.length)) return false;

    const colour = stack.colours.pop() as number;
    if (stack.colours.length === 0) this.#stacks.delete(key);
    this.#placed -= 1;
    this.#carried.set(actor.key, colour);
    this.#view = null;
    return true;
  }

  place(player: SandboxPlayer, tile: SandboxTile, others: readonly SandboxPlayer[]): boolean {
    const actor = readPlayer(player);
    const target = readTile(tile);
    if (actor === null || target === null) return false;
    const colour = this.#carried.get(actor.key);
    if (colour === undefined) return false;
    if (!inRange(actor, target)) return false;
    // Occupancy cannot be verified without the list, so a malformed one fails
    // closed rather than letting a block land on someone.
    if (!Array.isArray(others) || isOccupied(target, others)) return false;

    const key = sandboxTileKey(target.x, target.y);
    const height = this.#stacks.get(key)?.colours.length ?? 0;
    if (height + 1 > SANDBOX_MAX_HEIGHT) return false;
    // The entrance must stay walkable: one step, never a wall.
    if (isEntranceTile(target.x, target.y) && height + 1 > SANDBOX_STEP_HEIGHT) return false;
    if (!withinReach(this.#levelOf(actor), height + 1)) return false;

    this.#push(target, colour);
    this.#carried.delete(actor.key);
    return true;
  }

  spawn(players: readonly SandboxPlayer[]): SandboxTile | null {
    if (this.totalBlocks >= SANDBOX_MAX_BLOCKS) return null;
    const open = this.#openTiles(players);
    if (open === null || open.length === 0) return null;

    // Both draws happen before any mutation, so a throwing source leaves the
    // sandbox exactly as it was.
    const tile = open[drawIndex(this.#random, open.length)] as SandboxTile;
    const colour = drawIndex(this.#random, SANDBOX_COLOURS);
    this.#push(tile, colour);
    return Object.freeze({ x: tile.x, y: tile.y });
  }

  returnCarried(key: string, players: readonly SandboxPlayer[]): SandboxTile | null {
    if (typeof key !== 'string') return null;
    const colour = this.#carried.get(key);
    if (colour === undefined) return null;
    const open = this.#openTiles(players);
    if (open === null || open.length === 0) {
      // Nowhere it may fall, or no way to know where the players are: it
      // leaves the game rather than landing on someone.
      this.#carried.delete(key);
      return null;
    }
    // The draw happens before any mutation, so a throwing source leaves the
    // block where it was: still carried.
    const tile = open[drawIndex(this.#random, open.length)] as SandboxTile;
    this.#push(tile, colour);
    this.#carried.delete(key);
    return Object.freeze({ x: tile.x, y: tile.y });
  }

  release(key: string): void {
    if (typeof key !== 'string') return;
    this.#carried.delete(key);
  }

  /**
   * Tiles a block may fall onto, in `(y, x)` order: inside the area, outside
   * the entrance (so the rain never walls the way in; players may still lay
   * blocks there), more than one tile (Chebyshev) from every locatable player,
   * below the height cap. Null when `players` is not an array — avoidance
   * cannot be verified.
   */
  #openTiles(players: readonly SandboxPlayer[]): SandboxTile[] | null {
    if (!Array.isArray(players)) return null;
    const blocked = new Set<string>();
    for (const candidate of players as readonly unknown[]) {
      const player = readPlayer(candidate);
      if (player === null) continue;
      const here = sandboxTileAt(player.x, player.y);
      if (here === null) continue;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          blocked.add(sandboxTileKey(here.x + dx, here.y + dy));
        }
      }
    }
    const open: SandboxTile[] = [];
    for (let y = SANDBOX_AREA.y; y < SANDBOX_AREA.y + SANDBOX_AREA.height; y += 1) {
      for (let x = SANDBOX_AREA.x; x < SANDBOX_AREA.x + SANDBOX_AREA.width; x += 1) {
        if (isEntranceTile(x, y)) continue;
        const key = sandboxTileKey(x, y);
        if (blocked.has(key)) continue;
        if ((this.#stacks.get(key)?.colours.length ?? 0) >= SANDBOX_MAX_HEIGHT) continue;
        open.push({ x, y });
      }
    }
    return open;
  }

  #push(tile: SandboxTile, colour: number): void {
    const key = sandboxTileKey(tile.x, tile.y);
    let stack = this.#stacks.get(key);
    if (stack === undefined) {
      stack = { x: tile.x, y: tile.y, colours: [] };
      this.#stacks.set(key, stack);
    }
    stack.colours.push(colour);
    this.#placed += 1;
    this.#view = null;
  }

  #levelOf(player: SandboxPlayer): number {
    const here = sandboxTileAt(player.x, player.y);
    if (here === null || !isSandboxTile(here.x, here.y)) return 0;
    return this.#stacks.get(sandboxTileKey(here.x, here.y))?.colours.length ?? 0;
  }
}

/** Block tops a player standing at `level` can pick from or place onto. */
function withinReach(level: number, top: number): boolean {
  return top >= level - SANDBOX_REACH_BELOW && top <= level + SANDBOX_REACH_ABOVE;
}

/** Not the player's own tile, and the tile centre within the action range. */
function inRange(player: SandboxPlayer, tile: SandboxTile): boolean {
  const here = sandboxTileAt(player.x, player.y);
  if (here === null) return false;
  if (here.x === tile.x && here.y === tile.y) return false;
  const centreX = tile.x * SANDBOX_TILE_SIZE + SANDBOX_TILE_SIZE / 2;
  const centreY = tile.y * SANDBOX_TILE_SIZE + SANDBOX_TILE_SIZE / 2;
  return (
    Math.max(Math.abs(centreX - player.x), Math.abs(centreY - player.y)) <=
    SANDBOX_ACTION_RANGE
  );
}

/** Whether any locatable player in `others` stands on `tile`. */
function isOccupied(tile: SandboxTile, others: readonly unknown[]): boolean {
  for (const candidate of others) {
    const other = readPlayer(candidate);
    if (other === null) continue;
    const there = sandboxTileAt(other.x, other.y);
    if (there !== null && there.x === tile.x && there.y === tile.y) return true;
  }
  return false;
}

/** A usable player, or null. Never throws, whatever the caller passed. */
function readPlayer(value: unknown): SandboxPlayer | null {
  if (value === null || typeof value !== 'object') return null;
  try {
    const { key, x, y } = value as { key?: unknown; x?: unknown; y?: unknown };
    if (typeof key !== 'string') return null;
    if (typeof x !== 'number' || !Number.isFinite(x)) return null;
    if (typeof y !== 'number' || !Number.isFinite(y)) return null;
    return { key, x, y };
  } catch {
    return null;
  }
}

/** An in-area tile with integer coordinates, or null. Never throws. */
function readTile(value: unknown): SandboxTile | null {
  if (value === null || typeof value !== 'object') return null;
  try {
    const { x, y } = value as { x?: unknown; y?: unknown };
    if (typeof x !== 'number' || typeof y !== 'number') return null;
    return isSandboxTile(x, y) ? { x, y } : null;
  } catch {
    return null;
  }
}

/** A uniform index in `[0, size)` from one draw, clamping a misbehaving source. */
function drawIndex(random: () => number, size: number): number {
  const sample = random();
  const unit =
    typeof sample === 'number' && Number.isFinite(sample) ? Math.min(Math.max(sample, 0), 1) : 0;
  return Math.min(size - 1, Math.floor(unit * size));
}

function freezeColumns(stacks: ReadonlyMap<string, Stack>): readonly SandboxColumn[] {
  const columns: SandboxColumn[] = [];
  for (const stack of stacks.values()) {
    if (stack.colours.length === 0) continue;
    columns.push(
      Object.freeze({ x: stack.x, y: stack.y, colours: Object.freeze([...stack.colours]) }),
    );
  }
  columns.sort((a, b) => a.y - b.y || a.x - b.x);
  return Object.freeze(columns);
}
