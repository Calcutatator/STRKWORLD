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
    expect(markup).toContain(COPY.batch.add);
    expect(markup).toContain(COPY.batch.empty);
    expect(markup).not.toContain(COPY.bank.shield);
    expect(markup).not.toContain(COPY.bank.unshield);
    expect(markup).not.toContain(COPY.gameMode.singleAction);
  });

  it('runs the privacy gate before resolving the Post Office panel', () => {
    const transfer = PRIVACY_REGISTER.find((entry) => entry.route === 'post-office.transfer')!;
    const lockedTransfer: RouteGrade = {
      ...transfer,
      grade: 'anonymous',
      approvedBy: null,
      approvedOn: null,
      disclosure: null,
      rationale: null,
    };
    const register = [
      ...PRIVACY_REGISTER.filter((entry) => entry.route !== 'post-office.transfer'),
      lockedTransfer,
    ];

    const room = resolveRoom('post-office', BUILDING_PANELS, register);
    expect(room.kind).toBe('locked');
    expect(room.kind === 'locked' && room.reason).toBe('unapproved-route');
  });
});
