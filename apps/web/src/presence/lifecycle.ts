import type { PresenceController } from './presence-controller.js';

export interface PageLifecycleHost {
  addEventListener(type: 'pagehide', listener: (event?: { persisted?: boolean }) => void, options?: { once?: boolean }): void;
  removeEventListener(type: 'pagehide', listener: (event?: { persisted?: boolean }) => void): void;
}

export interface HotLifecycleHost {
  dispose(callback: () => void): void;
}

/** Explicit production teardown; React StrictMode never calls this helper. */
export function installPresenceTeardown(
  presence: PresenceController,
  page?: PageLifecycleHost,
  hot?: HotLifecycleHost,
): () => void {
  let cleaned = false;
  const teardown = (event?: { persisted?: boolean }) => {
    if (event?.persisted || cleaned) return;
    cleaned = true;
    page?.removeEventListener('pagehide', teardown);
    void presence.destroy().catch(() => {});
  };
  page?.addEventListener('pagehide', teardown);
  hot?.dispose(teardown);
  return () => {
    if (cleaned) return;
    cleaned = true;
    page?.removeEventListener('pagehide', teardown);
  };
}
