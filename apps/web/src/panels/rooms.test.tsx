import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { COPY } from '../copy.js';
import { ConfirmGate } from './ConfirmGate.js';
import { LockedRoom, UnbuiltRoom } from './LockedRoom.js';

describe('locked and unbuilt rooms', () => {
  it('a locked door offers nothing but the reason', () => {
    const markup = renderToStaticMarkup(
      <LockedRoom
        building="vault"
        reason="coming-soon"
        message={COPY.locked.comingSoon}
        onClose={() => {}}
      />,
    );
    expect(markup).toContain(COPY.buildings.vault);
    expect(markup).toContain(COPY.locked.comingSoon);
    expect(markup).toContain('data-lock-reason="coming-soon"');
    // No public alternative, and nothing to click through to one (D-018).
    expect(markup.match(/<button/g) ?? []).toHaveLength(1); // the close button
  });

  it('an unbuilt room says so without implying a privacy problem', () => {
    const markup = renderToStaticMarkup(
      <UnbuiltRoom building="exchange" message={COPY.unbuilt} onClose={() => {}} />,
    );
    expect(markup).toContain(COPY.unbuilt);
    expect(markup).not.toContain('data-lock-reason');
  });
});

describe('the commit gate', () => {
  it('renders its disclosures above the button', () => {
    const markup = renderToStaticMarkup(
      <ConfirmGate
        disclosures={['Shielding is public.', 'Second thing.']}
        busy={false}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(markup.indexOf('Shielding is public.')).toBeLessThan(markup.indexOf('class="confirm"'));
    expect(markup).toContain('Second thing.');
  });

  it('disables both controls while a submission is in flight', () => {
    const markup = renderToStaticMarkup(
      <ConfirmGate disclosures={[]} busy onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(markup.match(/disabled/g) ?? []).toHaveLength(2);
  });
});
