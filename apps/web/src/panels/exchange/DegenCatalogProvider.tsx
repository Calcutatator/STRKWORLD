import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { detectBuildContext, type BuildContext } from '../../privacy/build-context.js';
import type { DegenCatalogSnapshot, DegenCatalogSource } from './degen-catalog.js';

/**
 * Where the degen floor's list comes from (D-067), composed like the privacy
 * seam: production supplies the backend source, the demo loads its static
 * list lazily, and the demo list is refused outright in a production build.
 * With neither, the degen counter says its list is unavailable.
 */

const DegenCatalogContext = createContext<DegenCatalogSource | null>(null);

export function useDegenCatalog(): DegenCatalogSource | null {
  return useContext(DegenCatalogContext);
}

/** The demo list sits behind a dynamic import, so it never joins the entry chunk. */
const DEMO_DEGEN_SOURCE: DegenCatalogSource = Object.freeze({
  async load(signal?: AbortSignal): Promise<DegenCatalogSnapshot> {
    const { DEMO_DEGEN_CATALOG } = await import('../../privacy/demo-degen.js');
    return DEMO_DEGEN_CATALOG.load(signal);
  },
});

export function DegenCatalogProvider({
  source,
  demo = false,
  build,
  children,
}: {
  /** The production list, from the same-origin backend. */
  source?: DegenCatalogSource;
  /** Use the demo list. Never true in a production build. */
  demo?: boolean;
  build?: BuildContext;
  children: ReactNode;
}) {
  const demoRejected = !source && demo && (build ?? detectBuildContext()).production;
  const value = useMemo(
    () => source ?? (demo && !demoRejected ? DEMO_DEGEN_SOURCE : null),
    [source, demo, demoRejected],
  );
  if (demoRejected) {
    throw new Error('<DegenCatalogProvider demo> reached a production build. The demo degen list must never ship.');
  }
  return <DegenCatalogContext.Provider value={value}>{children}</DegenCatalogContext.Provider>;
}
