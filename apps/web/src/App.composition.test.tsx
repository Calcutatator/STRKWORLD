import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { createEventBus } from './bus/event-bus.js';
import type { ShellEvents, WorldEvents } from '@strkworld/shared';
import { createPresenceController } from './presence/presence-controller.js';

const worldHostProps = vi.hoisted(() => ({ current: undefined as { remotePeers?: unknown; vaultOpen?: boolean } | undefined }));

vi.mock('./privacy/PrivacyProvider.js', () => ({
  PrivacyProvider: ({ children }: { children: ReactNode }) => children,
  // No provider, so no status to read: the HUD waits for the bus, as in its own tests.
  useWalletStatusSnapshot: () => null,
}));
vi.mock('./privacy/SessionNoticeLayer.js', () => ({ SessionNoticeLayer: () => null }));
// The entry gate (D-072) has its own composition tests (`App.entry.test.tsx`);
// here it stands open so the presence wiring behind it can be inspected.
vi.mock('./connect/EntryGate.js', () => ({
  SeamEntryGate: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('./world/WorldHost.js', () => ({
  WorldHost: (props: { remotePeers?: unknown; vaultOpen?: boolean }) => {
    worldHostProps.current = props;
    return <div data-testid="actual-world-host">world surface</div>;
  },
}));
vi.mock('./visits/VisitLayer.js', () => ({
  VisitLayer: () => <div data-testid="actual-visit-surface">visit surface</div>,
}));

import { App } from './App.js';

describe('App presence composition', () => {
  it('keeps World and Visit surfaces mounted beside truthful solo status', () => {
    const worldOut = createEventBus<WorldEvents>();
    const shellIn = createEventBus<ShellEvents>();
    const markup = renderToStaticMarkup(
      <App worldOut={worldOut} shellIn={shellIn} presence={createPresenceController({})} />,
    );
    expect(markup).toContain('data-testid="actual-world-host"');
    expect(markup).toContain('data-testid="actual-visit-surface"');
    expect(markup).toContain('Multiplayer unavailable');
    expect(markup).toContain('playing solo');
  });

  it('passes the stable World-owned peer source through the composition root', () => {
    const worldOut = createEventBus<WorldEvents>();
    const shellIn = createEventBus<ShellEvents>();
    const presence = createPresenceController({});
    renderToStaticMarkup(<App worldOut={worldOut} shellIn={shellIn} presence={presence} />);

    expect(worldHostProps.current?.remotePeers).toBe(presence.remotePeers);
  });

  it('tells the World whether the Vault door opens, from the register and this build (D-077)', async () => {
    const worldOut = createEventBus<WorldEvents>();
    const shellIn = createEventBus<ShellEvents>();
    renderToStaticMarkup(<App worldOut={worldOut} shellIn={shellIn} presence={createPresenceController({})} />);
    // Outside production there is no policy: the register approves both
    // routes, so the demo's World opens the Vault. Production follows
    // `VITE_STRK20_VAULT_*` through the same function (routes.test.ts).
    const { vaultDoorOpen } = await import('./panels/routes.js');
    expect(worldHostProps.current?.vaultOpen).toBe(vaultDoorOpen());
    expect(worldHostProps.current?.vaultOpen).toBe(true);
  });
});
