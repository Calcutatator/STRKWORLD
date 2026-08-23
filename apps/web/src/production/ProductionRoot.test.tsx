import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { FakePrivacyOperations, type WalletSession } from '@strkworld/privacy';
import { createEventBus } from '../bus/event-bus.js';
import type { ShellEvents, WorldEvents } from '@strkworld/shared';
import { createPresenceController } from '../presence/presence-controller.js';

const captured = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }));
vi.mock('../App.js', () => ({
  App: (props: Record<string, unknown>) => {
    captured.current = props;
    return <div>production app</div>;
  },
}));

import { ProductionRoot } from './ProductionRoot.js';

describe('ProductionRoot', () => {
  it('injects one session as operations and the Bridge account authority', () => {
    const operations = new FakePrivacyOperations();
    const session = sessionAt('0xabc', operations);
    renderToStaticMarkup(
      <ProductionRoot
        session={session}
        worldOut={createEventBus<WorldEvents>()}
        shellIn={createEventBus<ShellEvents>()}
        presence={createPresenceController({})}
      />,
    );

    expect(captured.current?.operations).toBe(operations);
    expect(captured.current?.walletSession).toBe(session);
    expect(captured.current?.bridge).toMatchObject({ account: '0xabc', planner: null });
    expect((captured.current?.bridge as { readAccount(): string | null }).readAccount()).toBe('0xabc');
  });
});

function sessionAt(account: string, operations: FakePrivacyOperations): WalletSession {
  const snapshot = {
    phase: 'connected' as const,
    wallets: [],
    selectedKey: 'wallet-1',
    account,
    generation: 1,
  };
  return {
    operations,
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    connect: async () => snapshot,
    refreshDiscovery: () => undefined,
    readAccount: () => account,
    disconnect: async () => undefined,
    destroy: () => undefined,
  };
}
