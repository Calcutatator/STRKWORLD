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
        disclosures={['First line.', 'Second thing.']}
        busy={false}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(markup.indexOf('First line.')).toBeLessThan(markup.indexOf('class="confirm"'));
    expect(markup).toContain('Second thing.');
  });

  it('enables confirm with no lines at all: none is required (D-118)', () => {
    const markup = renderToStaticMarkup(
      <ConfirmGate
        disclosures={[]}
        busy={false}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(markup).not.toContain('commit-disclosures');
    expect(markup.match(/<button[^>]*class="confirm"[^>]*>/)?.[0]).not.toContain('disabled');
  });

  it('disables both controls while a submission is in flight', () => {
    const markup = renderToStaticMarkup(
      <ConfirmGate
        disclosures={[]}
        busy
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(markup.match(/disabled/g) ?? []).toHaveLength(2);
  });
});
