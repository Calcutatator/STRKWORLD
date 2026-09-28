import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DegenCatalogSource } from './degen-catalog.js';
import { DegenCatalogProvider, useDegenCatalog } from './DegenCatalogProvider.js';

/**
 * Composition of the degen list (D-067): production hands in the backend
 * source, the demo loads its static list lazily, and the demo list is refused
 * in a production build like every other demo seam.
 */

function capture(node: (captured: { source: DegenCatalogSource | null }) => ReactElement) {
  const captured: { source: DegenCatalogSource | null } = { source: null };
  renderToStaticMarkup(node(captured));
  return captured.source;
}

function Probe({ into }: { into: { source: DegenCatalogSource | null } }) {
  into.source = useDegenCatalog();
  return null;
}

describe('DegenCatalogProvider', () => {
  it('hands the production source through unchanged', () => {
    const source: DegenCatalogSource = { load: async () => ({ origin: 'live', listings: [] }) };
    expect(capture((into) => <DegenCatalogProvider source={source}><Probe into={into} /></DegenCatalogProvider>)).toBe(source);
  });

  it('has no list at all without a source or the demo', () => {
    expect(capture((into) => <DegenCatalogProvider><Probe into={into} /></DegenCatalogProvider>)).toBeNull();
    expect(capture((into) => <Probe into={into} />)).toBeNull();
  });

  it('loads the demo list lazily outside production', async () => {
    const source = capture((into) => (
      <DegenCatalogProvider demo build={{ production: false }}><Probe into={into} /></DegenCatalogProvider>
    ));
    expect(source).not.toBeNull();
    const snapshot = await source!.load();
    expect(snapshot.origin).toBe('demo');
    const provider = readFileSync(new URL('./DegenCatalogProvider.tsx', import.meta.url), 'utf8');
    expect(provider).toContain("import('../../privacy/demo-degen.js')");
    expect(provider).not.toMatch(/^import [^;]*demo-degen/m);
  });

  it('refuses the demo list in a production build', () => {
    expect(() => renderToStaticMarkup(
      <DegenCatalogProvider demo build={{ production: true }}><span /></DegenCatalogProvider>,
    )).toThrow('The demo degen list must never ship.');
  });
});
