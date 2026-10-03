import type { EventBus } from '@strkworld/shared';
import type { LobbyClientOptions, LobbyStatusEvent, PeerSnapshot } from '@strkworld/lobby/client';
import { NO_SEAT } from '@strkworld/shared';
import type { AvatarSpriteKey, Facing, PresenceArea, WorldEvents } from '@strkworld/shared';
import {
  DEFAULT_AVATAR_SPRITE,
  createRemotePeerSource,
  isAvatarSpriteKey,
  type RemotePeerSnapshot,
  type FootballChannel,
  type RemotePeerSource,
  type SandboxChannel,
} from '@strkworld/world';
import { LobbyClient } from '@strkworld/lobby/client';
import { ownMovementPayload, ownSharedAreaBuildingPayload } from '../bus/world-event-payload.js';
import type { ArenaShellChannel } from '../arena/arena-controller.js';
import type { PitchShellChannel } from '../pitch/pitch-controller.js';
import type { SwingShellChannel } from '../roof/swing-controller.js';

export type PresenceAvailability = 'connecting' | 'connected' | 'suspended' | 'unavailable';
export interface PresenceState { readonly status: PresenceAvailability; readonly canReconnect: boolean; }
export interface PresenceClient {
  connect(): Promise<void>;
  /**
   * D-127: `seat` claims a bench seat with the position — an index into
   * `STREET_SEATS`, or -1 standing. A client that ignores the argument simply
   * never shows anyone sitting.
   */
  updatePosition(x: number, y: number, facing: Facing, seat?: number): void;
  suspend(): void;
  resume(placement: { x: number; y: number; facing: Facing }, sprite: AvatarSpriteKey): void;
  /**
   * D-087: go live in a presence area. Optional: a client without it keeps
   * the player solo (suspended) in the shared rooms too, the safe fallback.
   */
  enterArea?(area: PresenceArea, placement: { x: number; y: number; facing: Facing }, sprite: AvatarSpriteKey): void;
  /**
   * D-097: the avatar jumped. Optional: a client without it shows no one the
   * jump. The client sends it only while live in a shared area: the street,
   * the roof, the Studio (D-111) or the bunker (D-112).
   */
  jump?(): boolean;
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
  /** The shared block sandbox (D-060), when the composition provides one. */
  readonly sandbox?: SandboxChannel;
  /** The shared football (D-078), when the composition provides one. */
  readonly football?: FootballChannel;
  /** The gladiator pit's ring (D-114), when the composition provides one. */
  readonly arena?: ArenaShellChannel;
  /** D-135: the gated pitch's match, for the HUD and the World's gate prompts. */
  readonly pitch?: PitchShellChannel;
  /** The Exchange roof's lookout swing (D-133), when the composition provides one. */
  readonly roofSwing?: SwingShellChannel;
  reconnect(): void;
  destroy(): Promise<void>;
}

function freezePresenceState(next: PresenceState): PresenceState {
  return Object.freeze({ ...next });
}

/**
 * D-087: the shared rooms, the roof and the Studio, and since D-112 the
 * bunker. Every other interior is a private solo instance.
 */
type SharedArea = Exclude<PresenceArea, 'street'>;

export function createPresenceController({ endpoint, factory = (options) => new LobbyClient(options), sandbox, football, arena, pitch, roofSwing }: { endpoint?: string; factory?: PresenceFactory; sandbox?: SandboxChannel; football?: FootballChannel; arena?: ArenaShellChannel; pitch?: PitchShellChannel; roofSwing?: SwingShellChannel }): PresenceController {
  let state: PresenceState = freezePresenceState({ status: 'unavailable', canReconnect: Boolean(endpoint) });
  let client: PresenceClient | null = null;
  let clientSprite: AvatarSpriteKey | null = null;
  let placement: { x: number; y: number; facing: Facing } | null = null;
  /**
   * D-127: the bench seat the World last reported with the street placement, or
   * -1. Kept beside the placement rather than in it, because a resume and an
   * area switch are teleports and never carry a seat.
   */
  let placementSeat = NO_SEAT;
  let currentSprite: AvatarSpriteKey = DEFAULT_AVATAR_SPRITE;
  let inside = false;
  /**
   * D-087. `sharedArea` is the shared room the World says the player is in
   * (inside is then true too), `areaPlacement` where they stand there, and
   * `clientArea` the shared room the owned client is live in — null on the
   * street, while suspended, and whenever the state is not connected.
   */
  let sharedArea: SharedArea | null = null;
  let areaPlacement: { x: number; y: number; facing: Facing } | null = null;
  let clientArea: SharedArea | null = null;
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
    // A client that is not live is in no area; a shared-area join names its
    // area before it reports connected.
    if (next.status !== 'connected') clientArea = null;
    state = freezePresenceState(next);
    // Deliver one transition to the subscriptions that owned its snapshot.
    // A replacement of the same function is a new subscription generation.
    for (const [listener, token] of [...listeners]) {
      if (listeners.get(listener) !== token) continue;
      try {
        listener();
      } catch {
        // A state consumer must not turn a successful transport handoff into
        // a failed connection or prevent later consumers from observing it.
        console.error('presence controller: state subscriber threw');
      }
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
        // Live in the shared room the World put the player in (D-087): this
        // is that join reporting in.
        if (clientArea !== null && clientArea === sharedArea) {
          setState({ status: 'connected', canReconnect: true });
          return;
        }
        const ownedClient = client;
        if (ownedClient && joinSharedArea(ownedClient)) return;
        if (ownedClient && client === ownedClient && state.status !== 'suspended') {
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
    let ownedClient: PresenceClient;
    try {
      ownedClient = factory({
        endpoint,
        start: placement ?? { x: 0, y: 0, facing: 'down' },
        sprite,
      });
    } catch {
      if (setupOwner === owner) setupOwner = null;
      return null;
    }
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
          peerChannel.publish(snapshot.map(({ gameId, x, y, facing, sprite, carrying, jumps, seat }) => ({ id: gameId, x, y, facing, sprite, carrying, jumps, seat })));
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
        let staleDisconnect: Promise<void>;
        try {
          staleDisconnect = Promise.resolve(next.disconnect());
        } catch {
          staleDisconnect = Promise.resolve();
        }
        const finishReplacement = () => {
          // An explicit replacement remains authoritative even when the old
          // transport cannot confirm its disconnect.
          if (!destroyed) connect();
        };
        return staleDisconnect.then(finishReplacement, finishReplacement);
      }
      if (!inside && client === next && clientSprite !== currentSprite) {
        replaceStaleClient();
        return;
      }
      if (inside) {
        if (state.status === 'unavailable') return;
        // D-087: the player walked into a shared room while the join was in
        // flight; go live there rather than suspend.
        if (clientArea !== null && clientArea === sharedArea && state.status === 'connected') {
          if (settlingOwner === owner) settlingOwner = null;
          return;
        }
        if (joinSharedArea(next)) {
          if (settlingOwner === owner) settlingOwner = null;
          return;
        }
        if (client !== next || owner.retired) return;
        if (state.status !== 'suspended') {
          next.suspend();
          if (client !== next || owner.retired) return;
        }
        setState({ status: 'suspended', canReconnect: true });
      } else if (state.status === 'connecting') {
        sendPlacement(next, placement!, placementSeat);
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
  /**
   * Report the street placement, naming the seat only while the player sits on
   * one (D-127): a standing player's call is the three-argument one it always
   * was, so a client that never heard of seats is unaffected.
   */
  const sendPlacement = (
    target: PresenceClient | null,
    at: { x: number; y: number; facing: Facing },
    seat: number,
  ) => {
    if (!target) return;
    if (seat >= 0) target.updatePosition(at.x, at.y, at.facing, seat);
    else target.updatePosition(at.x, at.y, at.facing);
  };
  const onMoved = (value: WorldEvents['player:moved']) => {
    const owned = ownMovementPayload(value);
    if (!owned) return;
    const { position, facing, seat } = owned;
    placement = { x: position.x, y: position.y, facing };
    placementSeat = seat;
    if (inside) return;
    if (state.status === 'connected') sendPlacement(client, placement, seat);
    else if (!hasAttempted) {
      hasAttempted = true;
      // A reconnect click may have happened before the first placement. The
      // placement itself is the first safe point at which to join, so consume
      // that request when the normal first join starts.
      reconnectRequested = false;
      connect();
    }
  };
  /** Retire a client whose lifecycle command threw, so the Shell can offer a fresh join. */
  const retireFailedClient = (ownedClient: PresenceClient) => {
    deactivateClientStatus();
    try {
      clearClientPeers();
    } catch {
      // Preserve the command failure while still retiring the owner.
    }
    client = null;
    clientSprite = null;
    try {
      void Promise.resolve(ownedClient.disconnect()).catch(() => undefined);
    } catch {
      // The command failure remains the actionable error.
    }
    setState({ status: 'unavailable', canReconnect: Boolean(endpoint) });
  };
  /**
   * D-087: put the owned client live in the shared room the World has placed
   * the player in. False, doing nothing, when there is no such room, no
   * placement for it yet, a client that cannot share, or a client that is
   * neither live nor suspended; the caller then keeps the player solo.
   */
  const joinSharedArea = (ownedClient: PresenceClient): boolean => {
    const area = sharedArea;
    const at = areaPlacement;
    if (!inside || area === null || at === null || typeof ownedClient.enterArea !== 'function') return false;
    if (client !== ownedClient || (state.status !== 'connected' && state.status !== 'suspended')) return false;
    if (clientArea === area && state.status === 'connected') return true;
    const generation = statusGeneration;
    clientArea = area;
    try {
      ownedClient.enterArea(area, at, currentSprite);
    } catch (error) {
      if (client === ownedClient && statusGeneration === generation) retireFailedClient(ownedClient);
      throw error;
    }
    if (client !== ownedClient || statusGeneration !== generation || clientArea !== area) return false;
    clientSprite = currentSprite;
    setState({ status: 'connected', canReconnect: true });
    // The `connected` delivery may itself have moved the player on.
    return client === ownedClient && clientArea === area;
  };
  /**
   * D-087: leave a shared room. To the street (the Studio's portal, the
   * bunker's stair, or a release from the roof that skipped its exit) the client goes live there
   * at the street placement; back into a private interior (the lift down from
   * the roof) it suspends.
   */
  const leaveSharedArea = (to: 'street' | 'interior') => {
    const ownedClient = client;
    const was = clientArea;
    sharedArea = null;
    areaPlacement = null;
    if (!ownedClient || was === null || state.status !== 'connected') return false;
    const generation = statusGeneration;
    try {
      if (to === 'street') {
        if (!placement || typeof ownedClient.enterArea !== 'function') return false;
        ownedClient.enterArea('street', placement, currentSprite);
      } else {
        ownedClient.suspend();
      }
    } catch (error) {
      if (client === ownedClient && statusGeneration === generation) retireFailedClient(ownedClient);
      throw error;
    }
    if (client !== ownedClient || statusGeneration !== generation) return true;
    clientArea = null;
    if (to === 'street') {
      clientSprite = currentSprite;
      reconnectRequested = false;
      setState({ status: 'connected', canReconnect: true });
    } else {
      setState({ status: 'suspended', canReconnect: true });
    }
    return true;
  };
  // D-097: a cosmetic jump, forwarded while connected. The client itself
  // refuses while suspended (a private interior), where it plays solo.
  const onJumped = () => {
    const ownedClient = client;
    if (!ownedClient || state.status !== 'connected' || typeof ownedClient.jump !== 'function') return;
    ownedClient.jump();
  };
  const onAreaMoved = (value: WorldEvents['area:moved']) => {
    const owned = ownMovementPayload(value);
    if (!owned) return;
    const { position, facing } = owned;
    // D-127: a shared room's seats are its own and never reach the lobby, so
    // an area placement is always a standing one.
    areaPlacement = { x: position.x, y: position.y, facing };
    const ownedClient = client;
    if (!ownedClient || sharedArea === null) return;
    if (clientArea === sharedArea && state.status === 'connected') {
      ownedClient.updatePosition(position.x, position.y, facing);
    } else if (clientArea === null) {
      // The room was announced before its first placement arrived.
      joinSharedArea(ownedClient);
    }
  };
  const onSharedEntered = (area: SharedArea) => {
    inside = true;
    sharedArea = area;
    const ownedClient = client;
    if (ownedClient && joinSharedArea(ownedClient)) return;
    // No placement yet, or a client that cannot share: solo until it can.
    // (The roof's building entry has already suspended.)
    if (area !== 'roof') onEntered();
  };
  /**
   * Any building's door. D-112: the bunker's whole interior is a shared
   * area, so the client goes live there; every other building suspends.
   */
  const onBuildingEntered = (value: WorldEvents['building:entered']) => {
    const area = ownSharedAreaBuildingPayload(value);
    if (area !== null && area !== 'street') onSharedEntered(area);
    else onEntered();
  };
  const onEntered = () => {
    inside = true;
    const ownedClient = client;
    if (ownedClient && state.status === 'connected') {
      const generation = statusGeneration;
      try {
        ownedClient.suspend();
      } catch (error) {
        // A failed suspend leaves the avatar on the street. Retire this
        // client so an interior visit cannot keep broadcasting its last
        // street position; only do so if the command did not already trigger
        // a newer lifecycle transition of its own.
        if (client === ownedClient && statusGeneration === generation && state.status === 'connected') {
          inside = true;
          deactivateClientStatus();
          try {
            clearClientPeers();
          } catch {
            // Preserve the command failure while still retiring the owner.
          }
          client = null;
          clientSprite = null;
          try {
            void Promise.resolve(ownedClient.disconnect()).catch(() => undefined);
          } catch {
            // The command failure remains the actionable error; the owner is
            // already retired even if transport cleanup rejects synchronously.
          }
          setState({ status: 'unavailable', canReconnect: Boolean(endpoint) });
        }
        throw error;
      }
      if (client !== ownedClient || statusGeneration !== generation) return;
      setState({ status: 'suspended', canReconnect: true });
    }
  };
  const onAvatarSelected = ({ sprite }: WorldEvents['avatar:selected']) => {
    if (!isAvatarSpriteKey(sprite)) return;
    currentSprite = sprite;
    // D-087: in a shared room, others see the new look at once: the client
    // re-enters the same area with it.
    const ownedClient = client;
    if (
      ownedClient && clientArea !== null && clientArea === sharedArea && areaPlacement &&
      state.status === 'connected' && typeof ownedClient.enterArea === 'function'
    ) {
      const generation = statusGeneration;
      try {
        ownedClient.enterArea(clientArea, areaPlacement, sprite);
      } catch (error) {
        if (client === ownedClient && statusGeneration === generation) retireFailedClient(ownedClient);
        throw error;
      }
      if (client === ownedClient) clientSprite = sprite;
    }
  };
  const onRooftopExited = () => {
    if (sharedArea !== 'roof') return;
    // Down the lift into the building's private floors, or (a release) about
    // to leave the building, whose exit then resumes the street.
    leaveSharedArea('interior');
  };
  const onStudioExited = () => {
    if (sharedArea === 'studio' && clientArea === 'studio') {
      inside = false;
      if (leaveSharedArea('street')) return;
    }
    sharedArea = null;
    areaPlacement = null;
    onExited();
  };
  const onBuildingExited = () => {
    // Up the bunker's stair (D-112), or a release from the roof that did not
    // announce leaving it (D-087): straight back live on the street.
    if (sharedArea !== null && sharedArea !== 'studio' && clientArea === sharedArea) {
      inside = false;
      if (leaveSharedArea('street')) return;
    }
    sharedArea = null;
    areaPlacement = null;
    onExited();
  };
  const onExited = () => {
    inside = false;
    const ownedClient = client;
    if (ownedClient && state.status === 'suspended' && placement) {
      const generation = statusGeneration;
      try {
        ownedClient.resume(placement, currentSprite);
      } catch (error) {
        // A failed resume leaves the avatar absent from the lobby, but the
        // suspended state has no reconnect affordance. Retire this client so
        // the shell can offer an explicit fresh join; only do so if the
        // command did not already trigger a newer lifecycle transition.
        if (client === ownedClient && statusGeneration === generation && state.status === 'suspended') {
          deactivateClientStatus();
          try {
            clearClientPeers();
          } catch {
            // Preserve the command failure while still retiring the owner.
          }
          client = null;
          clientSprite = null;
          try {
            void Promise.resolve(ownedClient.disconnect()).catch(() => undefined);
          } catch {
            // The command failure remains actionable after owner retirement.
          }
          setState({ status: 'unavailable', canReconnect: Boolean(endpoint) });
        }
        throw error;
      }
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
        stops.push(world.on('building:entered', onBuildingEntered));
        stops.push(world.on('building:exited', onBuildingExited));
        // D-087: the Studio and the Exchange roof are shared presence areas,
        // and the bunker (D-112, through its building events); every other
        // interior suspends.
        stops.push(world.on('avatar-studio:entered', () => onSharedEntered('studio')));
        stops.push(world.on('avatar-studio:exited', onStudioExited));
        stops.push(world.on('rooftop:entered', () => onSharedEntered('roof')));
        stops.push(world.on('rooftop:exited', onRooftopExited));
        stops.push(world.on('area:moved', onAreaMoved));
        stops.push(world.on('avatar:selected', onAvatarSelected));
        stops.push(world.on('player:jumped', onJumped));
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
    ...(sandbox ? { sandbox } : {}),
    ...(football ? { football } : {}),
    ...(arena ? { arena } : {}),
    ...(pitch ? { pitch } : {}),
    ...(roofSwing ? { roofSwing } : {}),
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
      const synchronousFailures: unknown[] = [];
      try {
        statusStop?.();
      } catch (error) {
        // Listener removal belongs to cleanup, but a host subscription may
        // throw. Keep retiring the transport and report the failure after all
        // owned resources have had their cleanup attempted.
        synchronousFailures.push(error);
      }
      statusStop = null;
      try {
        clearClientPeers();
      } catch (error) {
        // A peer subscriber or unsubscribe can throw during the final clear;
        // it must not strand the client or skip its disconnect.
        synchronousFailures.push(error);
      }
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
        failures.unshift(...synchronousFailures);
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) {
          throw new AggregateError(failures, 'Presence cleanup failed.');
        }
      });
      await destroying;
    },
  });
}
