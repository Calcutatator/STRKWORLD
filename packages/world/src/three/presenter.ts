import { Group, type Object3D, type Vector3 } from 'three';
import { type AvatarSpriteKey, type BuildingId, type Facing, type GameId, type SandboxColumn } from '@strkworld/shared';
import { createStreetMap } from '../map/street.js';
import { ARENA_GATE_TARGET_ID } from '../arena-session.js';
import {
  FIXED_ROOM_LEVELS,
  createFixedRoom,
  createFixedRoomLevel,
  fixedRoomDefinitionsFor,
  type FixedRoomLevelId,
  type FixedRoomStationPresentation,
} from '../fixed-room.js';
import { AVATAR_STUDIO_DEFINITION } from '../avatar-studio.js';
import { DEFAULT_AVATAR_SPRITE } from '../avatar-state.js';
import { ROOM_ORIGIN } from '../world-layout.js';
import type { RemotePeerSource } from '../remote-peer.js';
import type { PlayerMotion, WorldRect, WorldSessionView } from '../world-session.js';
import { isSandboxTile } from '../sandbox-channel.js';
import { FLAT_SANDBOX, createSandboxHeights, levelUnderBody, type SandboxHeights } from '../sandbox.js';
import { buildSandbox, createCarriedBlock, type SandboxView } from './sandbox-view.js';
import { buildFootball, type FootballView } from './football-view.js';
import { avatarFigureHeight } from './avatar-figure.js';
import { buildStreet, streetSurfaceHeightAt } from './street-builder.js';
import { buildFixedRoom } from './room-builder.js';
import { arenaSurfaceHeightAt, type ArenaRoomView } from './arena-room.js';
import { createArenaFx, type ArenaFx, type RemoteSwingPort } from './arena-fx.js';
import type { ArenaViewFrame } from '../arena-channel.js';
// D-114: one swing timeline and one seat rule, shared with the remote layer (C's arena-swing.ts).
import { ARENA_SEAT_IDLE_MS, attackPoseAt, isArenaSeatAt } from '../arena-swing.js';
import { buildAvatarStudio } from './studio-builder.js';
import {
  REMOTE_FALL_GRAVITY,
  REMOTE_HOP_MS,
  createRemoteAvatarLayer3D,
  hopHeight,
  type RemoteAvatarLayer3D,
} from './remote-avatars.js';
import { angleDelta, directionToYaw, pixelToGround, PIXELS_PER_UNIT, type GroundPoint } from './coords.js';
import type { CameraBounds, CameraPresetId } from './camera-rig.js';
import { segmentHitsBox } from './occlusion.js';
import { JUMP_HEIGHT, JUMP_TOTAL_MS, REDUCED_JUMP_HEIGHT, jumpLift, jumpPose } from '../jump.js';
import { createJumpShadow } from './jump-shadow.js';
import { EMPTY_PLAZA_STATS } from '../plaza-stations.js';
import { advanceAffordanceClock, createAffordanceShells, type AffordanceSet } from './affordance.js';
import type {
  AttackPose,
  AvatarFigure,
  AvatarFigureFactory,
  ImageTextureLoader,
  LabelFactory,
  Occluder,
  RoomView,
  StreetView,
  StudioView,
  TextLabel,
} from './types.js';

/**
 * The 3D presentation of one World (D-059).
 *
 * It owns the static district, the room interiors (the Vault's too, once the
 * Shell opens it, D-077), the Avatar Studio and the local avatar for the
 * lifetime of the renderer, and a remote-avatar layer per session. Sessions
 * talk to it only through `WorldSessionView`, so every decision — collision,
 * doors, stations, rollback — stays in the session and this module only
 * mirrors the outcome.
 */

export interface PresenterOptions {
  readonly parent: Object3D;
  readonly labels: LabelFactory;
  readonly figures: AvatarFigureFactory;
  /** Decodes bundled art such as the Degen floor's posters; without it they stay procedural. */
  readonly images?: ImageTextureLoader;
  /**
   * Whether the player asked for less motion (`prefers-reduced-motion`),
   * read at each sandbox burst: its blocks then pop out instead of flying.
   * The football's GOAL! and FULL TIME read it too, and hold still (D-078).
   * A jump reads it at take-off: a smaller hop, and the body keeps its shape
   * (D-097).
   */
  readonly reducedMotion?: () => boolean;
  /**
   * The Vault opens on shadow accounts, behind the Shell's switch (D-077):
   * its door is drawn open and its room is built. Absent or false, it is
   * D-007's locked facade and no Vault room exists. Every session this
   * presenter binds must be created with the same value.
   */
  readonly vaultOpen?: boolean;
  /** Leaderboard phase 1: the placement stand east of the plaza. Sessions must match it too. */
  readonly placementStand?: boolean;
  /**
   * D-129: a coarse-pointer screen (a phone). The arena's surround then
   * leaves out the water south of it, which the north-looking camera (D-059)
   * can never show. Read once, when the rooms are built.
   */
  readonly lowDetail?: boolean;
}

/** The presenter implements every view method, the optional sandbox ones included. */
export interface SessionView extends Required<WorldSessionView> {
  destroy(): void;
}

export interface Presenter {
  /**
   * Local avatar feet in world units, its presented yaw and the presented
   * height of the blocks it stands on (D-060), which the camera follows.
   */
  readonly player: { readonly ground: GroundPoint; readonly yaw: number; readonly elevation: number };
  /**
   * D-097: how high the local avatar is in a jump right now, world units; 0
   * on the ground. The camera does not follow it, so the hop reads.
   */
  readonly jumpLift: number;
  readonly cameraBounds: CameraBounds | null;
  /** How the camera frames the player: level with the street, or looking down from a roof. */
  readonly cameraPreset: CameraPresetId;
  /** True once after a teleport, so the camera can jump instead of easing. */
  consumeSnap(): boolean;
  /** Start presenting a new session; retires the previous session's view. */
  bindSession(remotePeers?: RemotePeerSource): SessionView;
  update(deltaMs: number): void;
  /** Fade whatever stands between the camera and the local avatar. */
  updateOcclusion(camera: Vector3, deltaMs: number): void;
  /**
   * D-123: give a station drawn outside the stock builders (a ring gate, a
   * leaderboard stand) the same cues as a counter: `object`'s meshes, as
   * they stand now, shimmer while it is shown, and glow while the session's
   * interaction target has this `id` (or carries this `object`). Returns its
   * removal. Builders that merge their pieces should rather record them into
   * their own `AffordanceShells` under the target's id, as the plaza does.
   */
  registerAffordance(id: string, object: Object3D): () => void;
  dispose(): void;
}

/** Radians per second the avatar turns towards its heading. */
const MAX_TURN_RATE = 14;
const OCCLUDED_OPACITY = 0.22;
const FADE_TIME_CONSTANT_MS = 90;
/** Sample the line of sight at the avatar's chest and head. */
const SIGHT_HEIGHTS = [0.7, 1.25] as const;
/**
 * The local avatar hops and falls exactly like remote ones (remote-avatars.ts):
 * one block up is a parabola peaking just above the landing; a taller rise —
 * stacks growing underneath — lands at once; drops fall under gravity.
 */
const MAX_HOP_RISE = 1.5;
/** A carried block rides this far above the carrier's head. */
const CARRY_CLEARANCE = 0.36;
/** The gameplay body half-width in world units (24 px / 32 px per unit). */
const BODY_HALF_UNITS = 12 / PIXELS_PER_UNIT;
/** D-114: the arena prompt over the local avatar ("E · ENTER THE RING"). */
const ARENA_PROMPT_STYLE = Object.freeze({
  lineHeight: 0.26,
  foreground: '#FFF6E6',
  background: 'rgba(36,18,10,0.9)',
  border: '#F56A16',
  font: 'sans',
  cornerRadius: 0.35,
} as const);
const FACING_YAW: Readonly<Record<Facing, number>> = Object.freeze({
  down: 0,
  up: Math.PI,
  left: -Math.PI / 2,
  right: Math.PI / 2,
});

/**
 * D-114: the walking-surface height inside a room, in world units, at `x`,
 * `z` (world units). Interiors are flat except the arena, whose stairs and
 * tiers are walkable surfaces at a height (`arenaSurfaceHeightAt`).
 */
export function roomSurfaceHeightAt(room: string | null, x: number, z: number): number {
  if (room !== 'arena') return 0;
  const tileX = Math.floor(x - ROOM_ORIGIN.x / PIXELS_PER_UNIT);
  const tileY = Math.floor(z - ROOM_ORIGIN.y / PIXELS_PER_UNIT);
  return arenaSurfaceHeightAt(tileX, tileY);
}

/**
 * A building's roof deck height above the street, in world units, if `x`, `z`
 * (world units, one per street tile) lie over its roof's footprint; null
 * otherwise, and for a building without a roof.
 */
function rooftopHeightAt(building: BuildingId, x: number, z: number): number | null {
  for (const level of FIXED_ROOM_LEVELS[building] ?? []) {
    const roof = level.rooftop;
    if (!roof) continue;
    const over = x >= roof.x && z >= roof.y && x < roof.x + level.width && z < roof.y + level.height;
    return over ? roof.height : null;
  }
  return null;
}

/** Which interior a floor is drawn as: the ground floor by its building, others by floor. */
function roomKey(building: BuildingId, level?: FixedRoomLevelId): string {
  return level === undefined || level === 'ground' ? building : `${building}:${level}`;
}

export function createPresenter(options: PresenterOptions): Presenter {
  const root = new Group();
  root.name = 'strkworld';
  const disposers: Array<() => void> = [];

  const vaultOpen = options.vaultOpen === true;
  const streetMap = createStreetMap({ vaultOpen, placementStand: options.placementStand === true });
  const street: StreetView = buildStreet(
    streetMap,
    options.labels,
    options.reducedMotion ? { reducedMotion: options.reducedMotion } : {},
  );
  // Pavement is raised; stand feet on it. Interiors and the Studio floor are
  // flat, except the arena's stairs and tiers (D-114, `roomSurfaceHeightAt`).
  // On the sandbox, anyone stands on the tallest stack their body
  // overlaps — the same rule the session applies to the local player.
  // Reused probe: the remote layer asks this every frame for every peer.
  const probe = { x: 0, y: 0 };
  const streetHeight = (x: number, z: number): number => {
    probe.x = x * PIXELS_PER_UNIT;
    probe.y = z * PIXELS_PER_UNIT;
    const level = levelUnderBody(sandboxHeights, probe, BODY_HALF_UNITS * PIXELS_PER_UNIT, PIXELS_PER_UNIT);
    if (level > 0) return level;
    if (isSandboxTile(Math.floor(x), Math.floor(z))) return 0;
    return streetSurfaceHeightAt(streetMap, x, z);
  };
  disposers.push(() => street.dispose());
  root.add(street.ground, street.doors, street.labels);
  /**
   * Where a remote peer stands (D-087). On a roof the lobby sends the roof's
   * players and the street's passers-by below, and never a street player
   * over the tower's footprint, so a peer over the footprint is on the deck
   * and any other is on the street. Off a roof the lobby sends only the
   * player's own area: the street's surface, a flat floor indoors and in
   * the Studio, or the arena's sand, stairs and tiers (D-114).
   */
  const remoteHeight = (x: number, z: number): number => {
    if (rooftop !== null) {
      const deck = rooftopHeightAt(rooftop, x, z);
      if (deck !== null) return deck;
    }
    return streetVisible ? streetHeight(x, z) : roomSurfaceHeightAt(visibleRoom, x, z);
  };

  // Every interior, keyed by `roomKey`: each ground floor (the Vault's only
  // when it is open, D-077), and floors reached by lift. A roof is not here:
  // it is the building's top in the street.
  const rooms = new Map<string, RoomView>();
  const addRoom = (key: string, room: RoomView): void => {
    room.group.visible = false;
    rooms.set(key, room);
    root.add(room.group);
    disposers.push(() => room.dispose());
  };
  const images = options.images ?? null;
  // D-107: the hidden room's flickering tube holds steady for reduced motion.
  const roomOptions = {
    ...(options.reducedMotion ? { reducedMotion: options.reducedMotion } : {}),
    ...(options.lowDetail === true ? { lowDetail: true } : {}),
  };
  // D-114: the arena is a big room most sessions never enter, so it is built
  // the first time it is shown, not with the street.
  const lazyRooms = new Map<string, () => RoomView>();
  for (const definition of fixedRoomDefinitionsFor({ vaultOpen })) {
    if (definition.building === 'arena') {
      lazyRooms.set(roomKey(definition.building), () =>
        buildFixedRoom(createFixedRoom(definition), options.labels, ROOM_ORIGIN, images, roomOptions),
      );
      continue;
    }
    addRoom(roomKey(definition.building), buildFixedRoom(createFixedRoom(definition), options.labels, ROOM_ORIGIN, images, roomOptions));
    for (const level of FIXED_ROOM_LEVELS[definition.building] ?? []) {
      if (level.rooftop) continue;
      addRoom(
        roomKey(definition.building, level.level),
        buildFixedRoom(createFixedRoomLevel(level), options.labels, ROOM_ORIGIN, images, roomOptions),
      );
    }
  }

  // D-114: the arena's combat feedback (C's arena-fx.ts), mounted in the
  // arena's room once that is built, so it shows and hides with it.
  let arenaRoom: ArenaRoomView | null = null;
  const arenaFx: ArenaFx = createArenaFx({
    reducedMotion: () => {
      try {
        return options.reducedMotion?.() === true;
      } catch {
        return false;
      }
    },
    /*
     * D-128: where the blocked spark goes. Only the fighter's own client
     * knows where it stands in the room's frame; a spectator's fx falls back
     * to the ring spawn.
     */
    fighterAt: () =>
      !streetVisible && visibleRoom === 'arena' && arenaFrame?.selfIsChallenger === true
        ? { x: ground.x, z: ground.z }
        : null,
  });
  disposers.push(() => {
    arenaFx.group.removeFromParent();
    arenaFx.dispose();
  });

  /** The last stations each building was drawn with, for a room built later. */
  const lastStations = new Map<BuildingId, readonly FixedRoomStationPresentation[]>();
  let arenaGate: 'open' | 'busy' = 'open';
  /** A room's view, building a lazy one (the arena) on first use. */
  const ensureRoom = (key: string): RoomView | undefined => {
    const existing = rooms.get(key);
    if (existing) return existing;
    const build = lazyRooms.get(key);
    if (!build) return undefined;
    lazyRooms.delete(key);
    const room = build();
    addRoom(key, room);
    // D-123: a room built late brings its counters' shimmer and glow along.
    if (room.affordances) affordanceSets.push(room.affordances);
    const stations = lastStations.get(room.building);
    if (stations) room.setStations(stations);
    if (key === 'arena') {
      arenaRoom = room as ArenaRoomView;
      arenaRoom.fxMount?.add(arenaFx.group);
      arenaRoom.setGate?.(arenaGate);
      // D-123: the ring gate is the arena's station: it shimmers while the
      // ring is free, and glows when the gate station is the target (by id
      // `arena:gate`, or by carrying the gate object).
      if (arenaRoom.gate) registerObject(ARENA_GATE_TARGET_ID, arenaRoom.gate)?.setUsable(ARENA_GATE_TARGET_ID, arenaGate === 'open');
    }
    return room;
  };

  const studio: StudioView = buildAvatarStudio(AVATAR_STUDIO_DEFINITION, options.figures, options.labels);
  studio.sync({ visible: false, highlightedFigure: null });
  root.add(studio.group);
  disposers.push(() => studio.dispose());

  const avatar: AvatarFigure = options.figures(DEFAULT_AVATAR_SPRITE);
  root.add(avatar.object);
  disposers.push(() => avatar.dispose());

  // The block sandbox (D-060): shared stacks, and the block the player holds.
  const sandbox: SandboxView = buildSandbox({ reducedMotion: options.reducedMotion });
  root.add(sandbox.group);
  disposers.push(() => sandbox.dispose());
  // The football (D-078): the shared ball, its prompt and the pitch's moments.
  const football: FootballView = buildFootball({ labels: options.labels, reducedMotion: options.reducedMotion });
  root.add(football.group);
  disposers.push(() => football.dispose());
  const carried = createCarriedBlock(null);
  avatar.object.add(carried.object);
  const placeCarried = (): void => {
    carried.object.position.set(0, avatarFigureHeight(avatar.look) + CARRY_CLEARANCE, 0);
  };
  placeCarried();
  disposers.push(() => {
    carried.object.parent?.remove(carried.object);
    carried.dispose();
  });

  // D-123: what says "use me" now that the floor does not: every usable
  // station's affordance shell (shimmer from afar, edge glow on the target).
  // The stock areas build their own; a station drawn elsewhere registers its
  // object here (`registerAffordance`), or arrives on a target as `object`.
  const extraAffordances = new Map<Object3D, AffordanceSet>();
  const affordanceSets: AffordanceSet[] = [];
  if (street.plaza?.affordances) affordanceSets.push(street.plaza.affordances);
  for (const room of rooms.values()) if (room.affordances) affordanceSets.push(room.affordances);
  if (studio.affordances) affordanceSets.push(studio.affordances);
  const allAffordances = (): Iterable<AffordanceSet> => affordanceSets;
  const registerObject = (id: string, object: Object3D): AffordanceSet | null => {
    const known = extraAffordances.get(object);
    if (known) return known;
    const shells = createAffordanceShells();
    shells.addObject(id, object, object);
    const set = shells.build(`affordance:${id}`);
    if (!set) return null;
    object.add(set.mesh);
    set.setUsable(id, true);
    extraAffordances.set(object, set);
    affordanceSets.push(set);
    return set;
  };
  const unregisterObject = (object: Object3D): void => {
    const set = extraAffordances.get(object);
    if (!set) return;
    extraAffordances.delete(object);
    const index = affordanceSets.indexOf(set);
    if (index >= 0) affordanceSets.splice(index, 1);
    set.dispose();
  };
  disposers.push(() => {
    for (const object of [...extraAffordances.keys()]) unregisterObject(object);
  });
  /** The id the interaction system chose, glowing in whichever area holds it. */
  const focusAffordance = (id: string | null, object: unknown): void => {
    // A target carrying its object glows that object, whatever id it was registered under.
    const carried = id !== null && isObject3D(object) ? registerObject(id, object) : null;
    for (const set of allAffordances()) {
      if (set === carried) set.focus(set.ids[0] ?? null);
      else set.focus(id !== null && set.has(id) ? id : null);
    }
  };
  // Reduced motion, read about once a second: a media query read every
  // frame would allocate, and the setting changes rarely.
  let reducedMotionNow = false;
  let reducedMotionAge = Infinity;
  const readReducedMotion = (dt: number): boolean => {
    reducedMotionAge += dt;
    if (reducedMotionAge >= 1000) {
      reducedMotionAge = 0;
      try {
        reducedMotionNow = options.reducedMotion?.() === true;
      } catch {
        reducedMotionNow = false;
      }
    }
    return reducedMotionNow;
  };

  // D-097: the local avatar's jump shadow, on the ground under it.
  const jumpShadow = createJumpShadow();
  root.add(jumpShadow.object);
  disposers.push(() => jumpShadow.dispose());

  options.parent.add(root);

  let ground: GroundPoint = { x: 0, z: 0 };
  let feet = 0;
  let yaw = 0;
  let sandboxHeights: SandboxHeights = FLAT_SANDBOX;
  let elevationTarget = 0;
  let elevationShown = 0;
  let fallSpeed = 0;
  let hop: { from: number; to: number; elapsed: number } | null = null;
  /** D-097: time since the local avatar took off, or null on the ground. */
  let jumpElapsed: number | null = null;
  let jumpHeight = JUMP_HEIGHT;
  let jumpSquash = true;
  let lift = 0;
  /**
   * D-106: this jump stepped up onto a stack. The climb's hop carries the
   * figure from where the jump had it onto the top, so the rest of the arc
   * adds no lift: the pose plays on, and the feet land on the block.
   */
  let jumpClimbed = false;
  /**
   * D-106 (amended with D-097's block-high jump): how far the ground rose
   * under this jump when it climbed with the feet already above the block
   * top. The arc carries on from where it had the feet, measured from the
   * new ground, so the hang is kept and the figure lands on the block.
   */
  let jumpRaise = 0;
  let targetYaw = 0;
  /** D-114: time since the local avatar's arena swing began, or null. */
  let swingElapsed: number | null = null;
  /** D-114: the last ring frame: the fighter holds the battle stance. */
  let arenaFrame: ArenaViewFrame | null = null;
  /** D-114: how long the local avatar has stood still on an arena tier. */
  let idleOnTier = 0;
  /** D-127: the session says the local avatar is sitting on a bench. */
  let benchSeated = false;
  let arenaPrompt: TextLabel | null = null;
  let motion: PlayerMotion = { vx: 0, vy: 0, sprinting: false };
  let pendingSnap = true;
  let cameraBounds: CameraBounds | null = null;
  let streetVisible = true;
  let remoteVisible = true;
  let visibleRoom: string | null = null;
  /** The roof the player stands on, if any: the street stays drawn below it. */
  let rooftop: BuildingId | null = null;
  let studioVisible = false;
  let remote: RemoteAvatarLayer3D | null = null;
  let sessionToken = 0;
  let disposed = false;
  const opacity = new Map<Occluder, number>();

  const resetPresentation = (): void => {
    street.ground.visible = true;
    street.doors.visible = true;
    street.labels.visible = true;
    streetVisible = true;
    remoteVisible = true;
    visibleRoom = null;
    rooftop = null;
    for (const room of rooms.values()) room.group.visible = false;
    studioVisible = false;
    studio.sync({ visible: false, highlightedFigure: null });
    motion = { vx: 0, vy: 0, sprinting: false };
    pendingSnap = true;
    // A new session replays its own sandbox snapshot; start from flat ground.
    sandbox.group.visible = true;
    sandbox.setColumns([]);
    sandbox.setTarget(null);
    sandboxHeights = FLAT_SANDBOX;
    carried.setColour(null);
    // The target's glow belongs to the session that chose it (D-117,
    // D-123), and so do the plaza's figures (D-076).
    focusAffordance(null, null);
    street.plaza?.setStats(EMPTY_PLAZA_STATS);
    // So do the ball, its prompt, the pitch's moments and the scoreboard (D-078).
    football.group.visible = true;
    football.reset();
    street.pitch?.setScore(0, 0);
    elevationTarget = 0;
    elevationShown = 0;
    fallSpeed = 0;
    hop = null;
    jumpElapsed = null;
    lift = 0;
    jumpClimbed = false;
    jumpRaise = 0;
    jumpShadow.place(0, 0, 0, 0);
    // The arena's frame, prompt and swing belong to the session that set them (D-114).
    swingElapsed = null;
    arenaFrame = null;
    idleOnTier = 0;
    // D-127: a seat belongs to the session that sat down on it.
    benchSeated = false;
    if (arenaPrompt) arenaPrompt.object.visible = false;
    arenaGate = 'open';
    arenaRoom?.setGate('open');
    arenaFx.sync(null, null);
  };

  /** D-114: peers' swings, through the remote layer once it can play them (C). */
  /**
   * D-114: peers' swings and the fighter's battle stance, through the remote
   * layer once it can show them (C's remote-avatars.ts). Optional members are
   * read at call time, so the port works with any layer.
   */
  const remoteSwings = (): RemoteSwingPort | null => {
    const layer = remote as
      | (RemoteAvatarLayer3D & {
          playSwing?: (gameId: GameId) => void;
          setFighter?: (gameId: GameId | null) => void;
          setBlocker?: (gameId: GameId | null) => void;
          setThroned?: (gameId: GameId | null) => void;
        })
      | null;
    if (!layer) return null;
    const port = {
      playSwing(gameId: GameId) {
        layer.playSwing?.(gameId);
      },
      setFighter(gameId: GameId | null) {
        layer.setFighter?.(gameId);
      },
      // D-128: a peer's block stance and the champion's throne.
      setBlocker(gameId: GameId | null) {
        layer.setBlocker?.(gameId);
      },
      setThroned(gameId: GameId | null) {
        layer.setThroned?.(gameId);
      },
    };
    return port;
  };

  /**
   * D-114: whether a World pixel point is an arena seat (a tier tile), while
   * the arena is the room shown: remote spectators standing still there sit.
   */
  const arenaSeatAt = (xPx: number, yPx: number): boolean => {
    if (streetVisible || visibleRoom !== 'arena' || !Number.isFinite(xPx) || !Number.isFinite(yPx)) return false;
    // The Studio and the bunker share the arena's pixels: the room gate above keeps them apart.
    return isArenaSeatAt(xPx, yPx);
  };

  const retireRemote = (): void => {
    const layer = remote;
    remote = null;
    if (!layer) return;
    root.remove(layer.group);
    layer.destroy();
  };

  /** Where the local avatar's feet stand in the room it is in: 0 except on the arena's stairs and tiers. */
  const roomFeet = (): number => (streetVisible ? 0 : roomSurfaceHeightAt(visibleRoom, ground.x, ground.z));

  const visibleOccluders = (): readonly Occluder[] => {
    const active: Occluder[] = [];
    if (streetVisible) active.push(...street.occluders);
    if (visibleRoom) active.push(...(rooms.get(visibleRoom)?.occluders ?? []));
    if (studioVisible) active.push(...studio.occluders);
    return active;
  };

  return {
    get player() {
      // Indoors the camera follows the feet up the arena's tiers (D-114).
      return { ground, yaw, elevation: streetVisible ? elevationShown : feet };
    },
    get jumpLift() {
      return lift;
    },
    get cameraBounds() {
      return cameraBounds;
    },
    get cameraPreset(): CameraPresetId {
      return rooftop !== null ? 'rooftop' : 'street';
    },
    consumeSnap() {
      const snap = pendingSnap;
      pendingSnap = false;
      return snap;
    },
    bindSession(remotePeers) {
      if (disposed) throw new Error('Presenter has been disposed');
      sessionToken += 1;
      const token = sessionToken;
      retireRemote();
      resetPresentation();
      if (remotePeers) {
        // D-114: remote spectators sit on the arena's tiers.
        const layer = createRemoteAvatarLayer3D({
          source: remotePeers,
          figures: options.figures,
          surfaceHeight: remoteHeight,
          ...(options.reducedMotion ? { reducedMotion: options.reducedMotion } : {}),
          seatAt: arenaSeatAt,
        });
        remote = layer;
        root.add(layer.group);
        layer.setVisible(remoteVisible);
      }
      // A retired session must not steer the presentation of its successor.
      const live = (): boolean => !disposed && token === sessionToken;
      return {
        setPlayerPosition(position, snap) {
          if (!live()) return;
          ground = pixelToGround(position.x, position.y);
          avatar.object.position.set(ground.x, 0, ground.z);
          if (snap) pendingSnap = true;
        },
        setPlayerMotion(next) {
          if (!live()) return;
          motion = { vx: next.vx, vy: next.vy, sprinting: next.sprinting === true };
          const heading = directionToYaw(next.vx, next.vy);
          if (heading !== null) targetYaw = heading;
        },
        setPlayerAvatar(sprite: AvatarSpriteKey) {
          if (!live()) return;
          avatar.setLook(sprite);
          placeCarried();
        },
        setStreetVisible(visible) {
          if (!live()) return;
          streetVisible = visible;
          street.ground.visible = visible;
          sandbox.group.visible = visible;
          football.group.visible = visible;
        },
        setDoorsVisible(visible) {
          if (!live()) return;
          street.doors.visible = visible;
        },
        setLabelsVisible(visible) {
          if (!live()) return;
          street.labels.visible = visible;
        },
        setRemoteVisible(visible) {
          if (!live()) return;
          remoteVisible = visible;
          remote?.setVisible(visible);
        },
        showRoom(building, level) {
          if (!live()) return;
          visibleRoom = building === null ? null : roomKey(building, level);
          if (visibleRoom !== null) ensureRoom(visibleRoom);
          for (const [key, room] of rooms) room.group.visible = key === visibleRoom;
        },
        renderRoom(building, stations: readonly FixedRoomStationPresentation[]) {
          if (!live()) return;
          // Every floor of the building: each view draws only its own stations.
          lastStations.set(building, stations);
          for (const room of rooms.values()) if (room.building === building) room.setStations(stations);
        },
        showRooftop(building) {
          if (!live()) return;
          rooftop = building;
        },
        syncStudio(state) {
          if (!live()) return;
          studioVisible = state.visible;
          studio.sync(state);
        },
        destroyStudio() {
          if (!live()) return;
          studioVisible = false;
          studio.sync({ visible: false, highlightedFigure: null });
        },
        setPlayerElevation(level) {
          if (!live() || !Number.isFinite(level)) return;
          const next = Math.max(0, level);
          // Hop only onto something above the feet as drawn right now. A stack
          // that rises under a falling player below its current height just
          // becomes the new landing: the fall carries on down to it.
          if (next > elevationShown && !pendingSnap) {
            // Re-plan from wherever the feet are now, so they never jump.
            // D-106: a climb mid-jump hops on from the top of the arc.
            const from = jumpElapsed !== null && lift > 0 ? elevationShown + lift : elevationShown;
            if (from >= next && next - elevationShown <= MAX_HOP_RISE) {
              // The arc already has the feet above the block: no hop. The
              // ground rises under the jump and the arc lands on the block.
              jumpRaise += next - elevationShown;
              lift = from - next;
              elevationShown = next;
              elevationTarget = next;
              hop = null;
              fallSpeed = 0;
              return;
            }
            hop = next - elevationShown <= MAX_HOP_RISE ? { from, to: next, elapsed: 0 } : null;
            if (!hop) elevationShown = next;
            if (hop && from !== elevationShown) {
              jumpClimbed = true;
              lift = 0;
            }
            fallSpeed = 0;
          } else if (hop) {
            hop = null;
          }
          elevationTarget = next;
        },
        setSandboxColumns(columns: readonly SandboxColumn[]) {
          if (!live()) return;
          sandbox.setColumns(columns);
          sandboxHeights = columns.length > 0 ? createSandboxHeights(columns) : FLAT_SANDBOX;
        },
        sandboxDrop(tile) {
          if (!live()) return;
          sandbox.expectDrop(tile);
        },
        sandboxBurst(tile) {
          if (!live()) return;
          sandbox.burst(tile);
        },
        setCarried(colour) {
          if (!live()) return;
          carried.setColour(colour);
        },
        setSandboxAim(aim) {
          if (!live()) return;
          sandbox.setTarget(aim
            ? { x: aim.tile.x, y: aim.tile.y, level: aim.level, mode: aim.mode, valid: aim.valid }
            : null);
        },
        setPlayerSeated(seated) {
          if (!live()) return;
          // D-127: sitting on a bench is told, not guessed. The arena's tiers
          // keep their own idle rule; this is simply or-ed with it.
          benchSeated = seated === true;
        },
        setInteractionPrompt(prompt) {
          if (!live()) return;
          // D-123: no floating "E · …" any more: the chosen target glows,
          // and the words go to the key chip at the bottom of the screen
          // (interact-chip.ts), which the engine feeds.
          // D-127: a target that asked for the chip alone (the benches) lights
          // nothing — not even a shell that happens to exist under its id.
          if (prompt?.cue === 'none') focusAffordance(null, null);
          else focusAffordance(prompt?.id ?? null, prompt?.object);
        },
        setPlazaStats(stats) {
          if (!live()) return;
          street.plaza?.setStats(stats);
        },
        setFootball(frame) {
          if (!live()) return;
          football.setBall(frame);
          if (frame) street.pitch?.setScore(frame.west, frame.east);
        },
        setKickPrompt(visible) {
          if (!live()) return;
          football.setPrompt(visible);
        },
        footballMoment(moment) {
          if (!live()) return;
          football.celebrate(moment);
        },
        arenaGateObject() {
          if (!live()) return null;
          ensureRoom('arena');
          return arenaRoom?.gate ?? null;
        },
        syncArena(frame) {
          if (!live()) return;
          arenaFrame = frame;
          arenaGate = frame?.gate === 'busy' ? 'busy' : 'open';
          arenaRoom?.setGate(arenaGate);
          if (arenaRoom?.gate) extraAffordances.get(arenaRoom.gate)?.setUsable(ARENA_GATE_TARGET_ID, arenaGate === 'open');
          arenaFx.sync(frame, remoteSwings());
        },
        setArenaPrompt(text) {
          if (!live()) return;
          const shown = typeof text === 'string' && text.trim().length > 0 ? text : null;
          if (shown === null) {
            if (arenaPrompt) arenaPrompt.object.visible = false;
            return;
          }
          if (!arenaPrompt) {
            arenaPrompt = options.labels.floating(shown, ARENA_PROMPT_STYLE);
            arenaPrompt.object.userData['arena'] = 'prompt';
            avatar.object.add(arenaPrompt.object);
            const label = arenaPrompt;
            disposers.push(() => {
              label.object.removeFromParent();
              label.dispose();
            });
          } else {
            arenaPrompt.setText(shown);
          }
          arenaPrompt.object.position.set(0, avatarFigureHeight(avatar.look) + 0.55, 0);
          arenaPrompt.object.visible = true;
        },
        playerSwing() {
          if (!live()) return;
          swingElapsed = 0;
        },
        setPlayerFacing(facing) {
          if (!live()) return;
          const turned = FACING_YAW[facing];
          if (turned === undefined) return;
          targetYaw = turned;
          yaw = turned;
          avatar.object.rotation.y = yaw;
        },
        playerJump() {
          if (!live()) return;
          // The session allows one jump at a time; a call mid-air restarts it.
          let reduced = false;
          try {
            reduced = options.reducedMotion?.() === true;
          } catch {
            reduced = false;
          }
          jumpHeight = reduced ? REDUCED_JUMP_HEIGHT : JUMP_HEIGHT;
          jumpSquash = !reduced;
          jumpElapsed = 0;
          jumpClimbed = false;
          jumpRaise = 0;
        },
        setCameraBounds(bounds: WorldRect) {
          if (!live()) return;
          cameraBounds = {
            minX: bounds.x / PIXELS_PER_UNIT,
            maxX: (bounds.x + bounds.width) / PIXELS_PER_UNIT,
            minZ: bounds.y / PIXELS_PER_UNIT,
            maxZ: (bounds.y + bounds.height) / PIXELS_PER_UNIT,
          };
        },
        destroy() {
          if (token !== sessionToken) return;
          sessionToken += 1;
          retireRemote();
        },
      };
    },
    update(deltaMs) {
      if (disposed) return;
      const dt = Number.isFinite(deltaMs) && deltaMs > 0 ? Math.min(deltaMs, 250) : 0;
      const moving = motion.vx !== 0 || motion.vy !== 0;
      const turn = angleDelta(yaw, targetYaw);
      const maxStep = (MAX_TURN_RATE * dt) / 1000;
      yaw += Math.abs(turn) <= maxStep ? turn : Math.sign(turn) * maxStep;
      avatar.object.rotation.y = yaw;
      // Sandbox stacks: hop up, fall down (D-060).
      if (pendingSnap) {
        elevationShown = elevationTarget;
        hop = null;
        fallSpeed = 0;
      } else if (hop && hop.to !== elevationTarget) {
        // The landing moved mid-hop (a stack changed): fall or re-hop from here.
        hop = null;
      } else if (hop) {
        hop.elapsed += dt;
        const t = Math.min(1, hop.elapsed / REMOTE_HOP_MS);
        elevationShown = t >= 1 ? hop.to : hopHeight(hop.from, hop.to, t);
        if (t >= 1) hop = null;
      } else if (elevationShown > elevationTarget) {
        fallSpeed += (REMOTE_FALL_GRAVITY * dt) / 1000;
        elevationShown = Math.max(elevationTarget, elevationShown - (fallSpeed * dt) / 1000);
        if (elevationShown === elevationTarget) fallSpeed = 0;
      } else {
        elevationShown = elevationTarget;
        fallSpeed = 0;
      }
      // Step up and down kerbs quickly rather than popping 8 cm in one frame.
      const onSandbox = streetVisible && isSandboxTile(Math.floor(ground.x), Math.floor(ground.z));
      // Indoors, the arena's stairs and tiers ease the same way (D-114).
      const kerb = streetVisible
        ? !onSandbox && elevationShown === 0 ? streetSurfaceHeightAt(streetMap, ground.x, ground.z) : 0
        : roomFeet();
      feet = pendingSnap ? kerb : feet + (kerb - feet) * (1 - Math.exp(-dt / 45));
      // D-097: the jump rides on top of whatever the feet stand on. It never
      // moves the avatar across the ground: the session does that, as ever.
      let pose = null;
      if (jumpElapsed !== null) {
        jumpElapsed += dt;
        pose = jumpPose(jumpElapsed, jumpSquash);
        lift = jumpClimbed ? 0 : Math.max(0, jumpLift(jumpElapsed, jumpHeight) - jumpRaise);
        if (jumpElapsed >= JUMP_TOTAL_MS) {
          jumpElapsed = null;
          jumpClimbed = false;
          jumpRaise = 0;
          lift = 0;
        }
      }
      const standOn = feet + (streetVisible ? elevationShown : 0);
      avatar.object.position.y = standOn + lift;
      jumpShadow.place(ground.x, standOn, ground.z, lift, jumpHeight);
      // D-114: the arena swing, the fighter's battle stance, and sitting on a tier.
      let attack: AttackPose | null = null;
      if (swingElapsed !== null) {
        swingElapsed += dt;
        attack = attackPoseAt(swingElapsed);
        if (attack === null) swingElapsed = null;
      }
      const inArena = !streetVisible && visibleRoom === 'arena';
      const onTier = inArena && arenaSeatAt(ground.x * PIXELS_PER_UNIT, ground.z * PIXELS_PER_UNIT);
      idleOnTier = onTier && !moving && jumpElapsed === null ? idleOnTier + dt : 0;
      const guard = inArena && arenaFrame?.selfIsChallenger === true &&
        (arenaFrame.phase === 'countdown' || arenaFrame.phase === 'fighting');
      // D-128: the block stance is the server's own `guarding`, never a
      // local prediction; and the champion sits the moment the server seats
      // them, without the tiers' idle wait.
      const blocking = guard && arenaFrame?.challengerGuarding === true;
      const onThrone = inArena && arenaFrame?.selfOnThrone === true;
      avatar.update(dt, {
        moving,
        sprinting: moving && motion.sprinting,
        jump: pose,
        attack,
        guard,
        blocking,
        seated: benchSeated || onThrone || idleOnTier >= ARENA_SEAT_IDLE_MS,
      });
      if (streetVisible) {
        street.update(dt);
        sandbox.update(dt);
        football.update(dt);
      }
      if (visibleRoom) rooms.get(visibleRoom)?.update(dt);
      if (visibleRoom === 'arena') arenaFx.update(dt);
      if (studioVisible) studio.update(dt);
      // D-123: one shared shimmer clock, then every area's glow fades (a
      // hidden room's too, so it never reappears mid-glow).
      advanceAffordanceClock(dt, readReducedMotion(dt));
      for (const set of affordanceSets) set.update(dt);
      remote?.update(dt);
    },
    updateOcclusion(camera, deltaMs) {
      if (disposed) return;
      const dt = Number.isFinite(deltaMs) && deltaMs > 0 ? Math.min(deltaMs, 250) : 0;
      const blend = 1 - Math.exp(-dt / FADE_TIME_CONSTANT_MS);
      const active = new Set(visibleOccluders());
      // Anything that left view (a hidden street, a closed room) snaps back to
      // opaque so it is not found half-faded next time it is shown.
      for (const [occluder, value] of opacity) {
        if (active.has(occluder)) continue;
        if (value !== 1) occluder.setOpacity(1);
        opacity.delete(occluder);
      }
      // Sight lines start from where the avatar is drawn, sandbox height
      // included, and the arena's tiers indoors (D-114).
      const base = streetVisible ? elevationShown : feet;
      for (const occluder of active) {
        const blocked = SIGHT_HEIGHTS.some((height) =>
          segmentHitsBox(camera, { x: ground.x, y: base + height, z: ground.z }, occluder),
        );
        const current = opacity.get(occluder) ?? 1;
        const goal = blocked ? OCCLUDED_OPACITY : 1;
        if (current === goal) continue;
        const next = Math.abs(goal - current) < 0.01 ? goal : current + (goal - current) * blend;
        opacity.set(occluder, next);
        occluder.setOpacity(next);
      }
    },
    registerAffordance(id, object) {
      if (disposed || typeof id !== 'string' || id.length === 0 || !isObject3D(object)) return () => {};
      registerObject(id, object);
      return () => unregisterObject(object);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      sessionToken += 1;
      const errors: unknown[] = [];
      try {
        retireRemote();
      } catch (error) {
        errors.push(error);
      }
      for (const dispose of disposers.reverse()) {
        try {
          dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      options.parent.remove(root);
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, 'Presenter disposal failed');
    },
  };
}

function isObject3D(value: unknown): value is Object3D {
  return typeof value === 'object' && value !== null && (value as { isObject3D?: unknown }).isObject3D === true;
}
