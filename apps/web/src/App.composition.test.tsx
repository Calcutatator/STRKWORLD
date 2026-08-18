import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactNode } from 'react';
import { createEventBus } from './bus/event-bus.js';
import type { ShellEvents, WorldEvents } from '@strkworld/shared';
import { createPresenceController } from './presence/presence-controller.js';

vi.mock('./privacy/PrivacyProvider.js', () => ({
  PrivacyProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('./privacy/SessionNoticeLayer.js', () => ({ SessionNoticeLayer: () => null }));
vi.mock('./world/WorldHost.js', () => ({
  WorldHost: () => <div data-testid="actual-world-host">world surface</div>,
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
});
