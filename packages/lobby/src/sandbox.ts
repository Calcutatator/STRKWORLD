/**
 * The room's block sandbox (D-060): one rules authority, its mirror in the
 * room schema, and the per-session action floor. No transport.
 *
 * The authority in `sandbox-rules.ts` is the truth; the `MapSchema` handed to
 * this class is a copy that exists only so Colyseus can encode it. Every
 * change goes authority first, then the touched tile is copied across, so the
 * two can never disagree about more than the tile being written. A burst
 * (D-071) empties the authority, so it empties the whole mirror.
 *
 * Everything here is keyed by the caller's connection key, which never leaves
 * the server. The mirror holds tiles and colours only: no identity field is
 * written through this class. (Timing is another matter — see state.ts.)
 */

import type { MapSchema } from '@colyseus/schema';
import type { SandboxColumn, SandboxTile } from '@strkworld/shared';
import { resolveRoomConfig } from './config.js';
import { UpdateThrottle, normalizeSandboxTile } from './policy.js';
import {
  createSandboxAuthority,
  isSandboxBurst,
  sandboxTileKey,
  type SandboxAuthority,
  type SandboxLanding,
  type SandboxPlayer,
} from './sandbox-rules.js';
import { SandboxColumnEntry } from './state.js';

export type SandboxAction = 'pick' | 'place';

export type SandboxActionOutcome =
  /** The authority accepted it; state changed. A place may have burst the sandbox. */
  | 'applied'
  /** Well-formed and on time, but a sandbox rule refused it. Nothing changed. */
  | 'rejected'
  /** Arrived inside the session's action floor and was dropped. */
  | 'throttled'
  /** The payload was not an integer tile inside the sandbox. */
  | 'malformed'
  /** No live entry — unknown or currently suspended. */
  | 'absent';

export interface LobbySandboxOptions {
  /** Uniform `[0, 1)` source for spawns. Injectable for deterministic tests. */
  readonly random?: () => number;
  readonly actionIntervalMs?: number;
  readonly spawnIntervalMs?: number;
  readonly slowSpawnIntervalMs?: number;
  readonly fastSpawnLimit?: number;
  /**
   * D-071: told when a block bursts the sandbox — a place, a spawn or a
   * returned block — with the tile of the column that tipped it, after the
   * mirror is empty. Tile only, whoever caused it.
   */
  readonly onBurst?: (tile: SandboxTile) => void;
}

export class LobbySandbox {
  readonly #mirror: MapSchema<SandboxColumnEntry>;
  readonly #authority: SandboxAuthority;
  readonly #throttle: UpdateThrottle;
  readonly #spawnIntervalMs: number;
  readonly #slowSpawnIntervalMs: number;
  readonly #fastSpawnLimit: number;
  readonly #onBurst: ((tile: SandboxTile) => void) | undefined;

  constructor(mirror: MapSchema<SandboxColumnEntry>, options: LobbySandboxOptions = {}) {
    this.#mirror = mirror;
    // Clamp through the same resolver as the room config, so a direct
    // construction cannot bypass the bounds an operator override would get.
    const config = resolveRoomConfig({
      sandboxActionIntervalMs: options.actionIntervalMs,
      sandboxSpawnIntervalMs: options.spawnIntervalMs,
      sandboxSlowSpawnIntervalMs: options.slowSpawnIntervalMs,
      sandboxFastSpawnLimit: options.fastSpawnLimit,
    });
    this.#authority = createSandboxAuthority(
      options.random === undefined ? {} : { random: options.random },
    );
    this.#throttle = new UpdateThrottle(config.sandboxActionIntervalMs);
    this.#spawnIntervalMs = config.sandboxSpawnIntervalMs;
    this.#slowSpawnIntervalMs = config.sandboxSlowSpawnIntervalMs;
    this.#fastSpawnLimit = config.sandboxFastSpawnLimit;
    this.#onBurst = options.onBurst;
    // The authority starts empty, so the mirror must too.
    if (this.#mirror.size > 0) this.#mirror.clear();
  }

  /** Placed plus carried blocks. */
  get totalBlocks(): number {
    return this.#authority.totalBlocks;
  }

  /** The authority's frozen column list. Never contains an empty column. */
  columns(): readonly SandboxColumn[] {
    return this.#authority.columns();
  }

  carrying(key: string): number | null {
    return this.#authority.carrying(key);
  }

  /**
   * Apply one untrusted pick or place request from `actor`.
   *
   * The order matters: an unreadable payload is refused before it can
   * consume the floor, and the floor is consumed before the rules run, so a
   * well-formed request the rules refuse still costs its sender a full
   * interval. Nothing is ever sent back — the caller learns the outcome, the
   * client only sees the state.
   */
  act(
    action: SandboxAction,
    actor: SandboxPlayer,
    request: unknown,
    others: readonly SandboxPlayer[],
    now: number,
  ): SandboxActionOutcome {
    const tile = normalizeSandboxTile(request);
    if (tile === null) return 'malformed';
    if (!this.#throttle.accept(actor.key, now)) return 'throttled';
    if (action === 'pick') {
      if (!this.#authority.pick(actor, tile, others)) return 'rejected';
      this.#copy(tile);
      return 'applied';
    }
    const landing = this.#authority.place(actor, tile, others);
    if (landing === null) return 'rejected';
    this.#settle(landing);
    return 'applied';
  }

  /**
   * Drop one block from the sky, away from `players`. The tile it landed on,
   * or null when none may fall or it burst the sandbox instead (reported
   * through `onBurst`).
   */
  spawn(players: readonly SandboxPlayer[]): SandboxTile | null {
    return this.#settle(this.#authority.spawn(players));
  }

  /**
   * Put back what `key` carries: a sky drop onto a random allowed tile away
   * from `players` (which must include the carrier's last position). Returns
   * the tile, or null when nothing fell or it burst the sandbox (reported
   * through `onBurst`). Used on suspend: the action floor is kept, so a
   * suspend/resume cycle cannot reset it.
   */
  returnCarried(key: string, players: readonly SandboxPlayer[]): SandboxTile | null {
    return this.#settle(this.#authority.returnCarried(key, players));
  }

  /** Put back what `key` carries, as `returnCarried`, and forget its floor. Used on leave. */
  forget(key: string, players: readonly SandboxPlayer[]): SandboxTile | null {
    const tile = this.returnCarried(key, players);
    this.#throttle.forget(key);
    return tile;
  }

  /** How long the spawner should wait before the next drop. */
  nextSpawnDelayMs(): number {
    return this.#authority.totalBlocks < this.#fastSpawnLimit
      ? this.#spawnIntervalMs
      : this.#slowSpawnIntervalMs;
  }

  /**
   * Mirror a block that joined a column, and return the tile it landed on. A
   * burst empties the authority, so every mirrored column goes, one delete
   * per entry (a path the decoder handles alongside a re-create in the same
   * patch), before the burst is reported; it then returns null.
   */
  #settle(landing: SandboxLanding | null): SandboxTile | null {
    if (landing === null) return null;
    if (!isSandboxBurst(landing)) {
      this.#copy(landing);
      return landing;
    }
    for (const key of [...this.#mirror.keys()]) this.#mirror.delete(key);
    this.#onBurst?.(landing.burst);
    return null;
  }

  /**
   * Make the mirror's column at `tile` equal the authority's.
   *
   * Only ever pops and pushes: stacks change at the top, so keeping the
   * longest common prefix and rewriting the rest is both minimal on the wire
   * and correct for any divergence.
   */
  #copy(tile: SandboxTile): void {
    const key = sandboxTileKey(tile.x, tile.y);
    const colours = findColumn(this.#authority.columns(), tile)?.colours ?? [];
    let entry = this.#mirror.get(key);
    if (colours.length === 0) {
      if (entry !== undefined) this.#mirror.delete(key);
      return;
    }
    if (entry === undefined) {
      entry = new SandboxColumnEntry();
      entry.x = tile.x;
      entry.y = tile.y;
      this.#mirror.set(key, entry);
    }
    const mirrored = entry.colours;
    let common = 0;
    while (
      common < mirrored.length &&
      common < colours.length &&
      mirrored.at(common) === colours[common]
    ) {
      common += 1;
    }
    while (mirrored.length > common) mirrored.pop();
    for (let index = common; index < colours.length; index += 1) {
      mirrored.push(colours[index] as number);
    }
  }
}

function findColumn(
  columns: readonly SandboxColumn[],
  tile: SandboxTile,
): SandboxColumn | undefined {
  for (const column of columns) {
    if (column.x === tile.x && column.y === tile.y) return column;
  }
  return undefined;
}
