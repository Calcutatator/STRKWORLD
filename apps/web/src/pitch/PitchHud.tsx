import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { FOOTBALL_WIN_SCORE, type FootballSide, type PitchMatchSnapshot } from '@strkworld/shared';
import { COPY } from '../copy.js';
import type { PitchShellChannel } from './pitch-controller.js';

/**
 * The gated pitch's HUD (D-135): a Shell overlay over the World, in the same
 * shape as the ring's (`arena/ArenaHud.tsx`) and the same brand tokens
 * (D-119/D-121).
 *
 * - **Filling up:** a slim bar, `WAITING FOR PLAYERS · 2 of 4 in`, so whoever
 *   is inside the fence knows what the pitch is waiting for.
 * - **In a match:** the scoreboard — `STARKS 1 – 0 SNARKS` with `FIRST TO 3`
 *   under it — and, over the middle of the screen, the 3–2–1 before a kick-off
 *   and the shorter beat after a goal.
 * - **At full time:** a banner, `STARKS WIN`, with the final score.
 *
 * Every figure is the server's, straight off the channel: the phase, the
 * score, the seconds left and the winner. Nothing is counted or timed here,
 * so a player and someone watching from the stands read the same match. The
 * countdown and the result go to an `aria-live="polite"` region; nothing
 * renders at all away from the pitch, where the channel is null.
 */

export interface PitchHudProps {
  readonly pitch?: PitchShellChannel;
  /** Reduced motion: the countdown loses its pulse and the banner fades instead of sliding. */
  readonly reducedMotion?: () => boolean;
}

/** How long KICK OFF! shows once a countdown ends. */
export const PITCH_KICK_OFF_FLASH_MS = 800;

const NO_MATCH = (): PitchMatchSnapshot | null => null;
const NO_SUBSCRIBE = () => () => {};

function media(query: string): boolean {
  try {
    return globalThis.matchMedia?.(query).matches === true;
  } catch {
    return false;
  }
}

/** A team's name as every scoreboard and banner writes it. */
export function pitchTeamName(side: FootballSide): string {
  return side === 'starks' ? COPY.pitch.starks : COPY.pitch.snarks;
}

/** How many of the four places are taken, players and dummies alike. */
export function pitchTaken(match: PitchMatchSnapshot): number {
  return match.slots.filter((slot) => slot.kind !== 'empty').length;
}

export function PitchHud({ pitch, reducedMotion = () => media('(prefers-reduced-motion: reduce)') }: PitchHudProps) {
  const match = useSyncExternalStore(pitch?.subscribe ?? NO_SUBSCRIBE, pitch?.match ?? NO_MATCH, pitch?.match ?? NO_MATCH);
  /** The round whose kick-off flash is showing, so it plays once per countdown. */
  const [flash, setFlash] = useState<number | null>(null);
  const counted = useRef<{ round: number; phase: string } | null>(null);

  // A countdown that ends in play is a kick-off: flash it, once, per round.
  useEffect(() => {
    if (!match) {
      counted.current = null;
      return;
    }
    const was = counted.current;
    counted.current = { round: match.round, phase: match.phase };
    if (match.phase !== 'playing' || was === null || was.phase !== 'countdown' || was.round !== match.round) return;
    setFlash(match.round);
    const handle = globalThis.setTimeout(() => setFlash(null), PITCH_KICK_OFF_FLASH_MS);
    return () => globalThis.clearTimeout(handle);
  }, [match]);

  if (!pitch || match === null || match.phase === 'open') {
    // Open and empty says nothing; open with someone inside says what it waits for.
    if (!pitch || match === null || pitchTaken(match) === 0) return null;
    return (
      <div className="pitch-hud" data-phase="open" aria-label={COPY.pitch.label} role="region">
        <div className="pitch-hud-bar pitch-hud-waiting">
          <span className="pitch-hud-title">{COPY.pitch.waiting}</span>
          <span className="pitch-hud-filled" data-testid="pitch-filled">
            {`${pitchTaken(match)} ${COPY.pitch.filled}`}
          </span>
        </div>
      </div>
    );
  }

  const reduced = reducedMotion();
  const showKickOff = flash === match.round && match.phase === 'playing';
  const winner = match.phase === 'ended' ? match.winner : null;
  const live =
    match.phase === 'countdown'
      ? `${COPY.pitch.countdownLive} ${match.secondsLeft}`
      : showKickOff
        ? COPY.pitch.kickOff
        : winner
          ? `${pitchTeamName(winner)} ${COPY.pitch.win}. ${match.starks} – ${match.snarks}`
          : '';

  return (
    <div
      className="pitch-hud"
      data-phase={match.phase}
      data-motion={reduced ? 'reduced' : 'full'}
      aria-label={COPY.pitch.label}
      role="region"
    >
      <div className="pitch-hud-bar">
        <span className="pitch-hud-team" data-side="starks">
          {COPY.pitch.starks}
        </span>
        <span className="pitch-hud-score" data-testid="pitch-score">
          {`${match.starks} – ${match.snarks}`}
        </span>
        <span className="pitch-hud-team" data-side="snarks">
          {COPY.pitch.snarks}
        </span>
        <span className="pitch-hud-target">{`${COPY.pitch.target} ${FOOTBALL_WIN_SCORE}`}</span>
      </div>

      {match.phase === 'countdown' ? (
        <div className="pitch-hud-countdown" key={`count-${match.round}-${match.secondsLeft}`} aria-hidden="true">
          {match.secondsLeft}
        </div>
      ) : null}
      {showKickOff ? (
        <div className="pitch-hud-countdown pitch-hud-kickoff" aria-hidden="true">
          {COPY.pitch.kickOff}
        </div>
      ) : null}

      {winner ? (
        <div className="pitch-hud-banner" data-side={winner} aria-hidden="true">
          <span className="pitch-hud-banner-title">{`${pitchTeamName(winner)} ${COPY.pitch.win}`}</span>
          <span className="pitch-hud-banner-detail">{`${match.starks} – ${match.snarks}`}</span>
        </div>
      ) : null}

      <p className="pitch-hud-live" aria-live="polite" role="status">
        {live}
      </p>
    </div>
  );
}
