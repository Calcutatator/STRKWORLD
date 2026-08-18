import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FakePrivacyOperations } from '@strkworld/privacy';
import { PrivacyProvider } from '../privacy/PrivacyProvider.js';
import { SessionNoticeLayer } from '../privacy/SessionNoticeLayer.js';
import { createSubmissionUncertainty } from '../privacy/submission-uncertainty.js';
import { PRIVACY_REGISTER, type RouteGrade } from '../privacy/register.js';
import { VisitLayerView } from './VisitLayer.js';

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(
    <PrivacyProvider operations={new FakePrivacyOperations()}>{node}</PrivacyProvider>,
  );
}

describe('VisitLayerView', () => {
  it('shows only the hovering Menu Mode control when a Bank visit starts', () => {
    const markup = render(
      <VisitLayerView
        state={{ name: 'visiting', building: 'bank', surface: { name: 'room' } }}
        connected
        onOpenMenu={() => {}}
        onCloseSurface={() => {}}
        onDismissLocked={() => {}}
      />,
    );

    expect(markup).toContain('class="menu-mode-button"');
    expect(markup).toContain('Menu Mode');
    expect(markup).not.toContain('name="amount"');
  });

  it('renders the existing full Bank panel in Menu Mode', () => {
    const markup = render(
      <VisitLayerView
        state={{ name: 'visiting', building: 'bank', surface: { name: 'menu' } }}
        connected
        onOpenMenu={() => {}}
        onCloseSurface={() => {}}
        onDismissLocked={() => {}}
      />,
    );

    expect(markup).toContain('data-experience="menu"');
    expect(markup).toContain('Private transfer');
    expect(markup).toContain('Add to this visit');
  });

  it('renders the shielding station as the same Bank flow limited to one action', () => {
    const markup = render(
      <VisitLayerView
        state={{
          name: 'visiting',
          building: 'bank',
          surface: { name: 'station', station: 'bank:shielding' },
        }}
        connected
        onOpenMenu={() => {}}
        onCloseSurface={() => {}}
        onDismissLocked={() => {}}
      />,
    );

    expect(markup).toContain('data-experience="station"');
    expect(markup).toContain('Shield');
    expect(markup).toContain('Unshield');
    expect(markup).not.toContain('Private transfer');
    expect(markup).toContain('This station confirms one action at a time.');
    expect(markup).toContain('Review this action');
    expect(markup).not.toContain('Add to this visit');
    expect(markup).not.toContain('Nothing queued yet');
  });

  it('renders the Post Office station as one private transfer action', () => {
    const markup = render(
      <VisitLayerView
        state={{
          name: 'visiting',
          building: 'post-office',
          surface: { name: 'station', station: 'post-office:transfer' },
        }}
        connected
        onOpenMenu={() => {}}
        onCloseSurface={() => {}}
        onDismissLocked={() => {}}
      />,
    );

    expect(markup).toContain('data-experience="station"');
    expect(markup).toContain('The Post Office');
    expect(markup).toContain('Private transfer');
    expect(markup).not.toContain('Shield');
    expect(markup).not.toContain('Unshield');
    expect(markup).not.toContain('Add to this visit');
    expect(markup).not.toContain('Nothing queued yet');
    expect(markup).toContain('This station confirms one action at a time.');
  });

  it('keeps Post Office Menu Mode explicitly unbuilt', () => {
    const markup = render(
      <VisitLayerView
        state={{ name: 'visiting', building: 'post-office', surface: { name: 'menu' } }}
        connected
        onOpenMenu={() => {}}
        onCloseSurface={() => {}}
        onDismissLocked={() => {}}
      />,
    );

    expect(markup).toContain('class="room-unbuilt"');
    expect(markup).toContain('This room is still being built.');
    expect(markup).not.toContain('name="amount"');
  });

  it('re-runs the privacy gate and renders no financial form when a station is disabled', () => {
    const unapprovedShield: RouteGrade = {
      ...PRIVACY_REGISTER.find((entry) => entry.route === 'bank.shield')!,
      disclosure: null,
      approvedBy: null,
      approvedOn: null,
      rationale: null,
    };
    const register = [
      ...PRIVACY_REGISTER.filter((entry) => entry.route !== 'bank.shield'),
      unapprovedShield,
    ];
    const markup = render(
      <VisitLayerView
        state={{
          name: 'visiting',
          building: 'bank',
          surface: { name: 'station', station: 'bank:shielding' },
        }}
        connected
        register={register}
        onOpenMenu={() => {}}
        onCloseSurface={() => {}}
        onDismissLocked={() => {}}
      />,
    );

    expect(markup).toContain('data-lock-reason="unapproved-route"');
    expect(markup).not.toContain('name="amount"');
  });

  it('fails closed when a stale or unknown station reaches the view', () => {
    const markup = render(
      <VisitLayerView
        state={{
          name: 'visiting',
          building: 'bank',
          surface: { name: 'station', station: 'bank:not-registered' },
        }}
        connected
        onOpenMenu={() => {}}
        onCloseSurface={() => {}}
        onDismissLocked={() => {}}
      />,
    );

    expect(markup).toContain('data-lock-reason="unknown-route"');
    expect(markup).not.toContain('name="amount"');
  });

  it('keeps submission uncertainty above room, Menu, station and exited visit surfaces', () => {
    const uncertainty = createSubmissionUncertainty();
    uncertainty.retain();
    const states = [
      { name: 'visiting', building: 'bank', surface: { name: 'room' } },
      { name: 'visiting', building: 'bank', surface: { name: 'menu' } },
      {
        name: 'visiting',
        building: 'bank',
        surface: { name: 'station', station: 'bank:shielding' },
      },
      { name: 'outside' },
    ] as const;

    for (const state of states) {
      const markup = renderToStaticMarkup(
        <PrivacyProvider
          operations={new FakePrivacyOperations()}
          submissionUncertainty={uncertainty}
        >
          <VisitLayerView
            state={state}
            connected
            onOpenMenu={() => {}}
            onCloseSurface={() => {}}
            onDismissLocked={() => {}}
          />
          <SessionNoticeLayer />
        </PrivacyProvider>,
      );
      expect(markup).toContain('submission-uncertainty');
      expect(markup).not.toContain('Try again');
      expect(markup).not.toContain('Nothing was sent');
    }
  });
});
