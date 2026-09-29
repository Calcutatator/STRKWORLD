import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { COPY } from '../../copy.js';
import { debugPlazaShells } from '../../debug/debug-tap.js';
import { useShellStreak } from '../../plaza/PlazaProvider.js';
import {
  SHELL_CUPS,
  cryptoRandomInt,
  planShellRound,
  shellNoteSlot,
  shellPickWins,
  shellSlots,
  shellSteps,
  type RandomInt,
  type ShellRound,
  type ShellStep,
} from '../../plaza/shell-game.js';
import { useStore } from '../../store/use-store.js';
import { PanelFrame } from '../PanelFrame.js';

/**
 * "Where's the note?" (D-076): the Privacy Plaza's shell game.
 *
 * A note hides under one of three cups, the cups shuffle in plain sight, and
 * the player picks one. Client-only: no money, no wallet, no backend, no
 * lobby; the streak lives in memory for this page. The shuffle is CSS
 * transforms on the theme's tokens; a player who asked for less motion gets
 * a quick fade instead, with the same honest outcome.
 */

/** How long the note shows before the cups come down and shuffle. */
export const SHELL_SHOW_MS = 900;

type Phase =
  | { readonly name: 'ready' }
  | { readonly name: 'showing'; readonly round: ShellRound; readonly steps: readonly ShellStep[] }
  | { readonly name: 'shuffling'; readonly round: ShellRound; readonly steps: readonly ShellStep[]; readonly step: number }
  | { readonly name: 'picking'; readonly round: ShellRound }
  | { readonly name: 'revealed'; readonly round: ShellRound; readonly picked: number; readonly win: boolean };

const CUPS = Array.from({ length: SHELL_CUPS }, (_, cup) => cup);
const START_SLOTS: readonly number[] = Object.freeze(CUPS);

function motionReducedByDefault(): boolean {
  try {
    return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
  } catch {
    return false;
  }
}

export function ShellGamePanel({
  onClose,
  random = cryptoRandomInt,
  reducedMotion,
}: {
  onClose: () => void;
  /** A fair die; tests inject one. */
  random?: RandomInt;
  /** The player's motion preference; read from the page when absent. */
  reducedMotion?: boolean;
}) {
  const copy = COPY.plaza.shells;
  const streak = useShellStreak();
  const wins = useStore(streak.store);
  const [phase, setPhase] = useState<Phase>({ name: 'ready' });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const table = useRef<HTMLDivElement | null>(null);
  const controls = useRef<HTMLDivElement | null>(null);
  const reduced = reducedMotion ?? motionReducedByDefault();

  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);

  // Each timed phase books the next one; unmounting cancels it.
  useEffect(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    if (phase.name === 'showing') {
      timer.current = setTimeout(() => {
        setPhase(phase.steps.length > 0
          ? { name: 'shuffling', round: phase.round, steps: phase.steps, step: 0 }
          : { name: 'picking', round: phase.round });
      }, reduced ? SHELL_SHOW_MS / 2 : SHELL_SHOW_MS);
    } else if (phase.name === 'shuffling') {
      const current = phase.steps[phase.step]!;
      timer.current = setTimeout(() => {
        const next = phase.step + 1;
        setPhase(next < phase.steps.length
          ? { ...phase, step: next }
          : { name: 'picking', round: phase.round });
      }, current.ms);
    }
  }, [phase, reduced]);

  // Keep a keyboard player in the game: a round removes the start button and
  // the reveal disables the chosen cup, either of which drops focus onto the
  // page. The cups take it when they can be picked, and "Play again" at the
  // reveal; only when focus was dropped or is still on the table.
  useEffect(() => {
    const target = phase.name === 'picking'
      ? table.current?.querySelector<HTMLButtonElement>('.shell-pick')
      : phase.name === 'revealed'
        ? controls.current?.querySelector<HTMLButtonElement>('.shell-start')
        : null;
    if (!target) return;
    const active = target.ownerDocument.activeElement;
    const dropped = active === null || active === target.ownerDocument.body;
    const onTable = active !== null && (table.current?.contains(active) === true || controls.current?.contains(active) === true);
    if (dropped || onTable) target.focus({ preventScroll: true });
  }, [phase.name]);

  const start = (): void => {
    const round = planShellRound(random, wins);
    setPhase({ name: 'showing', round, steps: shellSteps(round, reduced) });
  };

  const pick = (slot: number): void => {
    if (phase.name !== 'picking') return;
    const win = shellPickWins(phase.round, slot);
    streak.record(win);
    debugPlazaShells(win ? 'win' : 'lose');
    setPhase({ name: 'revealed', round: phase.round, picked: slot, win });
  };

  // What the table shows now: every cup's slot, which are lifted, whether they are faded out.
  let slots = START_SLOTS;
  let lifted: readonly number[] = [];
  let moving: readonly [number, number] | null = null;
  let faded = false;
  let noteShown = false;
  let noteCup: number | null = null;
  let swapMs: number | null = null;
  if (phase.name !== 'ready') {
    noteCup = phase.round.noteCup;
    swapMs = phase.round.swapMs;
  }
  if (phase.name === 'showing') {
    lifted = [phase.round.noteCup];
    noteShown = true;
  } else if (phase.name === 'shuffling') {
    const step = phase.steps[phase.step]!;
    if (step.kind === 'swap') {
      slots = step.slots;
      moving = step.lifted;
    } else if (step.kind === 'fade-out') {
      faded = true;
    } else {
      slots = step.slots;
    }
  } else if (phase.name === 'picking') {
    slots = shellSlots(phase.round);
  } else if (phase.name === 'revealed') {
    slots = shellSlots(phase.round);
    const pickedCup = slots.indexOf(phase.picked);
    lifted = pickedCup === phase.round.noteCup ? [pickedCup] : [pickedCup, phase.round.noteCup];
    noteShown = true;
  }

  const status =
    phase.name === 'ready' ? copy.intro
      : phase.name === 'showing' ? copy.watch
        : phase.name === 'shuffling' ? copy.shuffling
          : phase.name === 'picking' ? copy.pick
            : phase.win ? copy.win
              : `${copy.loseLead} ${shellNoteSlot(phase.round) + 1}.`;

  const tableStyle = { '--shell-swap-ms': `${swapMs ?? 0}ms` } as CSSProperties;

  return (
    <PanelFrame title={copy.title} building="plaza" disclosure={null} onClose={onClose}>
      <p className="panel-intro">{copy.pool}</p>
      <div
        ref={table}
        className="shell-table"
        data-phase={phase.name}
        data-motion={reduced ? 'reduced' : 'full'}
        style={tableStyle}
      >
        {noteCup !== null ? (
          <span
            className="shell-note"
            data-shown={noteShown ? 'true' : 'false'}
            style={{ '--slot': slots[noteCup] } as CSSProperties}
            aria-hidden="true"
          />
        ) : null}
        {CUPS.map((cup) => (
          <span
            key={cup}
            className="shell-cup"
            data-cup={cup}
            data-lifted={lifted.includes(cup) ? 'true' : 'false'}
            data-moving={moving ? (moving[0] === cup ? 'front' : moving[1] === cup ? 'back' : 'still') : 'still'}
            data-faded={faded ? 'true' : 'false'}
            style={{ '--slot': slots[cup] } as CSSProperties}
            aria-hidden="true"
          />
        ))}
        <div className="shell-picks" role="group" aria-label={copy.pick}>
          {CUPS.map((slot) => (
            <button
              key={slot}
              type="button"
              className="shell-pick"
              style={{ '--slot': slot } as CSSProperties}
              disabled={phase.name !== 'picking'}
              data-picked={phase.name === 'revealed' && phase.picked === slot ? 'true' : undefined}
              onClick={() => pick(slot)}
            >
              <span className="shell-pick-label">{`${copy.cup} ${slot + 1}`}</span>
            </button>
          ))}
        </div>
      </div>
      <p className="shell-status" role="status" aria-live="polite" data-result={phase.name === 'revealed' ? (phase.win ? 'win' : 'lose') : undefined}>
        {status}
      </p>
      <div ref={controls} className="shell-controls">
        <p className="shell-streak">
          {copy.streak} <strong data-testid="shell-streak">{wins}</strong>
        </p>
        {phase.name === 'ready' || phase.name === 'revealed' ? (
          <button type="button" className="shell-start" onClick={start}>
            {phase.name === 'ready' ? copy.start : copy.again}
          </button>
        ) : null}
      </div>
      <p className="shell-fun">{copy.fun}</p>
    </PanelFrame>
  );
}
