import type { PerspectiveCamera } from 'three';
import type { GroundPoint } from './coords.js';

/**
 * Third-person follow camera (D-059), at one fixed angle per place.
 *
 * It follows the player, and their height on sandbox blocks (D-060) or a
 * roof, from a fixed yaw, pitch and distance: always looking north, so the
 * district reads exactly as it did in 2D, and never orbiting or zooming. The
 * rig reads no pointer or wheel input at all. The street angle is tuned so
 * every street building but the Exchange tower is seen whole, rooftops
 * included, from both pavements and the road (see the framing test in
 * camera-rig.test.ts); the tower's top runs out of frame by design. On the
 * tower's roof the `rooftop` preset looks steeply down at the street below.
 *
 * Movement keys stay camera-relative (see `rotateScreenVelocity` in
 * world-session.ts) through the published yaw, which is always north, so W
 * walks north and a key held through a room or Studio handoff keeps its way.
 */

export interface CameraBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

export interface CameraRigOptions {
  readonly camera: PerspectiveCamera;
}

export interface CameraRig {
  /** Always `CAMERA_YAW`: north is up the screen, in every preset. */
  readonly yaw: number;
  /** The current preset's pitch and distance. */
  readonly pitch: number;
  readonly distance: number;
  readonly preset: CameraPresetId;
  /**
   * Ease towards the target; a pending snap jumps instead. `elevation` lifts
   * the aim with a player standing on sandbox blocks (D-060) or a roof. A new
   * `preset` jumps too: it changes only with a teleport onto or off a roof.
   */
  update(
    deltaMs: number,
    target: GroundPoint,
    bounds: CameraBounds | null,
    elevation?: number,
    preset?: CameraPresetId,
  ): void;
  /** Jump to the target on the next update (spawn, room and Studio handoffs). */
  snap(): void;
  destroy(): void;
}

/** North up the screen, as in 2D. */
export const CAMERA_YAW = 0;
/**
 * Low enough that the tallest rooftop, the Exchange's ticker and mast, stays
 * in view from the far pavement; steep enough to read the road and the plate.
 */
export const CAMERA_PITCH = (28 * Math.PI) / 180;
export const CAMERA_DISTANCE = 11;
/** Vertical field of view in degrees, for the engine's PerspectiveCamera. */
export const CAMERA_FOV = 50;
/**
 * The camera aims this far above the player's feet, not at them: the player
 * sits in the lower third of the frame and the buildings get the rest.
 */
export const CAMERA_AIM_HEIGHT = 4;

/** Level with the street (and every interior), or looking down from a roof. */
export type CameraPresetId = 'street' | 'rooftop';

export interface CameraPreset {
  readonly pitch: number;
  readonly distance: number;
  /** How far above the player's feet the camera aims. */
  readonly aimHeight: number;
}

/**
 * On the Exchange tower's roof the camera tips over to look down: steep
 * enough that the street far below fills the bottom of the frame, close
 * enough that the deck and the player read, aimed at the player's chest.
 */
export const ROOFTOP_CAMERA_PITCH = (74 * Math.PI) / 180;
export const ROOFTOP_CAMERA_DISTANCE = 13;
export const ROOFTOP_CAMERA_AIM_HEIGHT = 1;

export const CAMERA_PRESETS: Readonly<Record<CameraPresetId, CameraPreset>> = Object.freeze({
  street: Object.freeze({ pitch: CAMERA_PITCH, distance: CAMERA_DISTANCE, aimHeight: CAMERA_AIM_HEIGHT }),
  rooftop: Object.freeze({
    pitch: ROOFTOP_CAMERA_PITCH,
    distance: ROOFTOP_CAMERA_DISTANCE,
    aimHeight: ROOFTOP_CAMERA_AIM_HEIGHT,
  }),
});

const FOLLOW_TIME_CONSTANT_MS = 70;

/** Camera offset from its aim point for a yaw, pitch and distance. */
export function cameraOffset(
  yaw: number,
  pitch: number,
  distance: number,
): { x: number; y: number; z: number } {
  const horizontal = Math.cos(pitch) * distance;
  return {
    x: Math.sin(yaw) * horizontal,
    y: Math.sin(pitch) * distance,
    z: Math.cos(yaw) * horizontal,
  };
}

/** Where the fixed camera stands for a player at `target` on `elevation` blocks. */
export function cameraPositionFor(
  target: GroundPoint,
  elevation = 0,
  preset: CameraPresetId = 'street',
): { x: number; y: number; z: number } {
  const { pitch, distance, aimHeight } = CAMERA_PRESETS[preset];
  const offset = cameraOffset(CAMERA_YAW, pitch, distance);
  return { x: target.x + offset.x, y: elevation + aimHeight + offset.y, z: target.z + offset.z };
}

export function createCameraRig(options: CameraRigOptions): CameraRig {
  const { camera } = options;
  const offsets: Readonly<Record<CameraPresetId, { x: number; y: number; z: number }>> = {
    street: cameraOffset(CAMERA_YAW, CAMERA_PRESETS.street.pitch, CAMERA_PRESETS.street.distance),
    rooftop: cameraOffset(CAMERA_YAW, CAMERA_PRESETS.rooftop.pitch, CAMERA_PRESETS.rooftop.distance),
  };
  let preset: CameraPresetId = 'street';
  let focus: { x: number; y: number; z: number } | null = null;
  let pendingSnap = true;
  let destroyed = false;

  return {
    get yaw() {
      return CAMERA_YAW;
    },
    get pitch() {
      return CAMERA_PRESETS[preset].pitch;
    },
    get distance() {
      return CAMERA_PRESETS[preset].distance;
    },
    get preset() {
      return preset;
    },
    update(deltaMs, target, bounds, elevation = 0, nextPreset = 'street') {
      if (destroyed) return;
      if (!Number.isFinite(target.x) || !Number.isFinite(target.z)) return;
      if (nextPreset !== preset && Object.hasOwn(CAMERA_PRESETS, nextPreset)) {
        preset = nextPreset;
        pendingSnap = true;
      }
      const goal = clampToBounds(target, bounds);
      const goalY = Number.isFinite(elevation) ? Math.max(0, elevation) : 0;
      if (!focus || pendingSnap) {
        focus = { x: goal.x, y: goalY, z: goal.z };
        pendingSnap = false;
      } else {
        const dt = Number.isFinite(deltaMs) && deltaMs > 0 ? Math.min(deltaMs, 250) : 0;
        const blend = 1 - Math.exp(-dt / FOLLOW_TIME_CONSTANT_MS);
        focus.x += (goal.x - focus.x) * blend;
        focus.y += (goalY - focus.y) * blend;
        focus.z += (goal.z - focus.z) * blend;
      }
      const aimY = focus.y + CAMERA_PRESETS[preset].aimHeight;
      const offset = offsets[preset];
      camera.position.set(focus.x + offset.x, aimY + offset.y, focus.z + offset.z);
      camera.lookAt(focus.x, aimY, focus.z);
    },
    snap() {
      pendingSnap = true;
    },
    destroy() {
      destroyed = true;
    },
  };
}

function clampToBounds(target: GroundPoint, bounds: CameraBounds | null): GroundPoint {
  if (!bounds) return target;
  return {
    x: clamp(target.x, bounds.minX, bounds.maxX),
    z: clamp(target.z, bounds.minZ, bounds.maxZ),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
