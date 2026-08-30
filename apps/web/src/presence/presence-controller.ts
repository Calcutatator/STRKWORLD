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

function freezePresenceState(next: PresenceState): PresenceState {
  return Object.freeze({ ...next });
}

export function createPresenceController({ endpoint, factory = (options) => new LobbyClient(options) }: { endpoint?: string; factory?: PresenceFactory }): PresenceController {
  let state: PresenceState = freezePresenceState({ status: 'unavailable', canReconnect: Boolean(endpoint) });
  let client: PresenceClient | null = null;
  let clientSprite: AvatarSpriteKey | null = null;
  let placement: { x: number; y: number; facing: Facing } | null = null;
  let currentSprite: AvatarSpriteKey = DEFAULT_AVATAR_SPRITE;
  let inside = false;
  let reconnectRequested = false;
  let hasAttempted = false;
  let connecting: { readonly client: PresenceClient; retired: boolean } | null = null;
  let settlingOwner: { readonly client: PresenceClient; retired: boolean } | null = null;
  let destroyed = false;
  let statusStop: (() => void) | null = null;
  let peerStop: (() => void) | null = null;
  let destroying: Promise<void> | null = null;
  let replacing: Promise<void> | null = null;
  let replacementDeferred = false;
  let setupOwner: { retired: boolean } | null = null;
  let statusGeneration = 0;
  let unavailableDepth = 0;
  const listeners = new Map<() => void, symbol>();
  const peerChannel = createRemotePeerSource();
  const peerSource = peerChannel.source;
  const clearPeers = () => peerChannel.clear();
  const clearClientPeers = () => {
    peerStop?.();
    peerStop = null;
    clearPeers();
  };
  const deactivateClientStatus = () => {
    const stop = statusStop;
    statusStop = null;
    try {
      stop?.();
    } catch {
      // A status cleanup failure must not leave the failed client authoritative
      // or mask the connect failure.
    }
  };
  const setState = (next: PresenceState) => {
    if (destroyed) return;
    state = freezePresenceState(next);
    // Deliver one transition to the subscriptions that owned its snapshot.
    // A replacement of the same function is a new subscription generation.
    for (const [listener, token] of [...listeners]) {
      if (listeners.get(listener) === token) listener();
    }
  };
  const unavailable = () => {
    if (destroyed) return;
    unavailableDepth += 1;
    try {
      try {
        clearClientPeers();
      } catch {
        // A remote-peer subscriber must not block the presence state from
        // becoming unavailable after the client has dropped.
      }
      try {
        setState({ status: 'unavailable', canReconnect: Boolean(endpoint) });
      } catch {
        // State is assigned before subscriber delivery; keep the drop closed
        // even if a consumer callback fails during that notification.
      }
    } finally {
      unavailableDepth -= 1;
    }
    // A peer or state subscriber may synchronously request a reconnect while
    // the failed owner's cleanup is publishing its empty snapshot. Hold that
    // request until the unavailable transition has completed, so it retires
    // the failed client instead of starting another join on the same owner.
    if (
      unavailableDepth === 0 && reconnectRequested && !inside && placement && !connecting
    ) {
      reconnectRequested = false;
      if (client && state.status === 'unavailable') replaceStaleClient();
      else connect();
    }
  };
  const onStatus = (event: LobbyStatusEvent) => {
    if (destroyed) return;
    if (event.status === 'connected') {
      if (inside) {
        const ownedClient = client;
        if (ownedClient && state.status !== 'suspended') {
          ownedClient.suspend();
          if (client !== ownedClient || state.status === 'unavailable') return;
        }
        setState({ status: 'suspended', canReconnect: true });
      } else setState({ status: 'connected', canReconnect: true });
    }
    else if (event.status === 'connecting') setState({ status: 'connecting', canReconnect: true });
    else if (event.status === 'suspended') setState({ status: 'suspended', canReconnect: true });
    else if (event.status === 'closed' || event.status === 'idle') {
      if (event.status === 'closed' && connecting?.client === client) {
        connecting.retired = true;
        connecting = null;
      }
      if (event.status === 'closed' && settlingOwner?.client === client) settlingOwner.retired = true;
      if (event.status === 'closed' && setupOwner) setupOwner.retired = true;
      if (event.status === 'closed') statusGeneration += 1;
      if (event.status === 'idle' || event.reason !== 'client-left') unavailable();
      else clearClientPeers();
    }
  };
  const ensureClient = () => {
    if (!endpoint || destroyed || client) return client;
    const sprite = currentSprite;
    const owner = { retired: false };
    setupOwner = owner;
    const ownedClient = factory({
      endpoint,
      start: placement ?? { x: 0, y: 0, facing: 'down' },
      sprite,
    });
    client = ownedClient;
    clientSprite = sprite;
    let installingStatus = true;
    let initialStatusPending = true;
    let statusActive = true;
    let stopStatus: (() => void) | null = null;
    const retireSetup = (): void => {
      owner.retired = true;
      if (setupOwner === owner) setupOwner = null;
      if (client !== ownedClient) return;
      client = null;
      clientSprite = null;
      try {
        clearPeers();
      } catch {
        // Preserve the setup failure; a failed source notification must not
        // strand the failed client as the active presence owner.
      }
      try {
        setState({ status: 'unavailable', canReconnect: Boolean(endpoint) });
      } catch {
        // Preserve the setup failure after state has been retired. Subscriber
        // failures must not undo the ownership rollback.
      }
    };
    try {
      stopStatus = ownedClient.onStatus((event) => {
        if (!statusActive || destroyed || client !== ownedClient) return;
        // LobbyClient replays exactly one current-status snapshot on subscribe.
        // A stale client may legitimately replay `closed` before an explicit
        // reconnect, so only that first synchronous callback lacks transition
        // authority. Any later callback during setup is a real reentrant event.
        if (installingStatus && initialStatusPending) {
          initialStatusPending = false;
          return;
        }
        onStatus(event);
      });
    } catch (error) {
      statusActive = false;
      stopStatus?.();
      retireSetup();
      throw error;
    }
    installingStatus = false;
    if (destroyed || client !== ownedClient || owner.retired) {
      stopStatus?.();
      if (setupOwner === owner) setupOwner = null;
      if (client === ownedClient) {
        client = null;
        clientSprite = null;
      }
      return null;
    }
    statusStop = () => {
      statusActive = false;
      stopStatus?.();
    };
    let active = true;
    let stopPeers: (() => void) | null = null;
    try {
      stopPeers = ownedClient.onPeers((snapshot) => {
        if (active && !destroyed && client === ownedClient) {
          peerChannel.publish(snapshot.map(({ gameId, x, y, facing, sprite }) => ({ id: gameId, x, y, facing, sprite })));
        }
      });
    } catch (error) {
      active = false;
      try {
        statusStop?.();
      } catch {
        // Preserve the peer setup error and continue retiring this owner.
      }
      statusStop = null;
      retireSetup();
      throw error;
    }
    peerStop = () => {
      active = false;
      stopPeers?.();
    };
    if (destroyed || client !== ownedClient || owner.retired) {
      peerStop();
      peerStop = null;
      statusStop?.();
      statusStop = null;
      if (setupOwner === owner) setupOwner = null;
      if (client === ownedClient) {
        client = null;
        clientSprite = null;
      }
      return null;
    }
    if (setupOwner === owner) setupOwner = null;
    return ownedClient;
  };
  const connect = () => {
    if (!endpoint || destroyed || inside || !placement || connecting) return;
    const next = ensureClient();
    if (!next) return;
    if (client !== next) return;
    const owner = { client: next, retired: false };
    connecting = owner;
    setState({ status: 'connecting', canReconnect: true });
    if (destroyed || connecting !== owner || owner.retired || client !== next) return;
    let attempt: Promise<void>;
    try {
      attempt = next.connect();
    } catch {
      if (connecting === owner) connecting = null;
      deactivateClientStatus();
      if (!owner.retired && !destroyed) unavailable();
      return;
    }
    void attempt.then(() => {
      if (connecting === owner) connecting = null;
      if (owner.retired) return;
      settlingOwner = owner;
      if (destroyed) return next.disconnect();
      if (reconnectRequested && !inside) {
        reconnectRequested = false;
        deactivateClientStatus();
        try {
          clearClientPeers();
        } catch {
          // A stale peer subscriber must not block the requested replacement.
        }
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
        if (state.status !== 'suspended') {
          next.suspend();
          if (client !== next || owner.retired) return;
        }
        setState({ status: 'suspended', canReconnect: true });
      } else if (state.status === 'connecting') {
        next.updatePosition(placement!.x, placement!.y, placement!.facing);
        setState({ status: 'connected', canReconnect: true });
      }
      if (settlingOwner === owner) settlingOwner = null;
    }).catch(() => {
      if (connecting === owner) connecting = null;
      if (settlingOwner === owner) settlingOwner = null;
      if (owner.retired) return;
      if (destroyed) return;
      deactivateClientStatus();
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
  const onEntered = () => {
    inside = true;
    const ownedClient = client;
    if (ownedClient && state.status === 'connected') {
      const generation = statusGeneration;
      ownedClient.suspend();
      if (client !== ownedClient || statusGeneration !== generation) return;
      setState({ status: 'suspended', canReconnect: true });
    }
  };
  const onAvatarSelected = ({ sprite }: WorldEvents['avatar:selected']) => {
    if (isAvatarSpriteKey(sprite)) currentSprite = sprite;
  };
  const onExited = () => {
    inside = false;
    const ownedClient = client;
    if (ownedClient && state.status === 'suspended' && placement) {
      const generation = statusGeneration;
      ownedClient.resume(placement, currentSprite);
      if (client !== ownedClient || statusGeneration !== generation) return;
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
    try {
      statusStop?.();
    } catch {
      // A stale listener cleanup must not block the explicit replacement.
    }
    statusStop = null;
    try {
      clearClientPeers();
    } catch {
      // Continue retiring the stale client even if a peer subscriber throws.
    }
    peerStop = null;
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
  return Object.freeze<PresenceController>({
    listen(world) {
      const stops: Array<() => void> = [];
      const stop = () => {
        let cleanupFailure: unknown;
        for (const unsubscribe of stops.splice(0)) {
          try {
            unsubscribe();
          } catch (error) {
            cleanupFailure ??= error;
          }
        }
        if (cleanupFailure) throw cleanupFailure;
      };
      try {
        stops.push(world.on('player:moved', onMoved));
        stops.push(world.on('building:entered', onEntered));
        stops.push(world.on('building:exited', onExited));
        stops.push(world.on('avatar-studio:entered', onEntered));
        stops.push(world.on('avatar-studio:exited', onExited));
        stops.push(world.on('avatar:selected', onAvatarSelected));
        return stop;
      } catch (error) {
        try {
          stop();
        } catch {
          // Preserve the listener registration error; cleanup is best effort.
        }
        throw error;
      }
    },
    subscribe(listener) {
      const token = Symbol();
      listeners.set(listener, token);
      return () => {
        if (listeners.get(listener) === token) listeners.delete(listener);
      };
    },
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
      if (!placement || unavailableDepth > 0) return;
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
      const currentDisconnect = current
        ? (() => {
          try {
            return Promise.resolve(current.disconnect());
          } catch (error) {
            return Promise.reject(error);
          }
        })()
        : Promise.resolve();
      destroying = Promise.allSettled([
        currentDisconnect,
        replacing ?? Promise.resolve(),
      ]).then((results) => {
        client = null;
        clientSprite = null;
        replacementDeferred = false;
        listeners.clear();
        const failures = results
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map((result) => result.reason);
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
          throw new AggregateError(failures, 'Presence cleanup failed.');
        }
      });
      await destroying;
    },
  });
}
