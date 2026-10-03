import {
  ARENA_ATTACK_CLIENT_INTERVAL_MS,
  ARENA_BLOCK_CLIENT_INTERVAL_MS,
  ARENA_BOX,
  ARENA_BOX_APPROACH,
  ARENA_DUMMY_TILE,
  ARENA_GATE_APPROACH,
  ARENA_HIT_MIN_COS,
  ARENA_INTENT_CLIENT_INTERVAL_MS,
  ARENA_MAX_HP,
  ARENA_ORIGIN_PX,
  ARENA_POINT_BLANK_PX,
  ARENA_REACH_PX,
  ARENA_RING_GATE,
  ARENA_RING_RETURN,
  ARENA_RING_RETURN_FACING,
  ARENA_RING_SPAWN,
  ARENA_RING_SPAWN_FACING,
  ARENA_RING_WALKABLE,
  ARENA_TILE_SIZE,
  arenaTileCentre,
  normalizeArenaRing,
  type ArenaRingSnapshot,
  type Facing,
  type GameId,
  type TileRect,
} from '@strkworld/shared';
import type { ArenaChannel, ArenaGateTarget, ArenaSession, ArenaSessionHost, ArenaViewFrame } from './arena-channel.js';
import { JUMP_TOTAL_MS } from './jump.js';

/**
 * D-114: the arena's combat session (stream C).
 *
 * The World's side of the ring. It reads the ring only from the channel the
 * Shell supplies, and only ever sends the three intents: claim, attack and
 * leave. It never decides a hit, a damage figure or a winner; what it draws
 * (the frame) is the server's counters, and the local swing is a cosmetic
 * prediction the server's swing counter later confirms.
 *
 * - **The gate.** On the gate approach the prompt reads `E · CLAIM` while
 *   the ring is idle and `IN USE` while it is not. E claims. With the press-E
 *   system (D-117) the gate is a station (`gateTargets`) and the system draws
 *   the prompt; without it the session draws it through `setPrompt`.
 * - **In and out.** A new round whose challenger is this client leaps the
 *   player to the ring spawn; the ring going back to idle (or away) after
 *   this client's round leaps it out to the return tile. The fighting look
 *   is put on after landing and the old one restored after the way out;
 *   F (the outfit toggle) is locked in between.
 * - **Attacks.** E, a primary click or the HUD's STRIKE, only while fighting,
 *   held to the 450 ms client floor. The server holds its own 400 ms floor.
 * - **The swing echo.** The server's swing counter plays this client's swing
 *   unless it predicted one within the last 400 ms.
 * - **The block (D-128).** Q held, or the HUD's BLOCK, while this client is
 *   fighting: `onBlock(true)` sends a start on the 500 ms client floor and
 *   `onBlock(false)` the release. Nothing is predicted — the stance the view
 *   draws is the server's `guarding` — and the release is sent whenever one
 *   is owed, including on the way out of the ring and on destroy, so a guard
 *   can never stick.
 * - **The emperor's box (D-128).** At the box, the box is the press-E target
 *   instead of the gate: the champion takes or leaves the throne, and
 *   everyone else reads the CHAMPION ONLY notice, which sends nothing.
 */

/** The World's arena prompts: game copy, never a disclosure. */
export const ARENA_CLAIM_PROMPT = 'E · CLAIM';
export const ARENA_BUSY_PROMPT = 'IN USE';
export const ARENA_STRIKE_PROMPT = 'E · STRIKE';
/** The gate's labels as a press-E target (D-117): the system draws "E · CLAIM". */
export const ARENA_GATE_TARGET_ID = 'arena:gate';
export const ARENA_CLAIM_LABEL = 'CLAIM';
export const ARENA_BUSY_LABEL = 'IN USE';

/**
 * D-128: the emperor's box as a press-E target. The id is the room's own
 * station id, so the box keeps the affordance shell the arena room recorded
 * for it (D-123's shimmer, and the edge glow when E would use it).
 */
export const ARENA_BOX_TARGET_ID = 'arena:box';
/** What the champion reads at the box, sitting down and standing up. */
export const ARENA_SIT_LABEL = 'TAKE THE THRONE';
export const ARENA_STAND_LABEL = 'LEAVE THE THRONE';
/** What everyone else reads there. E takes the press and does nothing. */
export const ARENA_BOX_CLOSED_LABEL = "EMPEROR'S BOX — CHAMPION ONLY";

/** The gate's footprint in World pixels (room origin included): what a press-E prompt measures to. */
export const ARENA_GATE_RECT = Object.freeze({
  x: ARENA_ORIGIN_PX + ARENA_RING_GATE.x * ARENA_TILE_SIZE,
  y: ARENA_ORIGIN_PX + ARENA_RING_GATE.y * ARENA_TILE_SIZE,
  width: ARENA_RING_GATE.width * ARENA_TILE_SIZE,
  height: ARENA_RING_GATE.height * ARENA_TILE_SIZE,
});

/** D-128: the box's footprint in World pixels, what the box prompt measures to. */
export const ARENA_BOX_RECT = Object.freeze({
  x: ARENA_ORIGIN_PX + ARENA_BOX.x * ARENA_TILE_SIZE,
  y: ARENA_ORIGIN_PX + ARENA_BOX.y * ARENA_TILE_SIZE,
  width: ARENA_TILE_SIZE,
  height: ARENA_TILE_SIZE,
});

/** A predicted swing within this long of the server's counter is the same swing. */
export const ARENA_SWING_ECHO_MS = 400;

/** The lobby's slack round the gate approach, World px. */
const GATE_SLACK_PX = 8;

export interface ArenaSessionOptions {
  /** The clock, ms. `performance.now` by default. */
  readonly now?: () => number;
}

const UNIT: Readonly<Record<Facing, readonly [number, number]>> = Object.freeze({
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
});

function inRect(rect: TileRect, x: number, y: number): boolean {
  return x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height;
}

/** Whether a World pixel point (room origin included) is on the gate approach, with the lobby's slack. */
export function onArenaGateApproach(x: number, y: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const left = ARENA_ORIGIN_PX + ARENA_GATE_APPROACH.x * ARENA_TILE_SIZE - GATE_SLACK_PX;
  const top = ARENA_ORIGIN_PX + ARENA_GATE_APPROACH.y * ARENA_TILE_SIZE - GATE_SLACK_PX;
  const right = ARENA_ORIGIN_PX + (ARENA_GATE_APPROACH.x + ARENA_GATE_APPROACH.width) * ARENA_TILE_SIZE + GATE_SLACK_PX;
  const bottom = ARENA_ORIGIN_PX + (ARENA_GATE_APPROACH.y + ARENA_GATE_APPROACH.height) * ARENA_TILE_SIZE + GATE_SLACK_PX;
  return x >= left && x < right && y >= top && y < bottom;
}

/**
 * D-128: whether a World pixel point is at the emperor's box — the sand in
 * front of it, or the box's own tile, where the champion sits. The lobby's
 * own rule, with the same slack (`isAtArenaBox`).
 */
export function atArenaBox(x: number, y: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  const left = ARENA_ORIGIN_PX + ARENA_BOX_APPROACH.x * ARENA_TILE_SIZE - GATE_SLACK_PX;
  const right = ARENA_ORIGIN_PX + (ARENA_BOX_APPROACH.x + ARENA_BOX_APPROACH.width) * ARENA_TILE_SIZE + GATE_SLACK_PX;
  const top = ARENA_ORIGIN_PX + ARENA_BOX_APPROACH.y * ARENA_TILE_SIZE - GATE_SLACK_PX;
  const bottom = ARENA_ORIGIN_PX + (ARENA_BOX_APPROACH.y + ARENA_BOX_APPROACH.height) * ARENA_TILE_SIZE + GATE_SLACK_PX;
  if (x >= left && x < right && y >= top && y < bottom) return true;
  const seat = arenaTileCentre(ARENA_BOX);
  return Math.abs(x - seat.x) <= ARENA_TILE_SIZE / 2 + GATE_SLACK_PX && Math.abs(y - seat.y) <= ARENA_TILE_SIZE / 2 + GATE_SLACK_PX;
}

/**
 * Whether a swing from here would reach the dummy, by the lobby's own rule
 * (reach, arc, point-blank). Used only to show `E · STRIKE`: the lobby
 * decides every hit from its own held position.
 */
export function dummyWithinReach(x: number, y: number, facing: Facing): boolean {
  const target = arenaTileCentre(ARENA_DUMMY_TILE);
  const dx = target.x - x;
  const dy = target.y - y;
  const d = Math.hypot(dx, dy);
  if (!Number.isFinite(d) || d > ARENA_REACH_PX) return false;
  if (d <= ARENA_POINT_BLANK_PX) return true;
  const [fx, fy] = UNIT[facing] ?? UNIT.down;
  return (dx * fx + dy * fy) / d >= ARENA_HIT_MIN_COS;
}

/** The ring's frame for the view: the server's counters, nothing guessed. */
export function arenaViewFrame(ring: ArenaRingSnapshot, self: GameId | null): ArenaViewFrame {
  const challenger = ring.challenger;
  const challengerId = challenger.kind === 'player' ? challenger.gameId : null;
  const opponent = ring.opponent;
  const championId = ring.champion;
  const throneId = ring.seated ? championId : null;
  return Object.freeze({
    phase: ring.phase,
    gate: ring.phase === 'idle' ? 'open' : 'busy',
    dummy: opponent.kind === 'dummy'
      ? Object.freeze({ hp: opponent.hp, maxHp: ARENA_MAX_HP, hits: opponent.hits, down: opponent.hp === 0 && ring.phase === 'ended' })
      : null,
    challengerId,
    challengerSwings: challenger.swings,
    selfIsChallenger: ring.phase !== 'idle' && self !== null && challengerId === self,
    // D-128: the server's own guard, so spectators and the fighter draw the
    // same stance, and the blocked-hit counter the fx sparks from.
    challengerGuarding: challenger.guarding,
    challengerBlocks: challenger.blocks,
    championId,
    throneId,
    selfIsChampion: self !== null && championId === self,
    selfOnThrone: self !== null && throneId === self,
  });
}

type LookStep = { readonly mode: 'fighting' | 'restore'; at: number } | null;

export function createArenaSession(
  channel: ArenaChannel,
  host: ArenaSessionHost,
  options: ArenaSessionOptions = {},
): ArenaSession {
  const now = options.now ?? (() => globalThis.performance.now());
  let destroyed = false;
  let ring: ArenaRingSnapshot | null = null;
  let frame: ArenaViewFrame | null = null;
  /** The round this client is fighting (leapt in for), or null. */
  let fighting: number | null = null;
  /** The swing counter last seen in this client's round. */
  let swings = 0;
  let lastAttackAt = Number.NEGATIVE_INFINITY;
  let lastIntentAt = Number.NEGATIVE_INFINITY;
  /** D-128: when the last block start went, and whether a release is owed. */
  let lastBlockAt = Number.NEGATIVE_INFINITY;
  let blockSent = false;
  /**
   * D-128, amended 2026-10-03: whether the server has this client on the
   * throne, as the host was last told, and whether a stand-up is owed because
   * the intent floor refused the last one.
   */
  let onThrone = false;
  let standWanted = false;
  let predictedAt = Number.NEGATIVE_INFINITY;
  let prompt: string | null = null;
  let look: LookStep = null;
  /** Whether the fighting look is on (so destroy and the way out restore it). */
  let lookSwitched = false;
  let outfitLocked = false;
  /** The press-E combat yield held while this client fights. */
  let releaseInteractions: (() => void) | null = null;
  /** With the press-E system the gate's prompt is a station's, not ours. */
  const gateByInteractions = typeof host.suspendInteractions === 'function';

  const safely = (action: () => void): void => {
    try {
      action();
    } catch {
      // A failing host call must not strand the ring state machine.
    }
  };

  const selfId = (): GameId | null => {
    try {
      return channel.selfId();
    } catch {
      return null;
    }
  };

  const setPrompt = (text: string | null): void => {
    if (text === prompt) return;
    prompt = text;
    safely(() => host.setPrompt(text));
  };

  const landingDelay = (): number => {
    let reduced = false;
    try {
      reduced = host.reducedMotion();
    } catch {
      reduced = false;
    }
    // Under reduced motion the leap is a cut, so the player has already landed.
    return reduced ? 0 : JUMP_TOTAL_MS;
  };

  const lockOutfit = (locked: boolean): void => {
    if (outfitLocked === locked) return;
    outfitLocked = locked;
    safely(() => host.setOutfitLocked(locked));
  };

  const applyLook = (mode: 'fighting' | 'restore'): void => {
    if (mode === 'fighting' ? lookSwitched : !lookSwitched) return;
    lookSwitched = mode === 'fighting';
    safely(() => host.selectLook(mode));
  };

  const holdCombat = (hold: boolean): void => {
    if (hold) {
      if (releaseInteractions !== null) return;
      try {
        releaseInteractions = host.suspendInteractions?.('combat') ?? null;
      } catch {
        releaseInteractions = null;
      }
      return;
    }
    const release = releaseInteractions;
    releaseInteractions = null;
    if (release) safely(release);
  };

  const enterRing = (round: number, startSwings: number): void => {
    fighting = round;
    swings = startSwings;
    holdCombat(true);
    lockOutfit(true);
    safely(() => host.leapTo(ARENA_RING_SPAWN, ARENA_RING_SPAWN_FACING));
    look = { mode: 'fighting', at: now() + landingDelay() };
  };

  const leaveRing = (leap: boolean): void => {
    fighting = null;
    // D-128: the fight is over, so no guard is held into the next one.
    setBlock(false);
    holdCombat(false);
    if (leap) safely(() => host.leapTo(ARENA_RING_RETURN, ARENA_RING_RETURN_FACING));
    lockOutfit(false);
    if (lookSwitched) look = { mode: 'restore', at: now() + (leap ? landingDelay() : 0) };
    else look = null;
  };

  const selfIsChallenger = (): boolean => frame?.selfIsChallenger === true;

  /**
   * D-128, amended 2026-10-03: the throne follows the server's `seated`, never
   * a press. The host seats the avatar on the box's own tile when it goes up
   * and puts it back on `ARENA_BOX_STAND` when it comes down — including when
   * the server takes the seat away (a new champion, a claim, a drop), so the
   * fighter is never left standing on a throne they no longer hold.
   */
  const syncThrone = (): void => {
    const seated = frame?.selfOnThrone === true;
    if (seated === onThrone) return;
    onThrone = seated;
    if (seated) standWanted = false;
    safely(() => host.setThroned?.(seated));
  };

  const apply = (value: unknown): void => {
    if (destroyed) return;
    let next: ArenaRingSnapshot | null = null;
    try {
      next = normalizeArenaRing(value);
    } catch {
      next = null;
    }
    ring = next;
    frame = next === null ? null : arenaViewFrame(next, selfId());
    syncThrone();
    if (next !== null && frame?.selfIsChallenger) {
      if (fighting !== next.round) {
        // A new round as challenger: whatever came before is over.
        if (fighting !== null) leaveRing(false);
        enterRing(next.round, next.challenger.swings);
        return;
      }
      if (next.challenger.swings !== swings) {
        swings = next.challenger.swings;
        const t = now();
        if (t - predictedAt <= ARENA_SWING_ECHO_MS) predictedAt = Number.NEGATIVE_INFINITY;
        else safely(() => host.playLocalSwing());
      }
      return;
    }
    // Not (or no longer) the challenger: out of the ring if this client was in it.
    if (fighting !== null) leaveRing(true);
  };

  const position = (): { x: number; y: number; facing: Facing } | null => {
    try {
      const at = host.position();
      if (!at || !Number.isFinite(at.x) || !Number.isFinite(at.y)) return null;
      return { x: at.x, y: at.y, facing: at.facing };
    } catch {
      return null;
    }
  };

  const inputSuspended = (): boolean => {
    try {
      return host.inputSuspended?.() === true;
    } catch {
      return true;
    }
  };

  const currentPrompt = (): string | null => {
    if (ring === null) return null;
    const at = position();
    if (at === null) return null;
    if (selfIsChallenger()) {
      return ring.phase === 'fighting' && dummyWithinReach(at.x, at.y, at.facing) ? ARENA_STRIKE_PROMPT : null;
    }
    if (gateByInteractions || !onArenaGateApproach(at.x, at.y)) return null;
    return ring.phase === 'idle' ? ARENA_CLAIM_PROMPT : ARENA_BUSY_PROMPT;
  };

  const claimTarget: ArenaGateTarget = Object.freeze({
    id: ARENA_GATE_TARGET_ID,
    label: ARENA_CLAIM_LABEL,
    rect: ARENA_GATE_RECT,
    activate: () => {
      if (destroyed || ring === null || ring.phase !== 'idle' || inputSuspended()) return false;
      return intent(() => channel.claim());
    },
  });
  // IN USE takes the press and does nothing: nothing is sent while the ring is busy.
  const busyTarget: ArenaGateTarget = Object.freeze({
    id: ARENA_GATE_TARGET_ID,
    label: ARENA_BUSY_LABEL,
    rect: ARENA_GATE_RECT,
    activate: () => false,
  });
  /**
   * D-128: the emperor's box. The champion sits or stands; everyone else gets
   * the CHAMPION ONLY notice, which takes the press and sends nothing.
   */
  const boxTarget = (label: string, use: 'sit' | 'stand' | false): ArenaGateTarget => Object.freeze({
    id: ARENA_BOX_TARGET_ID,
    label,
    rect: ARENA_BOX_RECT,
    activate: () => {
      if (!use || destroyed || ring === null || inputSuspended()) return false;
      if (typeof channel.sit !== 'function') return false;
      // Standing up is kept and re-sent if the floor refuses it; sitting down
      // is a plain intent, because the player is still standing either way.
      if (use === 'stand') return requestStand() || true;
      return intent(() => channel.sit?.());
    },
  });
  const SIT_TARGETS: readonly ArenaGateTarget[] = Object.freeze([boxTarget(ARENA_SIT_LABEL, 'sit')]);
  const STAND_TARGETS: readonly ArenaGateTarget[] = Object.freeze([boxTarget(ARENA_STAND_LABEL, 'stand')]);
  const CLOSED_BOX_TARGETS: readonly ArenaGateTarget[] = Object.freeze([boxTarget(ARENA_BOX_CLOSED_LABEL, false)]);

  const NO_TARGETS: readonly ArenaGateTarget[] = Object.freeze([]);
  const gateObject = (): unknown => {
    try {
      return host.gateObject?.() ?? null;
    } catch {
      return null;
    }
  };
  const CLAIM_TARGETS: readonly ArenaGateTarget[] = Object.freeze([claimTarget]);
  const BUSY_TARGETS: readonly ArenaGateTarget[] = Object.freeze([busyTarget]);

  const attack = (): boolean => {
    const t = now();
    // The client floor: a fast repeat is dropped, never queued.
    if (t - lastAttackAt < ARENA_ATTACK_CLIENT_INTERVAL_MS) return true;
    lastAttackAt = t;
    predictedAt = t;
    safely(() => host.playLocalSwing());
    safely(() => channel.attack());
    return true;
  };

  /**
   * D-128: Q down and up. Only while this client is fighting — never in a
   * countdown, never a spectator — and the start is held to the client
   * floor. A release always goes if a start went, so the guard cannot stick.
   */
  const setBlock = (down: boolean): boolean => {
    if (typeof channel.block !== 'function') return false;
    if (!down) {
      // The release is never gated on anything: it goes whenever this client
      // believes it raised a guard, destroyed session or not.
      if (!blockSent) return false;
      blockSent = false;
      safely(() => channel.block?.(false));
      return true;
    }
    if (destroyed || ring === null || inputSuspended()) return false;
    if (!selfIsChallenger() || ring.phase !== 'fighting') return false;
    if (blockSent) return true;
    const t = now();
    if (t - lastBlockAt < ARENA_BLOCK_CLIENT_INTERVAL_MS) return true;
    lastBlockAt = t;
    blockSent = true;
    safely(() => channel.block?.(true));
    return true;
  };

  const intent = (send: () => void): boolean => {
    sendIntent(send);
    // The press is always taken: a refusal inside the floor is silent, as
    // everywhere else here.
    return true;
  };

  /** Send one intent if the client floor allows it. Returns whether it went. */
  const sendIntent = (send: () => void): boolean => {
    const t = now();
    if (t - lastIntentAt < ARENA_INTENT_CLIENT_INTERVAL_MS) return false;
    lastIntentAt = t;
    safely(send);
    return true;
  };

  /**
   * D-128, amended 2026-10-03: ask to come off the throne. The intent floor is
   * shared with claim, so a stand-up straight after sitting down can be
   * refused; it is kept and re-sent from `update` rather than dropped, because
   * a player who has asked to get up must not have to guess when to ask again.
   */
  const requestStand = (): boolean => {
    if (destroyed || ring === null) return false;
    if (frame?.selfOnThrone !== true || typeof channel.sit !== 'function') return false;
    standWanted = true;
    if (sendIntent(() => channel.sit?.())) standWanted = false;
    return true;
  };

  /** The one attack path: E (`onAttack`), a click (`onPrimary`) and the HUD STRIKE all land here. */
  const primary = (): boolean => {
    if (destroyed || ring === null || inputSuspended()) return false;
    if (!selfIsChallenger() || ring.phase !== 'fighting') return false;
    return attack();
  };

  let unsubscribe: (() => void) | null = null;
  let unsubscribeStrikes: (() => void) | null = null;
  let unsubscribeBlocks: (() => void) | null = null;
  try {
    unsubscribe = channel.subscribe((value) => apply(value));
  } catch {
    unsubscribe = null;
  }
  try {
    // The HUD's STRIKE takes the same path as a click.
    unsubscribeStrikes = channel.subscribeStrikes?.(() => void primary()) ?? null;
  } catch {
    unsubscribeStrikes = null;
  }
  try {
    // D-128: the HUD's touch BLOCK takes the same path as Q.
    unsubscribeBlocks = channel.subscribeBlocks?.((down) => void setBlock(down === true)) ?? null;
  } catch {
    unsubscribeBlocks = null;
  }
  // `subscribe` may or may not replay; read the current ring either way.
  try {
    if (ring === null) apply(channel.ring());
  } catch {
    apply(null);
  }

  return Object.freeze({
    update(_deltaMs: number): void {
      if (destroyed) return;
      // D-128, amended: a stand-up the floor refused goes as soon as it may.
      if (standWanted) {
        if (frame?.selfOnThrone !== true) standWanted = false;
        else if (sendIntent(() => channel.sit?.())) standWanted = false;
      }
      if (look !== null && now() >= look.at) {
        const step = look;
        look = null;
        applyLook(step.mode);
      }
      setPrompt(currentPrompt());
    },
    isRingTileWalkable(tileX: number, tileY: number): boolean {
      if (destroyed || !selfIsChallenger()) return false;
      return ARENA_RING_WALKABLE.some((rect) => inRect(rect, tileX, tileY));
    },
    onInteract(): boolean {
      if (destroyed || ring === null || inputSuspended()) return false;
      if (selfIsChallenger()) {
        // In the ring E is the attack key, and only while fighting.
        return ring.phase === 'fighting' ? attack() : false;
      }
      const at = position();
      if (at === null || !onArenaGateApproach(at.x, at.y)) return false;
      if (ring.phase !== 'idle') return false;
      return intent(() => channel.claim());
    },
    onPrimary(): boolean {
      return primary();
    },
    gateTargets(): readonly ArenaGateTarget[] {
      if (destroyed || ring === null || selfIsChallenger()) return NO_TARGETS;
      const at = position();
      if (at === null) return NO_TARGETS;
      // D-128: at the emperor's box, the box is what E would use.
      if (atArenaBox(at.x, at.y)) {
        if (typeof channel.sit !== 'function' || frame?.selfIsChampion !== true) return CLOSED_BOX_TARGETS;
        return frame.selfOnThrone ? STAND_TARGETS : SIT_TARGETS;
      }
      if (!onArenaGateApproach(at.x, at.y)) return NO_TARGETS;
      const targets = ring.phase === 'idle' ? CLAIM_TARGETS : BUSY_TARGETS;
      const object = gateObject();
      // With the gate's mesh, the cues glow it; the target is otherwise the same.
      return object == null ? targets : [{ ...targets[0]!, object }];
    },
    onAttack(): boolean {
      // E, a click and STRIKE are one path: one floor, one local swing, one send.
      return primary();
    },
    onBlock(down: boolean): boolean {
      return setBlock(down === true);
    },
    leaveThrone(): boolean {
      return requestStand();
    },
    onThrone(): boolean {
      return !destroyed && frame?.selfOnThrone === true;
    },
    frame(): ArenaViewFrame | null {
      return destroyed ? null : frame;
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      // A guard this client raised comes down before anything else: the
      // session is going away, and the server must not hold it up for ever.
      setBlock(false);
      // D-128, amended: and the World stops holding the avatar on the throne,
      // so a torn-down session never leaves it frozen on the podium.
      standWanted = false;
      if (onThrone) {
        onThrone = false;
        safely(() => host.setThroned?.(false));
      }
      safely(() => unsubscribe?.());
      safely(() => unsubscribeStrikes?.());
      safely(() => unsubscribeBlocks?.());
      unsubscribe = null;
      unsubscribeStrikes = null;
      unsubscribeBlocks = null;
      setPrompt(null);
      holdCombat(false);
      lockOutfit(false);
      if (lookSwitched) applyLook('restore');
      look = null;
      ring = null;
      frame = null;
    },
  });
}
