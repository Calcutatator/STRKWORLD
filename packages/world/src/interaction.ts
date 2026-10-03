/**
 * Press E to use what you stand at: the World's one interaction system
 * (D-117).
 *
 * Every station that opens a window or shows a message goes through here:
 * the Privacy Plaza's monument and table, every fixed-room counter (Bank,
 * Vault and its Vesu counters, Exchange, Degen floor, Post Office, Bridge),
 * the Avatar Studio's figures and the bunker's out-of-order lift. Walking
 * near a station never opens it. The player stands within its range, roughly
 * facing it; E, or a tap on the key chip on a touch screen, uses it.
 *
 * What the player sees (D-123, amending D-117's floating "E · SHIELD" and the
 * lit approach tiles): every usable station shimmers faintly from across the
 * room; the one chosen here glows with a soft ember rim; and a quiet key chip
 * low on the screen reads "[E] SHIELD" (interact-chip.ts). The chip is the
 * tap button on a touch screen. All three follow `onPrompt`: nothing glows and
 * no chip shows while the system is blocked or suspended.
 *
 * Renderer-free and engine-free. A station plugs in as an
 * `InteractionSource`: each update it lists the targets the player is in
 * range of by its own rule (the ring of tiles round a counter, D-033's
 * approach), and the system picks one. A future station (the gladiator ring
 * gate, the leaderboard stand) registers a source the same way and gets the
 * glow, the chip (and its tap), the input-gate rules and the combat yield for
 * free. For the glow and the shimmer the 3D view must know the station's
 * meshes: see `InteractionTarget.object`.
 *
 * Doors are not stations. Walking into a building's door enters it, the
 * bunker's stair takes the player down and a pit entrance will drop them in:
 * those are transitions, and they stay walk-in.
 *
 * E has other uses that are not stations: picking up and placing a sandbox
 * block (D-060), kicking the ball (D-078), and an attack inside the
 * gladiator ring (planned). Those register as `InteractionAction`s. One E
 * press goes to the focused station first; only when no station is focused
 * do the actions get it, highest priority first, until one acts.
 *
 * The combat yield. "E is interact everywhere; inside an active ring fight,
 * where no stations are in range, E attacks." The ring has no station in
 * range of its floor, so registering the attack as an action already follows
 * that rule. When a fight must own E outright (say the ring gate's own
 * prompt stands within reach of the fighters), the arena calls
 * `suspend('combat')` for the fight and the returned release when it ends:
 * while any suspension holds, no station is focused, nothing glows, no chip
 * shows, and E goes straight to the actions.
 */

/** A World pixel point. */
export interface InteractionPoint {
  readonly x: number;
  readonly y: number;
}

/** A World pixel rectangle: a station's footprint. */
export interface InteractionRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** One thing E would use. */
export interface InteractionTarget {
  /** Unique among the targets offered at once: a station id, a figure. */
  readonly id: string;
  /** The chip's words after its "E" key, e.g. "SHIELD". One line. */
  readonly label: string;
  /** The footprint, World pixels. Distance and facing are measured to its nearest point. */
  readonly rect: InteractionRect;
  /**
   * D-123: the station's 3D object (a three.js `Object3D` in the World's
   * renderer), so the view can light its edges while it is the target. The
   * system never reads it; it passes it to the view on the prompt.
   *
   * Optional, because the 3D view already knows the stock stations by `id`:
   * room counters and the bunker's lift (their station id), the plaza's
   * monument and table (their station id) and the Studio's figures
   * (`studioFigureTargetId`). A new station (the gladiator ring gate, the
   * leaderboard stand) gets its cues in one of three ways:
   *  - built into merged meshes by a builder: record its pieces into that
   *    builder's `AffordanceShells` under this target's `id` (as the plaza
   *    does), and it shimmers from afar and glows when chosen;
   *  - built as its own object: `presenter.registerAffordance(id, object)`
   *    when it is built, with the same result;
   *  - or simply set `object` here: it glows when chosen, and shimmers from
   *    then on.
   */
  readonly object?: object;
  /**
   * D-127: what the 3D view shows for this target besides the chip.
   *
   * `'shell'` (the default, and what every station has) is D-123's pair of
   * cues: the thing shimmers while it is usable and takes an ember edge glow
   * while it is the target.
   *
   * `'none'` says the opposite out loud: **no shimmer and no edge glow, only
   * the key chip**. The benches use it (the lead asked for "no shimmer or
   * close highlight, only the popup 'E' 'sit'"). It is a declaration, not an
   * omission: leaving `object` off and registering no shell would look the
   * same today and go quietly wrong the day someone adds a shell for the same
   * id. A `'none'` target must therefore carry no `object` — the view ignores
   * one if it does — and no `AffordanceShells` entry should exist under its
   * id.
   */
  readonly cue?: 'shell' | 'none';
  /**
   * Use it. Synchronous: a Shell handoff happens inside, and its error is
   * the caller's. What it returns is ignored: a focused target always takes
   * the press, so E never falls through to an action behind a prompt.
   */
  activate(): unknown;
}

/** A station kind: lists the targets the player is in range of right now. */
export interface InteractionSource {
  targets(): readonly InteractionTarget[];
}

/** A non-station use of E: the sandbox, the kick, a ring attack. */
export interface InteractionAction {
  readonly id: string;
  /** Higher runs first; 0 by default. Every station comes before every action. */
  readonly priority?: number;
  /** Act on E, returning true when it did, so no lower action runs. */
  run(): boolean;
}

/** What to show for the focused target: its glow, and the chip's words. */
export interface InteractionPrompt {
  readonly id: string;
  readonly label: string;
  /** World pixels: the target's centre. */
  readonly x: number;
  readonly y: number;
  /** The target's 3D object, when it named one (`InteractionTarget.object`). */
  readonly object?: object;
  /**
   * D-127: `'none'` when the target asked for the chip alone — no shimmer and
   * no edge glow. Absent means D-123's usual shell cues.
   */
  readonly cue?: 'none';
}

export interface InteractionPlayer {
  readonly position: InteractionPoint;
  /**
   * The World-space direction the player last moved in. Any length; (0, 0)
   * means not known yet, and faces everything.
   */
  readonly heading: InteractionPoint;
}

export interface InteractionSystem {
  /** The prompt showing now, or none. */
  readonly focused: InteractionPrompt | null;
  /** True while a `suspend` holds: no station is focused. */
  readonly suspended: boolean;
  /** Add a station kind. Returns its removal. */
  register(source: InteractionSource): () => void;
  /** Add a non-station use of E. Returns its removal. */
  addAction(action: InteractionAction): () => void;
  /**
   * The combat yield: while any suspension holds, no station is focused or
   * prompted and E goes to the actions. Returns the release; releasing twice
   * is harmless. `reason` names the holder for debugging ("combat").
   */
  suspend(reason: string): () => void;
  /** Re-pick the focused target for the player where they stand now. */
  update(player: InteractionPlayer): void;
  /**
   * E, or the touch button: use the focused target, or else offer the press
   * to the actions. Returns whether anything took it.
   */
  interact(): boolean;
  /** Drop the focus and its prompt, until the next update (a teleport). */
  clear(): void;
  destroy(): void;
}

export interface InteractionSystemOptions {
  /** The focused target changed: glow it and show its chip, or show none. */
  readonly onPrompt?: (prompt: InteractionPrompt | null) => void;
  /**
   * True while the World does not own the keyboard (a panel, Menu Mode, a
   * Shell claim): no prompt shows and E does nothing at all.
   */
  readonly blocked?: () => boolean;
}

/**
 * "Roughly facing": a target whose nearest point lies more than about 105°
 * from the heading is behind the player, and is not offered.
 */
export const INTERACTION_FACING_MIN_DOT = -0.25;
/** Within about 45° of the heading: a faced target, which beats one beside or behind. */
export const INTERACTION_FACED_DOT = Math.SQRT1_2;

/** The point of `rect` nearest to `point`: the point itself when inside it. */
export function nearestPointOf(rect: InteractionRect, point: InteractionPoint): InteractionPoint {
  return {
    x: Math.min(Math.max(point.x, rect.x), rect.x + rect.width),
    y: Math.min(Math.max(point.y, rect.y), rect.y + rect.height),
  };
}

/** Cosine of the angle between the heading and the way to the target's nearest point; 1 on top of it. */
export function facingDot(rect: InteractionRect, player: InteractionPlayer): number {
  const near = nearestPointOf(rect, player.position);
  const dx = near.x - player.position.x;
  const dy = near.y - player.position.y;
  const along = Math.hypot(dx, dy);
  const heading = Math.hypot(player.heading.x, player.heading.y);
  if (!(along > 1e-6) || !(heading > 1e-6)) return 1;
  return (dx * player.heading.x + dy * player.heading.y) / (along * heading);
}

/**
 * The target E would use: among those the player roughly faces, a faced one
 * before any other, then the nearest, then the first offered.
 */
export function chooseInteractionTarget(
  targets: readonly InteractionTarget[],
  player: InteractionPlayer,
): InteractionTarget | null {
  let best: { target: InteractionTarget; faced: boolean; distance: number } | null = null;
  for (const target of targets) {
    if (!validTarget(target)) continue;
    const dot = facingDot(target.rect, player);
    if (dot < INTERACTION_FACING_MIN_DOT) continue;
    const near = nearestPointOf(target.rect, player.position);
    const distance = Math.hypot(near.x - player.position.x, near.y - player.position.y);
    const faced = dot >= INTERACTION_FACED_DOT;
    if (
      !best ||
      (faced && !best.faced) ||
      (faced === best.faced && distance < best.distance)
    ) {
      best = { target, faced, distance };
    }
  }
  return best?.target ?? null;
}

/**
 * Whether tile (x, y) is in a footprint's approach: the ring of tiles round
 * it, `reach` deep, its own tiles excluded (D-033). Tile units, for sources
 * whose range is a ring, as the plaza's and the rooms' are.
 */
export function inApproachRing(rect: InteractionRect, x: number, y: number, reach = 1): boolean {
  const inHalo = x >= rect.x - reach && x < rect.x + rect.width + reach &&
    y >= rect.y - reach && y < rect.y + rect.height + reach;
  const inside = x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
  return inHalo && !inside;
}

/** A one-line prompt label: newlines folded to spaces, trimmed; null if nothing is left. */
export function promptLabel(text: unknown): string | null {
  if (typeof text !== 'string') return null;
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > 0 ? line : null;
}

export function createInteractionSystem(options: InteractionSystemOptions = {}): InteractionSystem {
  const sources: InteractionSource[] = [];
  const actions: InteractionAction[] = [];
  const suspensions = new Set<symbol>();
  let player: InteractionPlayer | null = null;
  let target: InteractionTarget | null = null;
  let prompt: InteractionPrompt | null = null;
  let destroyed = false;

  const isBlocked = (): boolean => {
    try {
      return options.blocked?.() === true;
    } catch {
      // A status that cannot be read fails closed: nothing is used.
      return true;
    }
  };

  const setPrompt = (next: InteractionPrompt | null): void => {
    if (samePrompt(prompt, next)) return;
    prompt = next;
    options.onPrompt?.(next);
  };

  const pick = (): InteractionTarget | null => {
    if (destroyed || !player || suspensions.size > 0 || isBlocked()) return null;
    const offered: InteractionTarget[] = [];
    for (const source of sources) {
      let listed: readonly InteractionTarget[] = [];
      try {
        listed = source.targets();
      } catch {
        // A failing source offers nothing; the others still work.
        listed = [];
      }
      if (Array.isArray(listed)) offered.push(...listed);
    }
    return chooseInteractionTarget(offered, player);
  };

  const refresh = (): void => {
    target = pick();
    setPrompt(target ? promptOf(target) : null);
  };

  return {
    get focused() {
      return prompt;
    },
    get suspended() {
      return suspensions.size > 0;
    },
    register(source) {
      if (destroyed) return () => {};
      sources.push(source);
      return () => {
        const index = sources.indexOf(source);
        if (index >= 0) sources.splice(index, 1);
      };
    },
    addAction(action) {
      if (destroyed) return () => {};
      actions.push(action);
      return () => {
        const index = actions.indexOf(action);
        if (index >= 0) actions.splice(index, 1);
      };
    },
    suspend(_reason) {
      if (destroyed) return () => {};
      const token = Symbol(_reason);
      suspensions.add(token);
      target = null;
      setPrompt(null);
      return () => {
        if (!suspensions.delete(token) || destroyed) return;
        if (suspensions.size === 0 && player) refresh();
      };
    },
    update(next) {
      if (destroyed) return;
      player = {
        position: { x: next.position.x, y: next.position.y },
        heading: { x: next.heading.x, y: next.heading.y },
      };
      refresh();
    },
    interact() {
      if (destroyed || isBlocked()) return false;
      // Re-pick from where the player stands now: a snapshot or a claim may
      // have changed what is usable since the last frame.
      refresh();
      const chosen = target;
      if (chosen) {
        chosen.activate();
        return true;
      }
      const ordered = actions
        .map((action, index) => ({ action, index }))
        .sort((a, b) => (b.action.priority ?? 0) - (a.action.priority ?? 0) || a.index - b.index);
      for (const { action } of ordered) {
        if (destroyed || isBlocked()) return false;
        if (action.run()) return true;
      }
      return false;
    },
    clear() {
      target = null;
      setPrompt(null);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      sources.length = 0;
      actions.length = 0;
      suspensions.clear();
      target = null;
      player = null;
      setPrompt(null);
    },
  };
}

function promptOf(target: InteractionTarget): InteractionPrompt {
  // D-127: a "chip only" target never carries an object through, so no view can
  // light one by accident.
  const quiet = target.cue === 'none';
  const object = !quiet && typeof target.object === 'object' && target.object !== null ? target.object : undefined;
  return Object.freeze({
    id: target.id,
    label: target.label,
    x: target.rect.x + target.rect.width / 2,
    y: target.rect.y + target.rect.height / 2,
    ...(object ? { object } : {}),
    ...(quiet ? { cue: 'none' as const } : {}),
  });
}

function samePrompt(a: InteractionPrompt | null, b: InteractionPrompt | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.id === b.id && a.label === b.label && a.x === b.x && a.y === b.y &&
    a.object === b.object && a.cue === b.cue;
}

function validTarget(target: unknown): target is InteractionTarget {
  if (target === null || typeof target !== 'object') return false;
  const candidate = target as Partial<InteractionTarget>;
  const rect = candidate.rect;
  return typeof candidate.id === 'string' && candidate.id.length > 0 &&
    typeof candidate.label === 'string' && candidate.label.length > 0 &&
    typeof candidate.activate === 'function' &&
    !!rect && [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) &&
    rect.width >= 0 && rect.height >= 0;
}
