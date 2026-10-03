import {
  FOOTBALL_WIN_SCORE,
  PITCH_GATES,
  normalizePitchMatch,
  pitchGateAt,
  type PitchGate,
  type PitchMatchSnapshot,
} from '@strkworld/shared';
import { PITCH_ENTER_PROMPT, PITCH_LEAVE_PROMPT, PITCH_LOCKED_TEXT } from './map/pitch.js';
import type { InteractionTarget } from './interaction.js';

/**
 * The World's view of the gated pitch's match (D-135), and the two gates as
 * stations on the shared press-E system (D-117).
 *
 * The Shell supplies the channel, as it does the ball's (`football-channel.ts`):
 * the match is the room's and there is no solo one, so offline `match()` is
 * null, both gates read nothing and the pitch is simply a fenced enclosure
 * nobody can enter. The World never decides who is playing; it draws the
 * prompt the match implies and sends the press.
 *
 * The gate is a station, not a door: walking into it does nothing, exactly as
 * the arena ring's gate works, which is why it lives here and not in
 * `door-trigger.ts`.
 */

export interface PitchChannel {
  /** The match as the room holds it, or null: offline, or away from the pitch. */
  match(): PitchMatchSnapshot | null;
  /** Press E at the gate the player stands at. */
  gate(): void;
  /** This client's slot in the match, or -1. Absent means "never playing". */
  selfSlot?(): number;
}

/** The interaction id both gates share: one station, wherever it is pressed. */
export const PITCH_GATE_TARGET_ID = 'pitch:gate';

/**
 * Validate an untrusted match. Anything that is not exactly a match means no
 * match at all, so a bad frame never opens a gate or hides one.
 */
export function normalizePitchFrame(value: unknown): PitchMatchSnapshot | null {
  return normalizePitchMatch(value, FOOTBALL_WIN_SCORE);
}

/**
 * Whether the gates read "IN PLAY": every place is held by a real player, or
 * a winner's banner is up. A match with a dummy in it still has a place to
 * take, which is how a real player joins one already running.
 */
export function isPitchLocked(match: PitchMatchSnapshot): boolean {
  return match.phase === 'ended' || match.slots.every((slot) => slot.kind === 'player');
}

/**
 * The gate target the player standing at `at` is offered, or none.
 *
 * Three states, one station: a participant standing on a gate's inside tile
 * is offered "LEAVE PITCH"; anyone on a gate's approach is offered "ENTER
 * PITCH", or "IN PLAY" when the match is locked. The locked chip still shows,
 * because saying why the gate will not open is the whole point of it (D-123).
 */
export function pitchGateTargets(
  match: PitchMatchSnapshot | null,
  at: { readonly x: number; readonly y: number },
  playing: boolean,
  press: () => void,
  tileSize: number,
): readonly InteractionTarget[] {
  if (match === null) return EMPTY;
  const gate = pitchGateAt(at.x, at.y);
  if (gate === null) return EMPTY;
  const label = playing ? PITCH_LEAVE_PROMPT : isPitchLocked(match) ? PITCH_LOCKED_TEXT : PITCH_ENTER_PROMPT;
  const open = playing || !isPitchLocked(match);
  return Object.freeze([
    Object.freeze({
      id: PITCH_GATE_TARGET_ID,
      label,
      rect: gateRect(gate, tileSize),
      // A locked gate is a station that says no: the press is simply not sent.
      activate: () => {
        if (open) press();
      },
    }),
  ]);
}

const EMPTY: readonly InteractionTarget[] = Object.freeze([]);

/** A gate's own tiles as a World pixel rectangle: what the prompt is measured to. */
function gateRect(gate: PitchGate, tileSize: number): { x: number; y: number; width: number; height: number } {
  return {
    x: gate.tiles.x * tileSize,
    y: gate.tiles.y * tileSize,
    width: gate.tiles.width * tileSize,
    height: gate.tiles.height * tileSize,
  };
}

/** Both gates, as the World draws them. */
export const PITCH_WORLD_GATES = PITCH_GATES;
