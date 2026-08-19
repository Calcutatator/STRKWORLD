import type { EventBus } from '@strkworld/shared';
import type { LobbyClientOptions, LobbyStatusEvent, PeerSnapshot } from '@strkworld/lobby/client';
import type { AvatarSpriteKey, Facing, WorldEvents } from '@strkworld/shared';
import {
  DEFAULT_AVATAR_SPRITE,
  createRemotePeerSource,
  isAvatarSpriteKey,
  type RemotePeerSnapshot,
  type RemotePeerSource,
} from '@strkworld/world';
import { LobbyClient } from '@strkworld/lobby/client';

export type PresenceAvailability = 'connecting' | 'connected' | 'suspended' | 'unavailable';
export interface PresenceState { readonly status: PresenceAvailability; readonly canReconnect: boolean; }
export interface PresenceClient {
  connect(): Promise<void>;
  updatePosition(x: number, y: number, facing: Facing): void;
  suspend(): void;
  resume(placement: { x: number; y: number; facing: Facing }, sprite: AvatarSpriteKey): void;
  disconnect(): Promise<void>;
  onStatus(listener: (event: LobbyStatusEvent) => void): () => void;
  onPeers(listener: (peers: readonly PeerSnapshot[]) => void): () => void;
}
export type PresenceFactory = (options: LobbyClientOptions) => PresenceClient;
export interface PresenceController {
  listen(world: EventBus<WorldEvents>): () => void;
  subscribe(listener: () => void): () => void;
  getState(): PresenceState;
  readonly remotePeers: RemotePeerSource;
  reconnect(): void;
  destroy(): Promise<void>;
}

export function createPresenceController({ endpoint, factory = (options) => new LobbyClient(options) }: { endpoint?: string; factory?: PresenceFactory }): PresenceController {
  let state: PresenceState = { status: endpoint ? 'unavailable' : 'unavailable', canReconnect: Boolean(endpoint) };
  let client: PresenceClient | null = null;
  let clientSprite: AvatarSpriteKey | null = null;
  let placement: { x: number; y: number; facing: Facing } | null = null;
  let currentSprite: AvatarSpriteKey = DEFAULT_AVATAR_SPRITE;
  let inside = false;
  let reconnectRequested = false;
  let hasAttempted = false;
  let connecting: Promise<void> | null = null;
  let destroyed = false;
  let statusStop: (() => void) | null = null;
  let peerStop: (() => void) | null = null;
  let destroying: Promise<void> | null = null;
  let replacing: Promise<void> | null = null;
  let replacementDeferred = false;
  const listeners = new Set<() => void>();
  const peerChannel = createRemotePeerSource();
  const peerSource = peerChannel.source;
  const clearPeers = () => peerChannel.clear();
  const clearClientPeers = () => {
    peerStop?.();
    peerStop = null;
    clearPeers();
  };
  const setState = (next: PresenceState) => {
    if (destroyed) return;
    state = next;
    for (const listener of listeners) listener();
  };
  const unavailable = () => {
    if (destroyed) return;
    clearClientPeers();
    setState({ status: 'unavailable', canReconnect: Boolean(endpoint) });
  };
  const onStatus = (event: LobbyStatusEvent) => {
    if (destroyed) return;
    if (event.status === 'connected') {
      if (inside) {
        if (client && state.status !== 'suspended') client.suspend();
        setState({ status: 'suspended', canReconnect: true });
      } else setState({ status: 'connected', canReconnect: true });
    }
    else if (event.status === 'connecting') setState({ status: 'connecting', canReconnect: true });
    else if (event.status === 'suspended') setState({ status: 'suspended', canReconnect: true });
    else if (event.status === 'closed' || event.status === 'idle') {
      if (event.status === 'idle' || event.reason !== 'client-left') unavailable();
      else clearClientPeers();
    }
  };
  const ensureClient = () => {
    if (!endpoint || destroyed || client) return client;
    const sprite = currentSprite;
    client = factory({
      endpoint,
      start: placement ?? { x: 0, y: 0, facing: 'down' },
      sprite,
    });
    clientSprite = sprite;
    statusStop = client.onStatus(onStatus);
    const ownedClient = client;
    let active = true;
    const stopPeers = ownedClient.onPeers((snapshot) => {
      if (active && !destroyed && client === ownedClient) {
        peerChannel.publish(snapshot.map(({ gameId, x, y, facing, sprite }) => ({ id: gameId, x, y, facing, sprite })));
      }
    });
    peerStop = () => {
      active = false;
      stopPeers();
    };
    return client;
  };
  const connect = () => {
    if (!endpoint || destroyed || inside || !placement || connecting) return;
    const next = ensureClient();
    if (!next) return;
    setState({ status: 'connecting', canReconnect: true });
    connecting = next.connect().then(() => {
      connecting = null;
      if (destroyed) return next.disconnect();
      if (reconnectRequested && !inside) {
        reconnectRequested = false;
        statusStop?.();
        statusStop = null;
        clearClientPeers();
        client = null;
        clientSprite = null;
        return next.disconnect().then(() => {
          if (!destroyed) connect();
        });
      }
      if (!inside && client === next && clientSprite !== currentSprite) {
        replaceStaleClient();
        return;
      }
      if (inside) {
        if (state.status === 'unavailable') return;
        if (state.status !== 'suspended') next.suspend();
        setState({ status: 'suspended', canReconnect: true });
      } else if (state.status === 'connecting') {
        next.updatePosition(placement!.x, placement!.y, placement!.facing);
        setState({ status: 'connected', canReconnect: true });
      }
    }).catch(() => {
      connecting = null;
      if (destroyed) return;
      unavailable();
      // LobbyClient reports `idle` before a failed join's promise rejects.
      // A reconnect click in that window is therefore explicit intent to
      // replace this failed client; otherwise the request would remain stuck
      // until another movement or click despite the visible reconnect action.
      if (reconnectRequested && !inside && placement) {
        reconnectRequested = false;
        replaceStaleClient();
      }
    });
  };
  const onMoved = ({ position, facing }: WorldEvents['player:moved']) => {
    placement = { x: position.x, y: position.y, facing };
    if (inside) return;
    if (state.status === 'connected') client?.updatePosition(position.x, position.y, facing);
    else if (!hasAttempted) {
      hasAttempted = true;
      // A reconnect click may have happened before the first placement. The
      // placement itself is the first safe point at which to join, so consume
      // that request when the normal first join starts.
      reconnectRequested = false;
      connect();
    }
  };
  const onEntered = () => { inside = true; if (client && state.status === 'connected') { client.suspend(); setState({ status: 'suspended', canReconnect: true }); } };
  const onAvatarSelected = ({ sprite }: WorldEvents['avatar:selected']) => {
    if (isAvatarSpriteKey(sprite)) currentSprite = sprite;
  };
  const onExited = () => {
    inside = false;
    if (client && state.status === 'suspended' && placement) {
      client.resume(placement, currentSprite);
      clientSprite = currentSprite;
      reconnectRequested = false;
      setState({ status: 'connected', canReconnect: true });
    } else if (replacementDeferred) {
      replacementDeferred = false;
      connect();
    } else if (reconnectRequested) {
      if (replacing) return;
      if (!connecting) {
        reconnectRequested = false;
        if (client && state.status === 'unavailable') replaceStaleClient();
        else connect();
      }
    }
  };
  const replaceStaleClient = () => {
    if (replacing || replacementDeferred || destroyed) return;
    const stale = client;
    statusStop?.();
    statusStop = null;
    clearClientPeers();
    client = null;
    clientSprite = null;
    replacing = (async () => {
      try { await stale?.disconnect(); } catch { /* reconnect remains explicit */ }
      if (!destroyed) {
        if (inside) replacementDeferred = true;
        else connect();
      }
    })().finally(() => { replacing = null; });
  };
  return {
    listen(world) {
      const stops = [
        world.on('player:moved', onMoved),
        world.on('building:entered', onEntered),
        world.on('building:exited', onExited),
        world.on('avatar-studio:entered', onEntered),
        world.on('avatar-studio:exited', onExited),
        world.on('avatar:selected', onAvatarSelected),
      ];
      return () => stops.forEach((stop) => stop());
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    remotePeers: peerSource,
    getState: () => state,
    reconnect() {
      if (!endpoint || destroyed) return;
      // An active or interior-deferred replacement already represents exactly
      // this intent. Re-queueing the click would replace its fresh client once
      // more when that planned join settles.
      if (replacing || replacementDeferred) return;
      // Keep the request even when the World has not supplied a street
      // placement yet. We must not invent coordinates, but the button must
      // also not become a silent no-op: the first real placement (or a later
      // exit after one) will carry out the reconnect.
      reconnectRequested = true;
      if (!placement) return;
      if (!inside && !connecting) {
        reconnectRequested = false;
        if (client && state.status === 'unavailable') replaceStaleClient();
        else connect();
      }
    },
    async destroy() {
      if (destroying) return destroying;
      if (destroyed) return;
      destroyed = true;
      statusStop?.();
      statusStop = null;
      clearClientPeers();
      const current = client;
      destroying = Promise.all([
        current ? current.disconnect() : Promise.resolve(),
        replacing ?? Promise.resolve(),
      ]).then(() => undefined);
      await destroying;
      client = null;
      clientSprite = null;
      replacementDeferred = false;
      listeners.clear();
    },
  };
}
