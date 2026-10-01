import { Group, type Object3D, type Vector3 } from 'three';
import type { AvatarSpriteKey, BuildingId, SandboxColumn } from '@strkworld/shared';
import { createStreetMap } from '../map/street.js';
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
import { EMPTY_PLAZA_STATS } from '../plaza-stations.js';
import type {
  AvatarFigure,
  AvatarFigureFactory,
  ImageTextureLoader,
  LabelFactory,
  Occluder,
  RoomView,
  StreetView,
  StudioView,
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
   */
  readonly reducedMotion?: () => boolean;
  /**
   * The Vault opens on shadow accounts, behind the Shell's switch (D-077):
   * its door is drawn open and its room is built. Absent or false, it is
   * D-007's locked facade and no Vault room exists. Every session this
   * presenter binds must be created with the same value.
   */
  readonly vaultOpen?: boolean;
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
  const streetMap = createStreetMap({ vaultOpen });
  const street: StreetView = buildStreet(streetMap, options.labels);
  // Pavement is raised; stand feet on it. Interiors and the Studio floor are
  // flat. On the sandbox, anyone stands on the tallest stack their body
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
   * player's own area: the street's surface, or a flat floor indoors and in
   * the Studio.
   */
  const remoteHeight = (x: number, z: number): number => {
    if (rooftop !== null) {
      const deck = rooftopHeightAt(rooftop, x, z);
      if (deck !== null) return deck;
    }
    return streetVisible ? streetHeight(x, z) : 0;
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
  for (const definition of fixedRoomDefinitionsFor({ vaultOpen })) {
    addRoom(roomKey(definition.building), buildFixedRoom(createFixedRoom(definition), options.labels, ROOM_ORIGIN, images));
    for (const level of FIXED_ROOM_LEVELS[definition.building] ?? []) {
      if (level.rooftop) continue;
      addRoom(
        roomKey(definition.building, level.level),
        buildFixedRoom(createFixedRoomLevel(level), options.labels, ROOM_ORIGIN, images),
      );
    }
  }

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

  options.parent.add(root);

  let ground: GroundPoint = { x: 0, z: 0 };
  let feet = 0;
  let yaw = 0;
  let sandboxHeights: SandboxHeights = FLAT_SANDBOX;
  let elevationTarget = 0;
  let elevationShown = 0;
  let fallSpeed = 0;
  let hop: { from: number; to: number; elapsed: number } | null = null;
  let targetYaw = 0;
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
    // The plaza's prompt and figures belong to the session that set them (D-076).
    street.plaza?.setHighlight(null);
    street.plaza?.setStats(EMPTY_PLAZA_STATS);
    // So do the ball, its prompt, the pitch's moments and the scoreboard (D-078).
    football.group.visible = true;
    football.reset();
    street.pitch?.setScore(0, 0);
    elevationTarget = 0;
    elevationShown = 0;
    fallSpeed = 0;
    hop = null;
  };

  const retireRemote = (): void => {
    const layer = remote;
    remote = null;
    if (!layer) return;
    root.remove(layer.group);
    layer.destroy();
  };

  const visibleOccluders = (): readonly Occluder[] => {
    const active: Occluder[] = [];
    if (streetVisible) active.push(...street.occluders);
    if (visibleRoom) active.push(...(rooms.get(visibleRoom)?.occluders ?? []));
    if (studioVisible) active.push(...studio.occluders);
    return active;
  };

  return {
    get player() {
      return { ground, yaw, elevation: elevationShown };
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
        const layer = createRemoteAvatarLayer3D({
          source: remotePeers,
          figures: options.figures,
          surfaceHeight: remoteHeight,
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
          for (const [key, room] of rooms) room.group.visible = key === visibleRoom;
        },
        renderRoom(building, stations: readonly FixedRoomStationPresentation[]) {
          if (!live()) return;
          // Every floor of the building: each view draws only its own stations.
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
            hop = next - elevationShown <= MAX_HOP_RISE ? { from: elevationShown, to: next, elapsed: 0 } : null;
            if (!hop) elevationShown = next;
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
        setPlazaHighlight(station) {
          if (!live()) return;
          street.plaza?.setHighlight(station);
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
      const kerb = streetVisible && !onSandbox && elevationShown === 0 ? streetSurfaceHeightAt(streetMap, ground.x, ground.z) : 0;
      feet = pendingSnap ? kerb : feet + (kerb - feet) * (1 - Math.exp(-dt / 45));
      avatar.object.position.y = feet + (streetVisible ? elevationShown : 0);
      avatar.update(dt, { moving, sprinting: moving && motion.sprinting });
      if (streetVisible) {
        street.update(dt);
        sandbox.update(dt);
        football.update(dt);
      }
      if (visibleRoom) rooms.get(visibleRoom)?.update(dt);
      if (studioVisible) studio.update(dt);
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
      // Sight lines start from where the avatar is drawn, sandbox height included.
      const base = streetVisible ? elevationShown : 0;
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
