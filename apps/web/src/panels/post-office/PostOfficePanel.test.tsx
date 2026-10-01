import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FakePrivacyOperations } from '@strkworld/privacy';
import { COPY } from '../../copy.js';
import { PrivacyProvider } from '../../privacy/PrivacyProvider.js';
import { PRIVACY_REGISTER, type RouteGrade } from '../../privacy/register.js';
import { resolveRoom } from '../panel-framework.js';
import { BUILDING_PANELS } from '../registry.js';
import { PostOfficePanel } from './PostOfficePanel.js';

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(
    <PrivacyProvider operations={new FakePrivacyOperations()}>{node}</PrivacyProvider>,
  );
}

describe('Post Office Menu Mode', () => {
  it('is admitted through the building registry with a transfer-only Menu adapter', () => {
    const descriptor = BUILDING_PANELS['post-office'];
    expect(descriptor).toBeDefined();
    expect(descriptor?.title).toBe(COPY.buildings['post-office']);
    expect(descriptor?.Component).toBe(PostOfficePanel);

    const markup = render(<PostOfficePanel onClose={() => {}} />);
    expect(markup).toContain('data-experience="menu"');
    expect(markup).toContain(COPY.buildings['post-office']);
    expect(markup).toContain(COPY.bank.transfer);
    expect(markup).not.toContain(COPY.bank.shield);
    expect(markup).not.toContain(COPY.bank.unshield);
    expect(markup).not.toContain(COPY.gameMode.singleAction);
  });

  it('composes one send at a time — one recipient per send (D-065)', () => {
    const markup = render(<PostOfficePanel onClose={() => {}} />);
    expect(markup).toContain(COPY.postOffice.oneAtATime);
    expect(markup).toContain(COPY.bank.enterRecipient);
    // D-040's visit vocabulary would promise several sends settling together.
    expect(markup).not.toContain(COPY.batch.add);
    expect(markup).not.toContain(COPY.batch.empty);
    expect(markup).not.toContain(COPY.batch.why);
  });

  it('explains its own identity — a private send to another registered pool account — before any control', () => {
    const markup = render(<PostOfficePanel onClose={() => {}} />);
    expect(markup).toContain(COPY.postOffice.intro);
    // Says what it does without implying anything the flow does not: it
    // requires the recipient to already be registered, and never overclaims
    // "anonymous forever"/"untraceable" (copy.test.ts enforces that globally).
    expect(markup.indexOf(COPY.postOffice.intro)).toBeLessThan(markup.indexOf(COPY.bank.transfer));
  });

  it('runs the privacy gate before resolving the Post Office panel', () => {
    const transfer = PRIVACY_REGISTER.find((entry) => entry.route === 'post-office.transfer')!;
    // Since D-065 the route is an approved `anonymous` deviation whose
    // disclosure is waived. Withdrawing either the approval or the waiver
    // locks the building, whatever else the entry still says.
    expect(resolveRoom('post-office', BUILDING_PANELS).kind).toBe('panel');
    for (const change of [
      { approvedBy: null, approvedOn: null, rationale: null },
      { disclosureWaivedBy: null },
      { disclosureWaivedBy: 'D-064' },
    ] satisfies Partial<RouteGrade>[]) {
      const register = [
        ...PRIVACY_REGISTER.filter((entry) => entry.route !== 'post-office.transfer'),
        { ...transfer, ...change },
      ];

      const room = resolveRoom('post-office', BUILDING_PANELS, register);
      expect(room.kind, JSON.stringify(change)).toBe('locked');
      expect(room.kind === 'locked' && room.reason, JSON.stringify(change)).toBe('unapproved-route');
    }
  });
});
