import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { FakePrivacyOperations } from '@strkworld/privacy';
import { PrivacyProvider, usePrivacy } from './PrivacyProvider.js';

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
});
