import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createEventBus } from './bus/event-bus.js';
import type { ShellEvents, WorldEvents } from '@strkworld/shared';
import { FakePrivacyOperations } from '@strkworld/privacy';
import { COPY } from './copy.js';
import { App } from './App.js';
import { createPresenceController } from './presence/presence-controller.js';

/**
 * The composition root composes.
 *
 * Static rendering runs no effects, so the demo seam's dynamic import has not
 * resolved and the world has not booted Phaser — which is exactly the mount
 * instant this asserts: the tree wires together and shows its boot state
 * without throwing, and crucially the demo path does **not** trip the
 * production gate under the test runner (a Vite dev context). The event-driven
 * visit state and event behaviour is covered by `visit-controller.test.ts`;
 * Game Mode, station windows and Menu Mode rendering are covered by
 * `VisitLayer.test.tsx`. This is the seam between them.
 */
describe('App', () => {
  it('mounts to its boot state without throwing, demo gate not tripped', () => {
    const worldOut = createEventBus<WorldEvents>();
    const shellIn = createEventBus<ShellEvents>();
    const markup = renderToStaticMarkup(
      <App worldOut={worldOut} shellIn={shellIn} presence={createPresenceController({})} />,
    );
    expect(markup).toContain(COPY.boot);
    // The production refusal would surface here if the dev gate were wrong.
    expect(markup).not.toContain(COPY.productionNotWired);
    expect(markup).not.toContain('must never ship');
    // The injected unavailable controller does not replace the provider's
    // normal boot composition; it is inert until the real tree mounts.
    expect(markup).not.toContain('Multiplayer unavailable');
  });

  it('composes the supplied financial seam instead of the local demo', () => {
    const worldOut = createEventBus<WorldEvents>();
    const shellIn = createEventBus<ShellEvents>();
    const markup = renderToStaticMarkup(
      <App
        worldOut={worldOut}
        shellIn={shellIn}
        presence={createPresenceController({})}
        operations={new FakePrivacyOperations()}
      />,
    );

    expect(markup).toContain('class="strkworld"');
    expect(markup).toContain('data-testid="world-host"');
    expect(markup).not.toContain(COPY.boot);
  });
});
