import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FakePrivacyOperations } from '@strkworld/privacy';
import { PrivacyProvider, usePrivacy, type ShellPrivacy } from './PrivacyProvider.js';
import { createSubmissionUncertainty } from './submission-uncertainty.js';

function Probe() {
  const { connectState } = usePrivacy();
  return <p>{connectState.name}</p>;
}

describe('PrivacyProvider', () => {
  it('refuses to invent a financial seam', () => {
    // The earlier version fell back to the deterministic fake, so a mis-wired
    // build would have shown a working Bank holding 250 STRK nobody owns.
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      renderToStaticMarkup(
        <PrivacyProvider>
          <Probe />
        </PrivacyProvider>,
      ),
    ).toThrow(/needs an `operations` prop/);
    error.mockRestore();
  });

  it('uses the seam it is given', () => {
    const markup = renderToStaticMarkup(
      <PrivacyProvider operations={new FakePrivacyOperations()}>
        <Probe />
      </PrivacyProvider>,
    );
    expect(markup).toContain('disconnected');
  });

  it('refuses the demo seam in a production build', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() =>
      renderToStaticMarkup(
        <PrivacyProvider demo build={{ production: true }}>
          <Probe />
        </PrivacyProvider>,
      ),
    ).toThrow(/must never ship/);
    error.mockRestore();
  });

  it('loads the demo seam lazily, and only when asked for by name', () => {
    // Nothing renders until the dynamic import resolves, which is the point:
    // the seam pulls `starknet`, and the shell must render a connect screen
    // without it.
    const markup = renderToStaticMarkup(
      <PrivacyProvider demo fallback={<p>loading</p>}>
        <Probe />
      </PrivacyProvider>,
    );
    expect(markup).toBe('<p>loading</p>');
  });

  it('routes an uncertain operation into provider-lifetime session memory', () => {
    const uncertainty = createSubmissionUncertainty();
    let shell: ShellPrivacy | null = null;
    function Capture() {
      shell = usePrivacy();
      return null;
    }
    renderToStaticMarkup(
      <PrivacyProvider
        operations={new FakePrivacyOperations()}
        submissionUncertainty={uncertainty}
      >
        <Capture />
      </PrivacyProvider>,
    );

    expect(shell).not.toBeNull();
    (shell as ShellPrivacy | null)?.noteOperationError({ kind: 'submission-uncertain' });

    expect(uncertainty.store.getState()).toEqual({ active: true, acknowledged: false });
  });

  it('re-locks an acknowledged session when another uncertainty is reported', () => {
    const uncertainty = createSubmissionUncertainty();
    let shell: ShellPrivacy | null = null;
    function Capture() {
      shell = usePrivacy();
      return null;
    }
    renderToStaticMarkup(
      <PrivacyProvider
        operations={new FakePrivacyOperations()}
        submissionUncertainty={uncertainty}
      >
        <Capture />
      </PrivacyProvider>,
    );

    uncertainty.retain();
    uncertainty.acknowledge();
    expect(uncertainty.store.getState()).toEqual({ active: true, acknowledged: true });
    (shell as ShellPrivacy | null)?.noteOperationError({ kind: 'submission-uncertain' });
    expect(uncertainty.store.getState()).toEqual({ active: true, acknowledged: false });
  });
});
