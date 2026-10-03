import { Mesh, Vector3, type BufferGeometry, type Object3D } from 'three';
import type { AvatarSpriteKey } from '@strkworld/shared';
import { avatarPartBoxes, createAvatarFigure } from '../src/three/avatar-figure.js';
import {
  ARENA_THRONE_SEAT,
  ARENA_THRONE_SOLIDS,
  ARENA_TIER_SEAT,
  ARENA_TIER_SOLIDS,
  type SeatSolid,
} from '../src/three/arena-room.js';
import { BRIDGE_ROOM_DEFINITION } from '../src/fixed-room.js';
import { STREET_BENCHES, roomBenches, type BenchProfile, type WorldBench } from '../src/seats.js';
import type { AvatarFigure, SeatPlace } from '../src/three/types.js';
import { CLIP_TOLERANCE } from './avatar-clipping.js';

/**
 * An offline seat check for the procedural avatars on the World's benches —
 * D-127, amended 2026-10-03.
 *
 * The bug this exists to keep out: a seated figure that stayed on the ground
 * and sank into the bench it was sitting on, legs and hips through the slats.
 * Two things have to hold for every look on every kind of seat, and neither is
 * something a renderer notices:
 *
 * - **It rests on the seat.** The lowest weight-bearing point of the seated
 *   figure — the hip band, the thighs, the boots — meets the seat top within
 *   `SEAT_REST_TOLERANCE`. Too low and it is inside the bench; too high and it
 *   floats above it.
 * - **Nothing goes through the bench.** No leg or hip box overlaps the seat
 *   surface, the backrest or the step the bench stands on by more than
 *   `SEAT_CLIP_TOLERANCE`. The legs have to clear the seat's front edge or lie
 *   along the top of it; they may not pass through it.
 *
 * Both are judged from the posed geometry (`avatarPartBoxes`) in the sitter's
 * own frame: +Z ahead of them, y above whatever their feet otherwise stand on.
 * That frame is `SeatPlace`'s, so every seat in the game — the plaza bench, a
 * bleacher plank, the Bridge lounge, an arena tier, the emperor's throne —
 * describes itself the same way and is checked the same way.
 *
 * Only the legs and the hip band are checked, as the brief asks: what a cloak,
 * a coat tail or a slung weapon does behind a backrest is its own question and
 * not this one.
 */

/**
 * How far the backside may be from the seat top, and how far a leg or a hip may
 * reach into a bench before it counts: one pixel at the street camera, which is
 * the clipping audit's own unit (`CLIP_TOLERANCE`).
 */
export const SEAT_REST_TOLERANCE = CLIP_TOLERANCE;
export const SEAT_CLIP_TOLERANCE = CLIP_TOLERANCE;
/** Enough frames at the gait's blend for the seat to be fully taken. */
const SETTLE_FRAMES = 40;

/** One kind of seat, in the frame of the figure sitting on it. */
export interface SeatType {
  readonly name: string;
  readonly place: SeatPlace;
  /** What the sitter must not be inside: the seat surface, a back, a step. */
  readonly solids: readonly SeatSolid[];
}

/** One box of the posed figure, in the sitter's frame. */
interface PartBox {
  readonly label: string;
  readonly min: Vector3;
  readonly max: Vector3;
}

export interface SeatFinding {
  readonly key: AvatarSpriteKey;
  readonly seat: string;
  /** `rest`: the backside is not on the seat top. `through`: a part is inside the bench. */
  readonly check: 'rest' | 'through';
  /** The part at fault, such as `avatar-leg-left:boot`. */
  readonly part: string;
  /**
   * `rest`: how far the lowest weight-bearing point is above the seat top
   * (negative: into it). `through`: how deep the part is inside the solid.
   */
  readonly depth: number;
  readonly point: readonly [number, number, number];
}

/**
 * A bench's solids as its sitter sees them, from the profile it is drawn to
 * (`BenchProfile`, in src/seats.ts): the seat surface, the backrest behind the
 * shoulders and the step the bench itself stands on. `across` is the sitter's
 * own place on the run, so everything is measured from where they sit.
 */
export function benchSolids(bench: BenchProfile, across: number): readonly SeatSolid[] {
  const solids: SeatSolid[] = [
    { minY: bench.underside, maxY: bench.surface, minZ: bench.seatBack - across, maxZ: bench.seatFront - across },
  ];
  if (bench.restFront !== null && bench.restBottom !== null && bench.restTop !== null) {
    // From the run's own back edge forward to the rest's front face.
    solids.push({ minY: bench.restBottom, maxY: bench.restTop, minZ: -across, maxZ: bench.restFront - across });
  }
  if (bench.standing > 0) {
    // The whole row the bench stands on: the shins pass over it.
    solids.push({ minY: 0, maxY: bench.standing, minZ: -across, maxZ: 1 - across });
  }
  return Object.freeze(solids.map((solid) => Object.freeze(solid)));
}

const typeOf = (name: string, bench: WorldBench): SeatType => Object.freeze({
  name,
  place: bench.seats[0]!.place,
  solids: benchSolids(bench.profile, bench.run.across),
});

/**
 * Every kind of seat in the World: the plaza's bench, a bleacher's front row,
 * the Bridge room's lounge, an arena tier's plank and the emperor's throne.
 * Taken from the benches themselves, so a bench that moves is still checked.
 */
export function seatTypes(): readonly SeatType[] {
  const plaza = STREET_BENCHES.find((bench) => bench.run.area === 'plaza');
  const pitch = STREET_BENCHES.find((bench) => bench.run.area === 'pitch');
  const bridge = roomBenches(BRIDGE_ROOM_DEFINITION)[0];
  if (!plaza || !pitch || !bridge) throw new Error('the World has lost a bench');
  return Object.freeze([
    typeOf('plaza bench', plaza),
    typeOf('pitch bleacher', pitch),
    typeOf('bridge lounge', bridge),
    Object.freeze({ name: 'arena tier', place: ARENA_TIER_SEAT, solids: ARENA_TIER_SOLIDS }),
    Object.freeze({ name: 'arena throne', place: ARENA_THRONE_SEAT, solids: ARENA_THRONE_SOLIDS }),
  ]);
}

/** A figure settled into a seat, facing +Z, with its feet's ground plane at y = 0. */
function seatedFigure(key: AvatarSpriteKey, place: SeatPlace | null): AvatarFigure {
  const figure = createAvatarFigure(key);
  for (let i = 0; i < SETTLE_FRAMES; i += 1) {
    figure.update(25, { moving: false, sprinting: false, seated: true, seat: place });
  }
  figure.object.updateMatrixWorld(true);
  return figure;
}

/** The legs and the hip band of a posed figure, as axis-aligned boxes in its own frame. */
function weightBoxes(root: Object3D): PartBox[] {
  const boxes: PartBox[] = [];
  const point = new Vector3();
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const leg = object.name === 'avatar-leg-left' || object.name === 'avatar-leg-right';
    if (!leg && object.name !== 'avatar-torso') return;
    const geometry = object.geometry as BufferGeometry;
    const position = geometry.getAttribute('position');
    for (const box of avatarPartBoxes(geometry)) {
      if (!leg && box.tag !== 'hips') continue;
      const min = new Vector3(Infinity, Infinity, Infinity);
      const max = new Vector3(-Infinity, -Infinity, -Infinity);
      for (let v = box.first * 3; v < (box.first + box.count) * 3; v += 1) {
        point.fromBufferAttribute(position, v).applyMatrix4(object.matrixWorld);
        min.min(point);
        max.max(point);
      }
      boxes.push({ label: `${object.name}:${box.tag}`, min, max });
    }
  });
  return boxes;
}

/**
 * How deep `box` is inside `solid`, and where; 0 or less when they do not
 * overlap. Width usually does not decide it — a bench's slats, a plank and the
 * throne's pad all run the whole way across their sitter, so y and z are the
 * question — but a solid that says where it runs (the throne's arms, which
 * stand either side of the sitter) is judged on x as well, or a chair with
 * arms would read as a body through them.
 */
function overlap(box: PartBox, solid: SeatSolid): { depth: number; point: [number, number, number] } {
  const y = Math.min(box.max.y, solid.maxY) - Math.max(box.min.y, solid.minY);
  const z = Math.min(box.max.z, solid.maxZ) - Math.max(box.min.z, solid.minZ);
  const x = solid.minX === undefined || solid.maxX === undefined
    ? Infinity
    : Math.min(box.max.x, solid.maxX) - Math.max(box.min.x, solid.minX);
  const depth = Math.min(x, y, z);
  return {
    depth,
    point: [
      (box.min.x + box.max.x) / 2,
      Math.max(box.min.y, solid.minY),
      Math.max(box.min.z, solid.minZ),
    ],
  };
}

/**
 * Every seat finding for one look, on one kind of seat.
 *
 * `told` is what the figure is told it is sitting on, when that is not the seat
 * it is being judged against: null is a figure told nothing, which is the bug
 * this audit exists for — the pose taken with the feet still on the floor.
 */
export function findSeatFindings(
  key: AvatarSpriteKey,
  seat: SeatType,
  told: SeatPlace | null = seat.place,
): SeatFinding[] {
  const findings: SeatFinding[] = [];
  const figure = seatedFigure(key, told);
  try {
    const boxes = weightBoxes(figure.object);
    // Does it rest on the seat? The lowest weight-bearing point is what the
    // seat holds up, so that is what the seat top has to meet.
    let lowest: PartBox | null = null;
    for (const box of boxes) if (!lowest || box.min.y < lowest.min.y) lowest = box;
    if (lowest) {
      const offset = lowest.min.y - seat.place.surface;
      if (Math.abs(offset) > SEAT_REST_TOLERANCE) {
        findings.push({
          key,
          seat: seat.name,
          check: 'rest',
          part: lowest.label,
          depth: offset,
          point: [(lowest.min.x + lowest.max.x) / 2, lowest.min.y, (lowest.min.z + lowest.max.z) / 2],
        });
      }
    }
    // Is any of it inside the bench?
    for (const box of boxes) {
      for (const solid of seat.solids) {
        const hit = overlap(box, solid);
        if (hit.depth > SEAT_CLIP_TOLERANCE) {
          findings.push({ key, seat: seat.name, check: 'through', part: box.label, depth: hit.depth, point: hit.point });
        }
      }
    }
  } finally {
    figure.dispose();
  }
  return findings;
}

/** Every seat finding for one look, over every kind of seat. */
export function findAvatarSeating(
  key: AvatarSpriteKey,
  seats: readonly SeatType[] = seatTypes(),
): SeatFinding[] {
  return seats.flatMap((seat) => findSeatFindings(key, seat));
}

export function formatSeatFinding(finding: SeatFinding): string {
  const at = finding.point.map((value) => value.toFixed(3)).join(', ');
  return finding.check === 'rest'
    ? `${finding.key} on the ${finding.seat}: ${finding.part} rests ${finding.depth.toFixed(3)} ` +
      `${finding.depth < 0 ? 'below' : 'above'} the seat top at (${at})`
    : `${finding.key} on the ${finding.seat}: ${finding.part} is ${finding.depth.toFixed(3)} inside it at (${at})`;
}
