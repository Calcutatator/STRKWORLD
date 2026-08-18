import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { COPY } from '../copy.js';
import { SubmissionUncertaintyNotice } from './SessionNoticeLayer.js';

describe('SubmissionUncertaintyNotice', () => {
  it('renders the exact non-retryable D-034 copy above the interaction layer', () => {
    const markup = renderToStaticMarkup(
      <SubmissionUncertaintyNotice active acknowledged={false} onAcknowledge={() => {}} />,
    );

    expect(markup).toContain(COPY.errors['submission-uncertain']);
    expect(markup).toContain('role="alert"');
    expect(markup).not.toContain('Try again');
    expect(markup).not.toContain('Nothing was sent');
    expect(markup).toContain('I refreshed and checked my private balance');
  });

  it('renders nothing before an uncertain submission exists', () => {
    expect(
      renderToStaticMarkup(
        <SubmissionUncertaintyNotice
          active={false}
          acknowledged={false}
          onAcknowledge={() => {}}
        />,
      ),
    ).toBe('');
  });

  it('keeps the notice visible after acknowledgement with only the approved post-copy', () => {
    const markup = renderToStaticMarkup(
      <SubmissionUncertaintyNotice
        active
        acknowledged
        onAcknowledge={vi.fn()}
      />,
    );

    expect(markup).toContain(
      'A previous private action is still unconfirmed. You checked your refreshed balance before continuing.',
    );
    expect(markup).not.toContain('I refreshed and checked my private balance');
    expect(markup).not.toContain('<button');
  });
});
