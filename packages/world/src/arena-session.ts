import {
  ARENA_ATTACK_CLIENT_INTERVAL_MS,
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
 */

/** The World's arena prompts: game copy, never a disclosure. */
export const ARENA_CLAIM_PROMPT = 'E · CLAIM';
export const ARENA_BUSY_PROMPT = 'IN USE';
export const ARENA_STRIKE_PROMPT = 'E · STRIKE';
/** The gate's labels as a press-E target (D-117): the system draws "E · CLAIM". */
export const ARENA_GATE_TARGET_ID = 'arena:gate';
export const ARENA_CLAIM_LABEL = 'CLAIM';
export const ARENA_BUSY_LABEL = 'IN USE';

/** The gate's footprint in World pixels (room origin included): what a press-E prompt measures to. */
export const ARENA_GATE_RECT = Object.freeze({
  x: ARENA_ORIGIN_PX + ARENA_RING_GATE.x * ARENA_TILE_SIZE,
  y: ARENA_ORIGIN_PX + ARENA_RING_GATE.y * ARENA_TILE_SIZE,
  width: ARENA_RING_GATE.width * ARENA_TILE_SIZE,
  height: ARENA_RING_GATE.height * ARENA_TILE_SIZE,
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
  return Object.freeze({
    phase: ring.phase,
    gate: ring.phase === 'idle' ? 'open' : 'busy',
    dummy: opponent.kind === 'dummy'
      ? Object.freeze({ hp: opponent.hp, maxHp: ARENA_MAX_HP, hits: opponent.hits, down: opponent.hp === 0 && ring.phase === 'ended' })
      : null,
    challengerId,
    challengerSwings: challenger.swings,
    selfIsChallenger: ring.phase !== 'idle' && self !== null && challengerId === self,
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
    holdCombat(false);
    if (leap) safely(() => host.leapTo(ARENA_RING_RETURN, ARENA_RING_RETURN_FACING));
    lockOutfit(false);
    if (lookSwitched) look = { mode: 'restore', at: now() + (leap ? landingDelay() : 0) };
    else look = null;
  };

  const selfIsChallenger = (): boolean => frame?.selfIsChallenger === true;

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
  const NO_TARGETS: readonly ArenaGateTarget[] = Object.freeze([]);
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

  const intent = (send: () => void): boolean => {
    const t = now();
    if (t - lastIntentAt < ARENA_INTENT_CLIENT_INTERVAL_MS) return true;
    lastIntentAt = t;
    safely(send);
    return true;
  };

  const primary = (): boolean => {
    if (destroyed || ring === null || inputSuspended()) return false;
    if (!selfIsChallenger() || ring.phase !== 'fighting') return false;
    return attack();
  };

  let unsubscribe: (() => void) | null = null;
  let unsubscribeStrikes: (() => void) | null = null;
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
  // `subscribe` may or may not replay; read the current ring either way.
  try {
    if (ring === null) apply(channel.ring());
  } catch {
    apply(null);
  }

  return Object.freeze({
    update(_deltaMs: number): void {
      if (destroyed) return;
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
      if (at === null || !onArenaGateApproach(at.x, at.y)) return NO_TARGETS;
      return ring.phase === 'idle' ? CLAIM_TARGETS : BUSY_TARGETS;
    },
    onAttack(): boolean {
      if (destroyed || ring === null || inputSuspended()) return false;
      if (!selfIsChallenger() || ring.phase !== 'fighting') return false;
      return attack();
    },
    frame(): ArenaViewFrame | null {
      return destroyed ? null : frame;
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      safely(() => unsubscribe?.());
      safely(() => unsubscribeStrikes?.());
      unsubscribe = null;
      unsubscribeStrikes = null;
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
