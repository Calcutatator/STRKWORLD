import type { Group, Object3D } from 'three';
import type { AvatarSpriteKey, BuildingId } from '@strkworld/shared';
import type { FixedRoomStationPresentation } from '../fixed-room.js';

/**
 * Contracts shared by the 3D presentation modules (D-059).
 *
 * Everything here is presentation. Gameplay — collision, doors, rooms,
 * stations, the Studio, presence — stays in 2D pixel space and is owned by the
 * engine-agnostic session; see ../world-session.ts and ./coords.ts.
 */

/** How an avatar is moving this frame; drives the procedural walk cycle. */
export interface AvatarMotion {
  readonly moving: boolean;
  readonly sprinting: boolean;
}

/**
 * One procedural low-poly avatar.
 *
 * `object` has its feet at the local origin and faces +Z (south, the 2D
 * 'down' facing) at `rotation.y = 0`. Callers own position and yaw; the figure
 * owns only its own limbs and materials.
 */
export interface AvatarFigure {
  readonly object: Object3D;
  readonly look: AvatarSpriteKey;
  setLook(key: AvatarSpriteKey): void;
  update(deltaMs: number, motion: AvatarMotion): void;
  dispose(): void;
}

export type AvatarFigureFactory = (key: AvatarSpriteKey) => AvatarFigure;

export interface SignOptions {
  /** Board size in world units. */
  readonly width: number;
  readonly height: number;
  /** CSS colours. */
  readonly background?: string;
  readonly foreground?: string;
  readonly accent?: string;
}

export interface FloatingLabelOptions {
  /** Height of one text line in world units. */
  readonly lineHeight?: number;
  readonly foreground?: string;
  readonly background?: string;
}

export interface TextLabel {
  readonly object: Object3D;
  setText(text: string): void;
  dispose(): void;
}

/**
 * Text needs a 2D canvas, which the node test environment does not have, so
 * builders receive a factory instead of touching `document` themselves.
 */
export interface LabelFactory {
  /** A flat board such as a facade sign. Faces +Z and is centred on its origin. */
  sign(text: string, options: SignOptions): TextLabel;
  /** A camera-facing label anchored at its bottom centre. */
  floating(text: string, options?: FloatingLabelOptions): TextLabel;
}

/** Axis-aligned footprint in world units, for camera occlusion tests. */
export interface OccluderBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  readonly height: number;
}

/** Something tall enough to hide the player; the camera fades it when it does. */
export interface Occluder {
  readonly bounds: OccluderBounds;
  /** 1 is fully opaque. Implementations must not affect other occluders. */
  setOpacity(opacity: number): void;
}

export interface StreetView {
  /** Ground, road, pavement and buildings: the street's `setGroundVisible` target. */
  readonly ground: Group;
  /** Door portals: the `setDoorsVisible` target. */
  readonly doors: Group;
  /** Facade signs: the `setLabelsVisible` target. */
  readonly labels: Group;
  readonly occluders: readonly Occluder[];
  update(deltaMs: number): void;
  dispose(): void;
}

export interface RoomView {
  readonly building: BuildingId;
  readonly group: Group;
  readonly occluders: readonly Occluder[];
  /** Redraw station state: status, highlight and label. */
  setStations(stations: readonly FixedRoomStationPresentation[]): void;
  update(deltaMs: number): void;
  dispose(): void;
}

export interface StudioView {
  readonly group: Group;
  readonly occluders: readonly Occluder[];
  /** Same contract as the 2D figure layer: visibility plus one highlighted figure. */
  sync(state: { readonly visible: boolean; readonly highlightedFigure: number | null }): void;
  update(deltaMs: number): void;
  dispose(): void;
}
