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

/**
 * D-131: a cinematic override, for the roof swing's ride. While one is
 * supplied the rig places the camera from it instead of the preset, sweeping
 * into and out of it (or cutting, under reduced motion). The published `yaw`
 * does not change — movement keys stay camera-relative to north — so a shot
 * can never turn the controls round.
 */
export interface CameraShot {
  readonly yaw: number;
  readonly pitch: number;
  readonly distance: number;
  readonly aimHeight: number;
  /** Cut to and from the shot instead of sweeping into it. */
  readonly cut?: boolean;
}

export interface CameraRig {
  /** Always `CAMERA_YAW`: north is up the screen, in every preset, shot or not. */
  readonly yaw: number;
  /** The current preset's pitch and distance. */
  readonly pitch: number;
  readonly distance: number;
  readonly preset: CameraPresetId;
  /**
   * Ease towards the target; a pending snap jumps instead. `elevation` lifts
   * the aim with a player standing on sandbox blocks (D-060) or a roof. A new
   * `preset` jumps too: it changes only with a teleport onto or off a roof.
   * `shot` (D-131) overrides the preset's angle while it is supplied.
   */
  update(
    deltaMs: number,
    target: GroundPoint,
    bounds: CameraBounds | null,
    elevation?: number,
    preset?: CameraPresetId,
    shot?: CameraShot | null,
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

/**
 * D-131: how fast the rig sweeps between the preset's angle and a shot's.
 * About a second and a half end to end, which reads as a camera move rather
 * than a cut. A shot that asks to cut skips it in both directions.
 */
const SHOT_TIME_CONSTANT_MS = 380;

/** The smallest difference worth easing; below it the rig lands on the goal. */
const SHOT_EPSILON = 1e-4;

interface Angle {
  yaw: number;
  pitch: number;
  distance: number;
  aimHeight: number;
}

/** `to - from`, wrapped into (-π, π]. A half turn goes the same way every time. */
function yawDelta(from: number, to: number): number {
  const delta = (to - from) % (2 * Math.PI);
  if (delta > Math.PI) return delta - 2 * Math.PI;
  if (delta <= -Math.PI) return delta + 2 * Math.PI;
  return delta;
}

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
  let preset: CameraPresetId = 'street';
  let focus: { x: number; y: number; z: number } | null = null;
  let pendingSnap = true;
  let destroyed = false;
  /** D-131: the angle the camera is drawn at now, eased towards the goal. */
  let angle: Angle | null = null;

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
    update(deltaMs, target, bounds, elevation = 0, nextPreset = 'street', shot = null) {
      if (destroyed) return;
      if (!Number.isFinite(target.x) || !Number.isFinite(target.z)) return;
      const snapPreset = nextPreset !== preset && Object.hasOwn(CAMERA_PRESETS, nextPreset);
      if (snapPreset) {
        preset = nextPreset;
        pendingSnap = true;
      }
      const dt = Number.isFinite(deltaMs) && deltaMs > 0 ? Math.min(deltaMs, 250) : 0;
      const goal = clampToBounds(target, bounds);
      const goalY = Number.isFinite(elevation) ? Math.max(0, elevation) : 0;
      if (!focus || pendingSnap) {
        focus = { x: goal.x, y: goalY, z: goal.z };
        pendingSnap = false;
      } else {
        const blend = 1 - Math.exp(-dt / FOLLOW_TIME_CONSTANT_MS);
        focus.x += (goal.x - focus.x) * blend;
        focus.y += (goalY - focus.y) * blend;
        focus.z += (goal.z - focus.z) * blend;
      }
      // D-131: the angle comes from the shot while one is supplied, and from
      // the preset otherwise; the rig sweeps between them unless told to cut.
      const base = CAMERA_PRESETS[preset];
      const wanted: Angle = shot
        ? { yaw: shot.yaw, pitch: shot.pitch, distance: shot.distance, aimHeight: shot.aimHeight }
        : { yaw: CAMERA_YAW, pitch: base.pitch, distance: base.distance, aimHeight: base.aimHeight };
      const current = angle;
      let shown: Angle;
      if (shot?.cut === true || snapPreset || current === null) {
        shown = { ...wanted };
        angle = shown;
      } else {
        const blend = 1 - Math.exp(-dt / SHOT_TIME_CONSTANT_MS);
        const step = (from: number, to: number): number =>
          Math.abs(to - from) < SHOT_EPSILON ? to : from + (to - from) * blend;
        const turn = yawDelta(current.yaw, wanted.yaw);
        current.yaw = Math.abs(turn) < SHOT_EPSILON ? wanted.yaw : current.yaw + turn * blend;
        current.pitch = step(current.pitch, wanted.pitch);
        current.distance = step(current.distance, wanted.distance);
        current.aimHeight = step(current.aimHeight, wanted.aimHeight);
        shown = current;
      }
      const aimY = focus.y + shown.aimHeight;
      const offset = cameraOffset(shown.yaw, shown.pitch, shown.distance);
      camera.position.set(focus.x + offset.x, aimY + offset.y, focus.z + offset.z);
      camera.lookAt(focus.x, aimY, focus.z);
    },
    snap() {
      pendingSnap = true;
      // A teleport cuts the angle too: the next frame lands on it whole.
      angle = null;
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
