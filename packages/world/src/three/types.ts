import type { Group, Object3D, Texture } from 'three';
import type { AvatarSpriteKey, BuildingId, StationId } from '@strkworld/shared';
import type { FixedRoomStationPresentation } from '../fixed-room.js';
import type { PlazaStatsPresentation } from '../plaza-stations.js';
import type { JumpPose } from '../jump.js';

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
  /**
   * D-097: the jump pose this frame (stretch, tuck, landing squash), or
   * none. The caller lifts the figure; the figure only changes shape.
   */
  readonly jump?: JumpPose | null;
  /**
   * D-114: the arena swing this frame, or none. The figure drives its right
   * arm, an upper-body twist and a small lunge from it; callers that never
   * fight leave it out.
   */
  readonly attack?: AttackPose | null;
  /** D-114: the battle-stance idle (weapon raised, feet apart). */
  readonly guard?: boolean;
  /** D-114: a spectator sitting on an arena tier. */
  readonly seated?: boolean;
}

/**
 * D-114: one arena swing (`ARENA_SWING_MS`, 350 ms): 100 ms wind-up, 120 ms
 * strike, 130 ms recover. `progress` runs 0..1 within the current stage.
 */
export interface AttackPose {
  readonly stage: 'windup' | 'strike' | 'recover';
  readonly progress: number;
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

/**
 * Images need a decoder, which the node test environment does not have, so
 * builders receive a loader instead of touching `document` themselves — the
 * texture twin of `LabelFactory`. The World only ever asks it for its own
 * bundled assets (`packages/world/assets/`), never a third-party URL.
 */
export interface ImageTextureLoader {
  /**
   * Decode `url` into a texture the caller then owns and disposes. Rejects
   * when the image cannot load; a builder keeps its procedural stand-in then.
   */
  load(url: string): Promise<Texture>;
}

/** Axis-aligned footprint in world units, for camera occlusion tests. */
export interface OccluderBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minZ: number;
  readonly maxZ: number;
  readonly height: number;
  /**
   * Where the box starts above the ground; 0 (the ground) when absent. An
   * overhead occluder such as the sandbox gate's superstructure starts
   * higher, so a sight line passing under it is clear.
   */
  readonly minY?: number;
}

/** Something tall enough to hide the player; the camera fades it when it does. */
export interface Occluder {
  /** The whole occluder's box. */
  readonly bounds: OccluderBounds;
  /**
   * Where it is actually solid, when one box would overstate it (the sandbox
   * gate: two pillar tops and a lintel over an open gap). A sight line is
   * blocked if it hits any of them; when absent, `bounds` is the one box.
   */
  readonly boxes?: readonly OccluderBounds[];
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
  /** The Privacy Plaza's live parts (D-076), or null on a map without it. */
  readonly plaza?: PlazaView | null;
  /** The football pitch's live parts (D-078), or null on a map without it. */
  readonly pitch?: PitchView | null;
  update(deltaMs: number): void;
  dispose(): void;
}

/** What changes on the football pitch itself (D-078): the scoreboard. The ball is football-view.ts's. */
export interface PitchView {
  /** Redraw the scoreboard: "WEST 0 – 0 EAST". */
  setScore(west: number, east: number): void;
}

/** What the session changes on the Privacy Plaza (D-076): its figures and its E prompt. */
export interface PlazaView {
  /** Redraw the monument's faces; a null part reads "…". */
  setStats(stats: PlazaStatsPresentation): void;
  /** Show the E prompt over this station, or over none. */
  setHighlight(station: StationId | null): void;
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
