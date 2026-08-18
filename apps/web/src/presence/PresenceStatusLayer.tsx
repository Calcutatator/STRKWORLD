import { useEffect, useSyncExternalStore } from 'react';
import { COPY } from '../copy.js';
import type { PresenceController, PresenceState } from './presence-controller.js';
import type { EventBus } from '@strkworld/shared';
import type { WorldEvents } from '@strkworld/shared';

export function PresenceStatusLayer({ presence, world }: { presence: PresenceController; world: EventBus<WorldEvents> }) {
  useEffect(() => presence.listen(world), [presence, world]);
  const state = useSyncExternalStore(
    (listener) => presence.subscribe(listener),
    presence.getState,
    presence.getState,
  );
  return <PresenceStatusView state={state} onReconnect={() => presence.reconnect()} />;
}

export function PresenceStatusView({ state, onReconnect }: { state: PresenceState; onReconnect: () => void }) {
  if (state.status === 'unavailable') {
    return (
      <aside className="presence-status presence-unavailable" role="status">
        <span>{COPY.presence.unavailable}</span>
        {state.canReconnect ? <button type="button" onClick={onReconnect}>{COPY.presence.reconnect}</button> : null}
      </aside>
    );
  }
  return <aside className="presence-status" role="status">{COPY.presence[state.status]}</aside>;
}
