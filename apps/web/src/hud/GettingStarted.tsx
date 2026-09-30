import type { KeyboardEvent, Ref } from 'react';
import { COPY } from '../copy.js';
import { guideRouteSteps } from './guide-route.js';

/**
 * The first-run "Getting started" card. A pure view; `HudLayer` owns whether
 * it is open and remembers the dismissal.
 *
 * It is a non-modal region, not a dialog: the street stays live behind it, so
 * a player can try the controls while reading them. It stays in the document
 * while closed (`hidden`) so the HUD's `?` control always has a target.
 *
 * The controls are the World's real bindings (`packages/world` dom-keyboard,
 * world-session and the visit controller's Escape; the camera is fixed and
 * takes no input), and the route never calls the Bridge private: its arrival
 * is public.
 */
export function GettingStarted({
  id,
  titleId,
  open,
  headingRef,
  onDismiss,
}: {
  id: string;
  titleId: string;
  open: boolean;
  headingRef?: Ref<HTMLHeadingElement>;
  onDismiss: () => void;
}) {
  const steps = guideRouteSteps();
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Escape') return;
    // The card owns its own Escape; the visit layer's window listener must
    // not also treat it as "close the counter".
    event.preventDefault();
    event.stopPropagation();
    onDismiss();
  };

  return (
    <section id={id} className="journey-guide" aria-labelledby={titleId} hidden={!open} onKeyDown={onKeyDown}>
      <h2 id={titleId} ref={headingRef} tabIndex={-1}>
        {COPY.guide.title}
      </h2>
      <p>{COPY.guide.intro}</p>

      <h3>{COPY.guide.controlsTitle}</h3>
      <dl className="journey-guide-controls">
        {COPY.guide.controls.map(({ input, effect }) => (
          <div key={input}>
            <dt>{input}</dt>
            <dd>{effect}</dd>
          </div>
        ))}
      </dl>

      <h3>{COPY.guide.buildingsTitle}</h3>
      <p>{COPY.guide.buildings}</p>

      <h3>{COPY.guide.routeTitle}</h3>
      {steps.length > 0 ? (
        <ol className="journey-guide-route">
          {steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      ) : (
        <p className="journey-guide-route-none">{COPY.guide.route.none}</p>
      )}
      <p className="journey-guide-note">{COPY.guide.routeNote}</p>

      <h3>{COPY.guide.sandboxTitle}</h3>
      <p>{COPY.guide.sandbox}</p>

      <h3>{COPY.guide.plazaTitle}</h3>
      <p>{COPY.guide.plaza}</p>

      <h3>{COPY.guide.pitchTitle}</h3>
      <p>{COPY.guide.pitch}</p>

      <button type="button" className="journey-guide-dismiss" onClick={onDismiss}>
        {COPY.guide.dismiss}
      </button>
    </section>
  );
}
