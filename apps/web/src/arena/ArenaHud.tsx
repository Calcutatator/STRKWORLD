import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ARENA_MAX_HP, type ArenaRingSnapshot, type GameId } from '@strkworld/shared';
import { COPY } from '../copy.js';
import type { ArenaShellChannel } from './arena-controller.js';

/**
 * The arena ring's HUD (D-114): a Shell overlay over the World, like the
 * street HUD.
 *
 * - **The fighter** sees the dummy's HP (`TRAINING DUMMY 70/100`), the fight
 *   timer, the countdown (`3 · 2 · 1 · FIGHT!`), a LEAVE RING button (or Esc)
 *   and, on a touch screen only, STRIKE and BLOCK buttons. On a keyboard
 *   they read the two combat keys instead, "E STRIKE" and "Q BLOCK"
 *   (D-128), as key chips in the brand style.
 * - **Spectators** see a slim top bar (`TRAINING BOUT · 0:42`) with the HP.
 * - **Results** are a banner: VICTORY with the client-timed knockout, TIME, or
 *   what happened for spectators.
 *
 * Every figure shown is the server's state from the channel (HP, seconds
 * left, the outcome). The one local number is the knockout time, measured
 * from when this client saw the fight start. Results and the countdown go to
 * an `aria-live="polite"` region. Nothing renders outside the arena.
 */

export interface ArenaHudProps {
  readonly arena?: ArenaShellChannel;
  /** Whether the pointer is coarse (a touch screen): only then is there a STRIKE button. */
  readonly coarsePointer?: () => boolean;
  /** Reduced motion: the countdown loses its pulse and the banner fades instead of sliding. */
  readonly reducedMotion?: () => boolean;
  /** The clock, ms. `performance.now` by default. */
  readonly now?: () => number;
  /** Where Esc is listened for; the document by default. */
  readonly keyTarget?: Pick<Document, 'addEventListener' | 'removeEventListener'> | null;
}

/** How long FIGHT! shows once the countdown ends. */
export const ARENA_FIGHT_FLASH_MS = 900;

const NO_RING = (): ArenaRingSnapshot | null => null;
const NO_SUBSCRIBE = () => () => {};

function media(query: string): boolean {
  try {
    return globalThis.matchMedia?.(query).matches === true;
  } catch {
    return false;
  }
}

/** Seconds as m:ss. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Whether a key event belongs to something else: a text field, an editable
 * element, or an open window (a building panel, the guide). Attack and leave
 * keys never fire then; Space still types.
 */
export function keyBelongsElsewhere(target: unknown, doc: Pick<Document, 'querySelector'> | null = globalThis.document ?? null): boolean {
  const element = target as { tagName?: unknown; isContentEditable?: unknown; closest?: (selector: string) => unknown } | null;
  if (element && typeof element === 'object') {
    const tag = typeof element.tagName === 'string' ? element.tagName.toUpperCase() : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (element.isContentEditable === true) return true;
    if (typeof element.closest === 'function' && element.closest('.panel, [role="dialog"]')) return true;
  }
  try {
    return doc?.querySelector('.panel, [role="dialog"]') != null;
  } catch {
    return false;
  }
}

function selfIsChallenger(ring: ArenaRingSnapshot, self: GameId | null): boolean {
  return ring.phase !== 'idle' && self !== null && ring.challenger.kind === 'player' && ring.challenger.gameId === self;
}

interface Banner {
  readonly title: string;
  readonly detail: string | null;
  readonly tone: 'win' | 'neutral';
}

function bannerFor(ring: ArenaRingSnapshot, fighter: boolean, knockoutSeconds: number | null): Banner | null {
  if (ring.phase !== 'ended' || ring.outcome === null) return null;
  const { reason, winner } = ring.outcome;
  if (fighter) {
    if (reason === 'knockout' && winner === 'challenger') {
      const detail = knockoutSeconds === null ? null : `${COPY.arena.victoryDetail} ${knockoutSeconds.toFixed(1)} ${COPY.arena.seconds}`;
      return { title: COPY.arena.victory, detail, tone: 'win' };
    }
    if (reason === 'timeout') return { title: COPY.arena.time, detail: COPY.arena.timeDetail, tone: 'neutral' };
    return null;
  }
  if (reason === 'knockout') return { title: COPY.arena.spectatorWon, detail: null, tone: 'win' };
  if (reason === 'timeout') return { title: COPY.arena.spectatorTimeout, detail: null, tone: 'neutral' };
  return { title: COPY.arena.spectatorLeft, detail: null, tone: 'neutral' };
}

export function ArenaHud({
  arena,
  coarsePointer = () => media('(pointer: coarse)'),
  reducedMotion = () => media('(prefers-reduced-motion: reduce)'),
  now = () => globalThis.performance.now(),
  keyTarget = globalThis.document ?? null,
}: ArenaHudProps) {
  const ring = useSyncExternalStore(
    arena ? arena.subscribe : NO_SUBSCRIBE,
    arena ? arena.ring : NO_RING,
    arena ? arena.ring : NO_RING,
  );
  const self = arena?.selfId() ?? null;
  const fighter = ring !== null && selfIsChallenger(ring, self);

  // The fight's start as this client saw it, for the knockout time; and FIGHT!'s flash.
  const fightStart = useRef<{ round: number; at: number } | null>(null);
  const [knockout, setKnockout] = useState<{ round: number; seconds: number } | null>(null);
  const [flash, setFlash] = useState<number | null>(null);
  const lastPhase = useRef<{ round: number; phase: string } | null>(null);
  useEffect(() => {
    if (ring === null) {
      lastPhase.current = null;
      return;
    }
    const before = lastPhase.current;
    lastPhase.current = { round: ring.round, phase: ring.phase };
    if (ring.phase === 'fighting' && (before?.round !== ring.round || before.phase !== 'fighting')) {
      fightStart.current = { round: ring.round, at: now() };
      if (before?.round === ring.round && before.phase === 'countdown') setFlash(ring.round);
    }
    if (ring.phase === 'ended' && before?.phase === 'fighting' && fightStart.current?.round === ring.round) {
      setKnockout({ round: ring.round, seconds: (now() - fightStart.current.at) / 1000 });
    }
  }, [ring, now]);
  useEffect(() => {
    if (flash === null) return;
    const handle = globalThis.setTimeout(() => setFlash(null), ARENA_FIGHT_FLASH_MS);
    return () => globalThis.clearTimeout(handle);
  }, [flash]);

  // Esc leaves the ring, unless a text field or a window has the key.
  const canLeave = fighter && ring !== null && (ring.phase === 'countdown' || ring.phase === 'fighting');
  useEffect(() => {
    if (!canLeave || !keyTarget || !arena) return;
    const onKey = (event: Event): void => {
      const key = event as KeyboardEvent;
      if (key.key !== 'Escape' || key.repeat) return;
      if (keyBelongsElsewhere(key.target)) return;
      arena.leave();
    };
    keyTarget.addEventListener('keydown', onKey);
    return () => keyTarget.removeEventListener('keydown', onKey);
  }, [canLeave, keyTarget, arena]);

  if (!arena || ring === null || ring.phase === 'idle') return null;

  const touch = coarsePointer();
  // D-128: the server's own guard, so the hint and the button light with the stance.
  const guarding = fighter && ring.challenger.guarding;
  const dummy = ring.opponent.kind === 'dummy' ? ring.opponent : null;
  const hp = dummy ? dummy.hp : 0;
  const hpShare = Math.max(0, Math.min(1, hp / ARENA_MAX_HP));
  const reduced = reducedMotion();
  const banner = bannerFor(ring, fighter, knockout?.round === ring.round ? knockout.seconds : null);
  const showFight = flash === ring.round && ring.phase === 'fighting';
  const live =
    ring.phase === 'countdown'
      ? `${COPY.arena.countdownLive} ${ring.secondsLeft}`
      : showFight
        ? COPY.arena.fight
        : banner
          ? [banner.title, banner.detail].filter(Boolean).join('. ')
          : '';

  return (
    <div
      className="arena-hud"
      data-role={fighter ? 'fighter' : 'spectator'}
      data-motion={reduced ? 'reduced' : 'full'}
      aria-label={COPY.arena.label}
      role="region"
    >
      {dummy ? (
        <div className={fighter ? 'arena-hud-bar arena-hud-bar-fighter' : 'arena-hud-bar arena-hud-bar-spectator'}>
          <span className="arena-hud-title">
            {fighter ? COPY.arena.dummy : `${COPY.arena.bout} · ${formatClock(ring.phase === 'fighting' ? ring.secondsLeft : 0)}`}
          </span>
          <span
            className="arena-hud-hp"
            role="meter"
            aria-label={`${COPY.arena.dummy} ${COPY.arena.hp}`}
            aria-valuemin={0}
            aria-valuemax={ARENA_MAX_HP}
            aria-valuenow={hp}
          >
            <span className="arena-hud-hp-fill" style={{ width: `${hpShare * 100}%` }} />
          </span>
          <span className="arena-hud-hp-text" data-testid="arena-hp">{`${hp}/${ARENA_MAX_HP}`}</span>
          {fighter && ring.phase === 'fighting' ? (
            <span className="arena-hud-timer" aria-label={COPY.arena.timeLeft}>{formatClock(ring.secondsLeft)}</span>
          ) : null}
        </div>
      ) : null}

      {fighter && ring.phase === 'countdown' ? (
        <div className="arena-hud-countdown" key={`count-${ring.secondsLeft}`} aria-hidden="true">
          {ring.secondsLeft}
        </div>
      ) : null}
      {showFight ? (
        <div className="arena-hud-countdown arena-hud-fight" aria-hidden="true">
          {COPY.arena.fight}
        </div>
      ) : null}

      {banner ? (
        <div className="arena-hud-banner" data-tone={banner.tone} aria-hidden="true">
          <span className="arena-hud-banner-title">{banner.title}</span>
          {banner.detail ? <span className="arena-hud-banner-detail">{banner.detail}</span> : null}
        </div>
      ) : null}

      {fighter && ring.phase === 'fighting' && !touch ? (
        // D-128: what the two combat keys do, in the brand's key-chip style
        // (D-119/D-121 tokens). Shown on a keyboard only; on a touch screen
        // the STRIKE and BLOCK buttons below say it instead.
        <div className="arena-hud-hints" data-testid="arena-hints">
          <span className="arena-hud-hint">
            <kbd className="arena-hud-key">E</kbd>
            <span className="arena-hud-hint-text">{COPY.arena.strike}</span>
          </span>
          <span className="arena-hud-hint" data-state={guarding ? 'held' : 'idle'}>
            <kbd className="arena-hud-key">Q</kbd>
            <span className="arena-hud-hint-text">{COPY.arena.block}</span>
          </span>
        </div>
      ) : null}

      {canLeave ? (
        <div className="arena-hud-actions">
          {ring.phase === 'fighting' && touch ? (
            <button
              type="button"
              className="arena-hud-button arena-hud-block"
              data-state={guarding ? 'held' : 'idle'}
              aria-pressed={guarding}
              onPointerDown={(event) => {
                event.preventDefault();
                arena.guard(true);
              }}
              onPointerUp={() => arena.guard(false)}
              onPointerCancel={() => arena.guard(false)}
              onPointerLeave={() => arena.guard(false)}
              onLostPointerCapture={() => arena.guard(false)}
            >
              {COPY.arena.block}
            </button>
          ) : null}
          {ring.phase === 'fighting' && touch ? (
            <button type="button" className="arena-hud-button arena-hud-strike" onClick={() => arena.strike()}>
              {COPY.arena.strike}
            </button>
          ) : null}
          <button type="button" className="arena-hud-button arena-hud-leave" onClick={() => arena.leave()}>
            {COPY.arena.leave}
          </button>
        </div>
      ) : null}

      <p className="arena-hud-live" aria-live="polite" role="status">
        {live}
      </p>
    </div>
  );
}
