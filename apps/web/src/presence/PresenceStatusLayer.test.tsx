import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { PresenceStatusView } from './PresenceStatusLayer.js';

describe('PresenceStatusView', () => {
  it('keeps the solo state truthful and offers only explicit reconnect', () => {
    const markup = renderToStaticMarkup(
      <PresenceStatusView state={{ status: 'unavailable', canReconnect: true }} onReconnect={vi.fn()} />,
    );
    expect(markup).toContain('Multiplayer unavailable');
    expect(markup).toContain('playing solo');
    expect(markup).toContain('Reconnect multiplayer');
    expect(markup).not.toContain('ws://');
    expect(markup).not.toContain('error');
  });

  it('renders status alongside caller-owned World and visit surfaces', () => {
    const markup = renderToStaticMarkup(
      <main className="strkworld">
        <div data-testid="world-host" />
        <div data-testid="visit-surface">Bank</div>
        <PresenceStatusView state={{ status: 'unavailable', canReconnect: false }} onReconnect={vi.fn()} />
      </main>,
    );
    expect(markup).toContain('data-testid="world-host"');
    expect(markup).toContain('data-testid="visit-surface"');
    expect(markup).toContain('Multiplayer unavailable');
  });
});
