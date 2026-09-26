import type { PerspectiveCamera } from 'three';
import type { GroundPoint } from './coords.js';

/**
 * Third-person follow camera (D-059).
 *
 * The default view is north-up, so the district reads exactly as it did in
 * 2D. Dragging orbits around the player and the wheel zooms. Movement keys
 * are camera-relative (see `rotateScreenVelocity` in world-session.ts), which
 * is why the rig publishes its yaw.
 *
 * The rig never changes yaw on its own. A room or Studio entry teleports the
 * player next to an exit; if the camera turned during that handoff, a key the
 * player is still holding would point back out of the door.
 */

export interface CameraBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
}

export interface CameraPointerHost {
  addEventListener(type: string, listener: EventListener, options?: AddEventListenerOptions): void;
  removeEventListener(type: string, listener: EventListener, options?: EventListenerOptions): void;
  setPointerCapture?(pointerId: number): void;
  releasePointerCapture?(pointerId: number): void;
  hasPointerCapture?(pointerId: number): boolean;
}

export interface CameraRigOptions {
  readonly camera: PerspectiveCamera;
  /** Receives pointer and wheel input; normally the canvas. */
  readonly element?: CameraPointerHost;
}

export interface CameraRig {
  readonly yaw: number;
  readonly pitch: number;
  readonly distance: number;
  /** Ease towards the target; a pending snap jumps instead. */
  update(deltaMs: number, target: GroundPoint, bounds: CameraBounds | null): void;
  /** Jump to the target on the next update (spawn, room and Studio handoffs). */
  snap(): void;
  /** While false the rig ignores drags and wheel, and drops any active drag. */
  setInputEnabled(enabled: boolean): void;
  destroy(): void;
}

export const DEFAULT_CAMERA_PITCH = 0.7;
export const MIN_CAMERA_PITCH = 0.45;
export const MAX_CAMERA_PITCH = 1.3;
export const DEFAULT_CAMERA_DISTANCE = 13;
export const MIN_CAMERA_DISTANCE = 6;
export const MAX_CAMERA_DISTANCE = 18;
/** The camera looks at the player's chest, not their feet. */
export const CAMERA_FOCUS_HEIGHT = 0.9;

const ORBIT_RADIANS_PER_PIXEL = 0.006;
const PITCH_RADIANS_PER_PIXEL = 0.004;
const ZOOM_PER_WHEEL_UNIT = 0.0012;
const FOLLOW_TIME_CONSTANT_MS = 70;

/** Camera offset from its focus point for an orbit angle, pitch and distance. */
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

export function createCameraRig(options: CameraRigOptions): CameraRig {
  const { camera, element } = options;
  let yaw = 0;
  let pitch = DEFAULT_CAMERA_PITCH;
  let distance = DEFAULT_CAMERA_DISTANCE;
  let focus: { x: number; z: number } | null = null;
  let pendingSnap = true;
  let inputEnabled = true;
  let destroyed = false;
  let drag: { pointerId: number; x: number; y: number } | null = null;

  const endDrag = (): void => {
    if (!drag) return;
    const { pointerId } = drag;
    drag = null;
    try {
      if (element?.hasPointerCapture?.(pointerId)) element.releasePointerCapture?.(pointerId);
    } catch {
      // Capture can already be gone; the drag is over either way.
    }
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (destroyed || !inputEnabled || drag) return;
    if (event.button !== 0 && event.button !== 2) return;
    drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
    try {
      element?.setPointerCapture?.(event.pointerId);
    } catch {
      // Without capture the drag still works while the pointer stays over us.
    }
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!inputEnabled) {
      endDrag();
      return;
    }
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    drag.x = event.clientX;
    drag.y = event.clientY;
    if (Number.isFinite(dx)) yaw = normalizeAngle(yaw - dx * ORBIT_RADIANS_PER_PIXEL);
    if (Number.isFinite(dy)) {
      pitch = clamp(pitch + dy * PITCH_RADIANS_PER_PIXEL, MIN_CAMERA_PITCH, MAX_CAMERA_PITCH);
    }
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (drag && event.pointerId === drag.pointerId) endDrag();
  };

  const onWheel = (event: WheelEvent): void => {
    if (destroyed || !inputEnabled) return;
    event.preventDefault();
    const amount = Number.isFinite(event.deltaY) ? event.deltaY : 0;
    distance = clamp(distance * Math.exp(amount * ZOOM_PER_WHEEL_UNIT), MIN_CAMERA_DISTANCE, MAX_CAMERA_DISTANCE);
  };

  // Right-drag orbits, so the context menu would otherwise open mid-gesture.
  const onContextMenu = (event: Event): void => {
    event.preventDefault();
  };

  const listeners: Array<[string, EventListener, AddEventListenerOptions | undefined]> = [
    ['pointerdown', onPointerDown as EventListener, undefined],
    ['pointermove', onPointerMove as EventListener, undefined],
    ['pointerup', onPointerUp as EventListener, undefined],
    ['pointercancel', onPointerUp as EventListener, undefined],
    ['lostpointercapture', onPointerUp as EventListener, undefined],
    ['wheel', onWheel as EventListener, { passive: false }],
    ['contextmenu', onContextMenu, undefined],
  ];
  if (element) {
    for (const [type, listener, listenerOptions] of listeners) {
      element.addEventListener(type, listener, listenerOptions);
    }
  }

  return {
    get yaw() {
      return yaw;
    },
    get pitch() {
      return pitch;
    },
    get distance() {
      return distance;
    },
    update(deltaMs, target, bounds) {
      if (destroyed) return;
      if (!Number.isFinite(target.x) || !Number.isFinite(target.z)) return;
      const goal = clampToBounds(target, bounds);
      if (!focus || pendingSnap) {
        focus = { x: goal.x, z: goal.z };
        pendingSnap = false;
      } else {
        const dt = Number.isFinite(deltaMs) && deltaMs > 0 ? Math.min(deltaMs, 250) : 0;
        const blend = 1 - Math.exp(-dt / FOLLOW_TIME_CONSTANT_MS);
        focus.x += (goal.x - focus.x) * blend;
        focus.z += (goal.z - focus.z) * blend;
      }
      const offset = cameraOffset(yaw, pitch, distance);
      camera.position.set(
        focus.x + offset.x,
        CAMERA_FOCUS_HEIGHT + offset.y,
        focus.z + offset.z,
      );
      camera.lookAt(focus.x, CAMERA_FOCUS_HEIGHT, focus.z);
    },
    snap() {
      pendingSnap = true;
    },
    setInputEnabled(enabled) {
      inputEnabled = enabled === true;
      if (!inputEnabled) endDrag();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      endDrag();
      if (element) {
        for (const [type, listener] of listeners) element.removeEventListener(type, listener);
      }
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

function normalizeAngle(angle: number): number {
  const turn = Math.PI * 2;
  return ((((angle + Math.PI) % turn) + turn) % turn) - Math.PI;
}
