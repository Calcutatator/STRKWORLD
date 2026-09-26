import { Group, type Object3D, type Vector3 } from 'three';
import type { AvatarSpriteKey, BuildingId } from '@strkworld/shared';
import { createStreetMap } from '../map/street.js';
import {
  FIXED_ROOM_DEFINITIONS,
  createFixedRoom,
  type FixedRoomStationPresentation,
} from '../fixed-room.js';
import { AVATAR_STUDIO_DEFINITION } from '../avatar-studio.js';
import { DEFAULT_AVATAR_SPRITE } from '../avatar-state.js';
import type { RemotePeerSource } from '../remote-peer.js';
import type { PlayerMotion, WorldRect, WorldSessionView } from '../world-session.js';
import { buildStreet, streetSurfaceHeightAt } from './street-builder.js';
import { buildFixedRoom } from './room-builder.js';
import { buildAvatarStudio } from './studio-builder.js';
import { createRemoteAvatarLayer3D, type RemoteAvatarLayer3D } from './remote-avatars.js';
import { angleDelta, directionToYaw, pixelToGround, PIXELS_PER_UNIT, type GroundPoint } from './coords.js';
import type { CameraBounds } from './camera-rig.js';
import { segmentHitsBox } from './occlusion.js';
import type {
  AvatarFigure,
  AvatarFigureFactory,
  LabelFactory,
  Occluder,
  RoomView,
  StreetView,
  StudioView,
} from './types.js';

/**
 * The 3D presentation of one World (D-059).
 *
 * It owns the static district, the four room interiors, the Avatar Studio and
 * the local avatar for the lifetime of the renderer, and a remote-avatar layer
 * per session. Sessions talk to it only through `WorldSessionView`, so every
 * decision — collision, doors, stations, rollback — stays in the session and
 * this module only mirrors the outcome.
 */

export interface PresenterOptions {
  readonly parent: Object3D;
  readonly labels: LabelFactory;
  readonly figures: AvatarFigureFactory;
}

export interface SessionView extends WorldSessionView {
  destroy(): void;
}

export interface Presenter {
  /** Local avatar feet in world units and its presented yaw. */
  readonly player: { readonly ground: GroundPoint; readonly yaw: number };
  readonly cameraBounds: CameraBounds | null;
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

export function createPresenter(options: PresenterOptions): Presenter {
  const root = new Group();
  root.name = 'strkworld';
  const disposers: Array<() => void> = [];

  const streetMap = createStreetMap();
  const street: StreetView = buildStreet(streetMap, options.labels);
  // Pavement is raised; stand feet on it. Interiors and the Studio floor are flat.
  const streetHeight = (x: number, z: number): number => streetSurfaceHeightAt(streetMap, x, z);
  disposers.push(() => street.dispose());
  root.add(street.ground, street.doors, street.labels);

  const rooms = new Map<BuildingId, RoomView>();
  for (const definition of Object.values(FIXED_ROOM_DEFINITIONS)) {
    const room = buildFixedRoom(createFixedRoom(definition), options.labels);
    room.group.visible = false;
    rooms.set(definition.building, room);
    root.add(room.group);
    disposers.push(() => room.dispose());
  }

  const studio: StudioView = buildAvatarStudio(AVATAR_STUDIO_DEFINITION, options.figures, options.labels);
  studio.sync({ visible: false, highlightedFigure: null });
  root.add(studio.group);
  disposers.push(() => studio.dispose());

  const avatar: AvatarFigure = options.figures(DEFAULT_AVATAR_SPRITE);
  root.add(avatar.object);
  disposers.push(() => avatar.dispose());

  options.parent.add(root);

  let ground: GroundPoint = { x: 0, z: 0 };
  let feet = 0;
  let yaw = 0;
  let targetYaw = 0;
  let motion: PlayerMotion = { vx: 0, vy: 0, sprinting: false };
  let pendingSnap = true;
  let cameraBounds: CameraBounds | null = null;
  let streetVisible = true;
  let remoteVisible = true;
  let visibleRoom: BuildingId | null = null;
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
    for (const room of rooms.values()) room.group.visible = false;
    studioVisible = false;
    studio.sync({ visible: false, highlightedFigure: null });
    motion = { vx: 0, vy: 0, sprinting: false };
    pendingSnap = true;
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
      return { ground, yaw };
    },
    get cameraBounds() {
      return cameraBounds;
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
          surfaceHeight: streetHeight,
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
        },
        setStreetVisible(visible) {
          if (!live()) return;
          streetVisible = visible;
          street.ground.visible = visible;
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
        showRoom(building) {
          if (!live()) return;
          visibleRoom = building;
          for (const [id, room] of rooms) room.group.visible = id === building;
        },
        renderRoom(building, stations: readonly FixedRoomStationPresentation[]) {
          if (!live()) return;
          rooms.get(building)?.setStations(stations);
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
      // Step up and down kerbs quickly rather than popping 8 cm in one frame.
      const surface = streetVisible ? streetHeight(ground.x, ground.z) : 0;
      feet = pendingSnap ? surface : feet + (surface - feet) * (1 - Math.exp(-dt / 45));
      avatar.object.position.y = feet;
      avatar.update(dt, { moving, sprinting: moving && motion.sprinting });
      if (streetVisible) street.update(dt);
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
      for (const occluder of active) {
        const blocked = SIGHT_HEIGHTS.some((height) =>
          segmentHitsBox(camera, { x: ground.x, y: height, z: ground.z }, occluder),
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
