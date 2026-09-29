import {
  BoxGeometry,
  BufferGeometry,
  Color,
  DynamicDrawUsage,
  EdgesGeometry,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  Vector3,
} from 'three';
import type { BufferAttribute, Object3D } from 'three';
import {
  SANDBOX_AREA,
  SANDBOX_BURST_HEIGHT,
  SANDBOX_COLOURS,
  SANDBOX_MAX_BLOCKS,
  SANDBOX_MAX_HEIGHT,
  type SandboxColumn,
  type SandboxTile,
} from '@strkworld/shared';
import { SANDBOX_THEME } from './palette.js';

/**
 * The block sandbox's blocks in 3D (D-060).
 *
 * Presentation only: the lobby (or the Shell's solo rules) owns the stacks;
 * this view draws whatever columns it is given, diffs them against what it
 * drew last, and animates the difference. Every block is one instance of a
 * single InstancedMesh, so a full 900-block sandbox is one draw call, and a
 * frame only re-uploads the instances that moved. Input is untrusted: tiles
 * outside the area, bad colours and anything past the height and block caps
 * are dropped rather than drawn. A burst (D-071) throws every block it draws
 * away at once and leaves the board empty.
 */

/** 8 toy-block colours; index = `SandboxColumn` colour. Lives in the palette. */
export const SANDBOX_BLOCK_PALETTE: readonly number[] = SANDBOX_THEME.blocks;

/** Live blocks plus room for blocks still popping out or flying from a burst. */
export const SANDBOX_INSTANCE_CAPACITY = SANDBOX_MAX_BLOCKS + 128;

/** How long a burst block flies before it is gone (D-071). */
export const SANDBOX_BURST_MS = 1400;

/** Edge of a carried block, in world units. */
export const CARRIED_BLOCK_SIZE = 0.55;

const SETTLE_HEIGHT = 1;
const SETTLE_MS = 240;
const DROP_HEIGHT = 40;
const GRAVITY = 58; // D-075: raised from 42 so sky drops fall a little faster.
/** Rebound speed after a sky drop lands: a hop of a few centimetres. */
const BOUNCE_SPEED = 2.2;
const LEAVE_MS = 180;
/** A burst block's gravity, in units/s²: floatier than a sky drop's, so the throw reads. */
const BURST_GRAVITY = 16;
/** A burst block shrinks away over the end of its flight. */
const BURST_SHRINK_MS = 450;
/** Outward speed, units/s: a base, a random part, and a boost that fades with distance from the burst. */
const BURST_SPEED = 4;
const BURST_SPEED_RANGE = 6;
const BURST_NEAR_BOOST = 6;
/** How far, in radians, a throw may stray from straight out of the burst tile. */
const BURST_SPREAD = 0.8;
/** The upward kick, units/s. */
const BURST_KICK = 10;
const BURST_KICK_RANGE = 6;
/** Tumble rate, radians/s. */
const BURST_SPIN = 3;
const BURST_SPIN_RANGE = 9;

export interface SandboxTarget {
  readonly x: number;
  readonly y: number;
  /** Height in blocks of the face acted on: the column height, in both modes. */
  readonly level: number;
  readonly mode: 'pick' | 'place';
  readonly valid: boolean;
}

export interface SandboxView {
  readonly group: Group;
  /** Full replacement of state; diffed internally. */
  setColumns(columns: readonly SandboxColumn[]): void;
  /**
   * A sky-drop hint for a block that has just appeared on this tile: if its
   * top block is still settling in, it falls from the sky instead. Hints come
   * after the state that adds the block (the lobby's order, and solo's); a
   * hint for anything else is ignored, so it can never re-drop a placed block.
   */
  expectDrop(tile: SandboxTile): void;
  /**
   * D-071: the sandbox burst at this tile. Every block drawn now — standing,
   * arriving or already popping out — flies away from it, tumbling, and is
   * gone after `SANDBOX_BURST_MS`; for a player who asked for less motion it
   * pops out instead. The board is then empty, so the empty snapshot that
   * follows changes nothing, and one that came first leaves the same blocks
   * to throw. Each block's throw depends only on its tile, its level and the
   * burst tile, so every client draws the same explosion.
   */
  burst(tile: SandboxTile): void;
  /** Where E will act: a pulsing ghost and outline; null hides it. */
  setTarget(target: SandboxTarget | null): void;
  update(deltaMs: number): void;
  dispose(): void;
}

export interface SandboxViewOptions {
  /** Whether the player asked for less motion (`prefers-reduced-motion`); read at each burst. */
  readonly reducedMotion?: () => boolean;
}

export interface CarriedBlock {
  readonly object: Object3D;
  /** A palette index shows the block; null (or a bad index) hides it. */
  setColour(colour: number | null): void;
  dispose(): void;
}

type BlockState = 'idle' | 'settle' | 'drop' | 'leave' | 'burst';

/** A burst block's throw (D-071), fixed when the burst reaches it. */
interface Flight {
  /** Its centre and scale as drawn when the burst hit it. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly scale: number;
  /** Units per second. */
  readonly vx: number;
  readonly vy: number;
  readonly vz: number;
  /** A unit axis and a rate in radians per second. */
  readonly axis: Vector3;
  readonly spin: number;
}

interface Block {
  readonly x: number;
  readonly y: number;
  readonly k: number;
  readonly colour: number;
  state: BlockState;
  /** Milliseconds since the state began. */
  t: number;
  /** Instance slot, or -1 once released. */
  index: number;
  /** While bursting, how it flies; null otherwise. */
  flight: Flight | null;
}

export function isSandboxTile(x: unknown, y: unknown): x is number {
  return (
    typeof x === 'number' &&
    typeof y === 'number' &&
    Number.isInteger(x) &&
    Number.isInteger(y) &&
    x >= SANDBOX_AREA.x &&
    x < SANDBOX_AREA.x + SANDBOX_AREA.width &&
    y >= SANDBOX_AREA.y &&
    y < SANDBOX_AREA.y + SANDBOX_AREA.height
  );
}

function isColour(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < Math.min(SANDBOX_COLOURS, SANDBOX_BLOCK_PALETTE.length)
  );
}

function tileKey(x: number, y: number): number {
  return y * 1024 + x;
}

/**
 * Validate and cap a snapshot. A column stops at its first bad colour (a block
 * that cannot be drawn truthfully, and everything resting on it, is not
 * drawn), duplicate tiles keep their first entry, and the block cap cuts
 * columns in a stable (y, x) order so every client drops the same blocks.
 */
function normalise(columns: unknown): Map<number, { x: number; y: number; colours: number[] }> {
  const valid: { key: number; x: number; y: number; colours: number[] }[] = [];
  if (Array.isArray(columns)) {
    const seen = new Set<number>();
    for (const column of columns as unknown[]) {
      try {
        if (column === null || typeof column !== 'object') continue;
        const { x, y, colours } = column as { x?: unknown; y?: unknown; colours?: unknown };
        if (!isSandboxTile(x, y) || typeof y !== 'number') continue;
        const key = tileKey(x, y);
        if (seen.has(key)) continue;
        seen.add(key);
        if (!Array.isArray(colours)) continue;
        const stack: number[] = [];
        for (const colour of colours as unknown[]) {
          if (!isColour(colour) || stack.length >= SANDBOX_MAX_HEIGHT) break;
          stack.push(colour);
        }
        if (stack.length > 0) valid.push({ key, x, y, colours: stack });
      } catch {
        // A hostile accessor fails closed: that column is not drawn.
      }
    }
  }
  valid.sort((a, b) => a.y - b.y || a.x - b.x);
  const out = new Map<number, { x: number; y: number; colours: number[] }>();
  let budget = SANDBOX_MAX_BLOCKS;
  for (const column of valid) {
    if (budget <= 0) break;
    const colours = column.colours.slice(0, budget);
    budget -= colours.length;
    out.set(column.key, { x: column.x, y: column.y, colours });
  }
  return out;
}

/**
 * A cube with chamfered edges, centred on the origin: 44 flat triangles, the
 * toy-block look without studs. Stacked blocks keep a visible groove.
 */
export function bevelledBlockGeometry(size = 1, bevel = 0.07): BufferGeometry {
  const h = size / 2;
  const i = h - Math.min(bevel, h * 0.45);
  const positions: number[] = [];
  const tri = (a: readonly number[], b: readonly number[], c: readonly number[]): void => {
    const ux = b[0]! - a[0]!;
    const uy = b[1]! - a[1]!;
    const uz = b[2]! - a[2]!;
    const vx = c[0]! - a[0]!;
    const vy = c[1]! - a[1]!;
    const vz = c[2]! - a[2]!;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    // Convex and centred: a face points outward when it points away from the origin.
    const outward = nx * (a[0]! + b[0]! + c[0]!) + ny * (a[1]! + b[1]! + c[1]!) + nz * (a[2]! + b[2]! + c[2]!) >= 0;
    positions.push(...a, ...(outward ? b : c), ...(outward ? c : b));
  };
  const quad = (a: number[], b: number[], c: number[], d: number[]): void => {
    tri(a, b, c);
    tri(a, c, d);
  };
  const point = (axis: number, along: number, first: number, second: number): number[] => {
    const p = [0, 0, 0];
    p[axis] = along;
    p[(axis + 1) % 3] = first;
    p[(axis + 2) % 3] = second;
    return p;
  };
  for (let axis = 0; axis < 3; axis++) {
    for (const s of [-1, 1]) {
      quad(point(axis, s * h, -i, -i), point(axis, s * h, i, -i), point(axis, s * h, i, i), point(axis, s * h, -i, i));
    }
  }
  for (let axis = 0; axis < 3; axis++) {
    for (const s1 of [-1, 1]) {
      for (const s2 of [-1, 1]) {
        // The chamfer between the faces normal to axis+1 (sign s1) and axis+2 (sign s2).
        quad(
          point(axis, -i, s1 * h, s2 * i),
          point(axis, i, s1 * h, s2 * i),
          point(axis, i, s1 * i, s2 * h),
          point(axis, -i, s1 * i, s2 * h),
        );
      }
    }
  }
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      for (const sz of [-1, 1]) tri([sx * h, sy * i, sz * i], [sx * i, sy * h, sz * i], [sx * i, sy * i, sz * h]);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

/**
 * The instances of one attribute written since three last uploaded it.
 *
 * three uploads an attribute's update ranges only when it next draws the
 * mesh, and clears them itself once they are uploaded
 * (`WebGLAttributes.updateBuffer`). Several flushes can land before that
 * draw — two lobby patches in one frame, or a patch and then the frame's own
 * `update()` — so a flush must not replace a range three has not drawn yet:
 * the replaced instances would never reach the GPU and would keep whatever it
 * last held, for a colour never uploaded the attribute's initial white. The
 * range handed to three therefore covers everything written since its last
 * upload, and the attribute's upload callback resets it: one range per
 * attribute, however many flushes go undrawn (a hidden tab draws nothing).
 */
interface UploadTracker {
  /** Instance `index` was written. */
  mark(index: number): void;
  /** Hand three one range covering every instance it has not uploaded. */
  flush(): void;
}

function trackUploads(attribute: BufferAttribute, itemSize: number): UploadTracker {
  // Handed to three and not yet uploaded; written since the last flush.
  let pendingMin = Infinity;
  let pendingMax = -Infinity;
  let freshMin = Infinity;
  let freshMax = -Infinity;
  attribute.onUpload(() => {
    pendingMin = Infinity;
    pendingMax = -Infinity;
  });
  return {
    mark(index) {
      if (index < freshMin) freshMin = index;
      if (index > freshMax) freshMax = index;
    },
    flush() {
      if (freshMax < freshMin) return;
      pendingMin = Math.min(pendingMin, freshMin);
      pendingMax = Math.max(pendingMax, freshMax);
      freshMin = Infinity;
      freshMax = -Infinity;
      attribute.clearUpdateRanges();
      attribute.addUpdateRange(pendingMin * itemSize, (pendingMax - pendingMin + 1) * itemSize);
      attribute.needsUpdate = true;
    },
  };
}

/**
 * Uniform draws in `[0, 1)` seeded only by integers, so every client that
 * seeds one the same way draws the same sequence (D-071's shared explosion).
 */
function seededDraws(seeds: readonly number[]): () => number {
  let a = 0x9e3779b9;
  for (const seed of seeds) {
    a = Math.imul(a ^ (seed | 0), 0x85ebca6b);
    a ^= a >>> 13;
    a = Math.imul(a, 0xc2b2ae35);
    a ^= a >>> 16;
  }
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PALETTE_COLOURS = SANDBOX_BLOCK_PALETTE.map((hex) => new Color(hex));
const scratchMatrix = new Matrix4();
const scratchPosition = new Vector3();
const scratchScale = new Vector3();
const scratchRotation = new Quaternion();
const IDENTITY = new Quaternion();

export function buildSandbox(options: SandboxViewOptions = {}): SandboxView {
  const group = new Group();
  group.name = 'sandbox';

  const geometry = bevelledBlockGeometry(1, 0.07);
  // Toy plastic: a touch glossier than the city.
  const material = new MeshStandardMaterial({ color: 0xffffff, roughness: 0.5, metalness: 0, flatShading: true });
  const mesh = new InstancedMesh(geometry, material, SANDBOX_INSTANCE_CAPACITY);
  mesh.name = 'sandbox:blocks';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  // Stacks reach 256 units; a stale bounding sphere must never cull a tower.
  mesh.frustumCulled = false;
  mesh.instanceMatrix.setUsage(DynamicDrawUsage);
  mesh.setColorAt(0, PALETTE_COLOURS[0]!);
  mesh.instanceColor!.setUsage(DynamicDrawUsage);
  mesh.count = 0;
  group.add(mesh);
  const matrixUploads = trackUploads(mesh.instanceMatrix, 16);
  const colourUploads = trackUploads(mesh.instanceColor!, 3);

  // The target: a flat ring on the column's tile, and a ghost block with an outline.
  const target = new Group();
  target.name = 'sandbox:target';
  target.visible = false;
  const ringGeometry = targetRingGeometry();
  const ringMaterial = new MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false });
  const ring = new Mesh(ringGeometry, ringMaterial);
  ring.name = 'sandbox:target-ring';
  ring.position.y = 0.012;
  ring.renderOrder = 3;
  const marker = new Group();
  marker.name = 'sandbox:target-marker';
  const ghostMaterial = new MeshBasicMaterial({ transparent: true, depthWrite: false, toneMapped: false });
  const ghost = new Mesh(geometry, ghostMaterial);
  ghost.name = 'sandbox:target-ghost';
  ghost.renderOrder = 3;
  const boxGeometry = new BoxGeometry(1.04, 1.04, 1.04);
  const outlineGeometry = new EdgesGeometry(boxGeometry);
  boxGeometry.dispose();
  const outlineMaterial = new LineBasicMaterial({ transparent: true, toneMapped: false });
  const outline = new LineSegments(outlineGeometry, outlineMaterial);
  outline.name = 'sandbox:target-outline';
  outline.renderOrder = 4;
  marker.add(ghost, outline);
  target.add(ring, marker);
  group.add(target);

  const columns = new Map<number, Block[]>();
  /** Blocks on their way out, popping or flying, oldest first: they still hold slots. */
  const leaving = new Set<Block>();
  const slots: (Block | null)[] = new Array(SANDBOX_INSTANCE_CAPACITY).fill(null);
  const animating = new Set<Block>();
  let active = 0;
  let elapsed = 0;
  let targetState: { pick: boolean; valid: boolean; burst: boolean } | null = null;
  let disposed = false;

  const reducedMotion = (): boolean => {
    try {
      return options.reducedMotion?.() === true;
    } catch {
      return false;
    }
  };

  /** A block's drawn centre height and scale, in every state but a burst's flight. */
  const posed = { y: 0, s: 1, sy: 1 };
  const pose = (block: Block): void => {
    const rest = block.k + 0.5;
    let y = rest;
    let s = 1;
    let sy = 1;
    switch (block.state) {
      case 'settle': {
        const p = Math.min(1, block.t / SETTLE_MS);
        const ease = 1 - (1 - p) ** 3;
        y = rest + SETTLE_HEIGHT * (1 - ease);
        s = 0.82 + 0.18 * ease;
        sy = s;
        break;
      }
      case 'drop': {
        const seconds = block.t / 1000;
        const fall = Math.sqrt((2 * DROP_HEIGHT) / GRAVITY);
        if (seconds < fall) {
          y = rest + DROP_HEIGHT - 0.5 * GRAVITY * seconds * seconds;
        } else {
          const tb = seconds - fall;
          const hop = Math.max(0, BOUNCE_SPEED * tb - 0.5 * GRAVITY * tb * tb);
          // A quick squash as it lands, bottom kept on the stack.
          const squash = Math.max(0, 1 - tb / 0.09);
          sy = 1 - 0.14 * squash;
          s = 1 + 0.07 * squash;
          y = rest + hop - 0.5 * (1 - sy);
        }
        break;
      }
      case 'leave': {
        const p = Math.min(1, block.t / LEAVE_MS);
        y = rest + 0.25 * p;
        s = Math.max(0.001, 1 - p);
        sy = s;
        break;
      }
      case 'idle':
      case 'burst':
        break;
    }
    posed.y = y;
    posed.s = s;
    posed.sy = sy;
  };

  const writeMatrix = (block: Block): void => {
    const flight = block.state === 'burst' ? block.flight : null;
    if (flight) {
      // Thrown out and up under gravity, tumbling, shrinking away at the end.
      // Its bottom never sinks through the floor: a low throw lands and lies
      // there while it shrinks.
      const seconds = block.t / 1000;
      const shrink = Math.min(1, Math.max(0, (block.t - (SANDBOX_BURST_MS - BURST_SHRINK_MS)) / BURST_SHRINK_MS));
      const scale = Math.max(0.001, flight.scale * (1 - shrink * shrink));
      const y = flight.y + flight.vy * seconds - 0.5 * BURST_GRAVITY * seconds * seconds;
      scratchPosition.set(flight.x + flight.vx * seconds, Math.max(0.5 * scale, y), flight.z + flight.vz * seconds);
      scratchRotation.setFromAxisAngle(flight.axis, flight.spin * seconds);
      scratchScale.setScalar(scale);
      scratchMatrix.compose(scratchPosition, scratchRotation, scratchScale);
    } else {
      pose(block);
      scratchPosition.set(block.x + 0.5, posed.y, block.y + 0.5);
      scratchScale.set(posed.s, posed.sy, posed.s);
      scratchMatrix.compose(scratchPosition, IDENTITY, scratchScale);
    }
    mesh.setMatrixAt(block.index, scratchMatrix);
    matrixUploads.mark(block.index);
  };

  const writeColour = (block: Block): void => {
    mesh.setColorAt(block.index, PALETTE_COLOURS[block.colour]!);
    colourUploads.mark(block.index);
  };

  const finished = (block: Block): boolean => {
    if (block.state === 'settle') return block.t >= SETTLE_MS;
    if (block.state === 'drop') {
      const fall = Math.sqrt((2 * DROP_HEIGHT) / GRAVITY);
      return block.t / 1000 >= fall + (2 * BOUNCE_SPEED) / GRAVITY && block.t / 1000 >= fall + 0.09;
    }
    return false;
  };

  /** Swap-remove keeps instances 0..active-1 dense, so `count` is exact. */
  const release = (block: Block): void => {
    const index = block.index;
    if (index < 0) return;
    const last = active - 1;
    if (index !== last) {
      const moved = slots[last]!;
      slots[index] = moved;
      moved.index = index;
      writeMatrix(moved);
      writeColour(moved);
    }
    slots[last] = null;
    active = last;
    mesh.count = active;
    block.index = -1;
  };

  const allocate = (block: Block): boolean => {
    while (active >= SANDBOX_INSTANCE_CAPACITY) {
      // Out of room: finish the oldest pop-out or burst block now rather than
      // drop a live block.
      const victim = leaving.values().next().value;
      if (victim === undefined) return false;
      leaving.delete(victim);
      animating.delete(victim);
      release(victim);
    }
    block.index = active;
    slots[active] = block;
    active += 1;
    mesh.count = active;
    writeColour(block);
    writeMatrix(block);
    return true;
  };

  const startLeaving = (block: Block): void => {
    block.state = 'leave';
    block.t = 0;
    leaving.add(block);
    animating.add(block);
    writeMatrix(block);
  };

  /**
   * Throw a block away from the burst at `tile` (D-071), from wherever it is
   * drawn now. Seeded by its tile, its level and the burst tile alone, so
   * every client throws it the same way.
   */
  const launch = (block: Block, tile: SandboxTile): void => {
    pose(block);
    const draw = seededDraws([block.x, block.y, block.k, tile.x, tile.y]);
    const [stray, pace, kick, turn, tilt, rate, sense] = [draw(), draw(), draw(), draw(), draw(), draw(), draw()];
    const dx = block.x - tile.x;
    const dz = block.y - tile.y;
    const distance = Math.hypot(dx, dz);
    // Straight out of the burst tile, give or take; its own column's blocks fly anywhere.
    const heading = distance > 0 ? Math.atan2(dz, dx) + (stray - 0.5) * BURST_SPREAD : stray * Math.PI * 2;
    const speed = BURST_SPEED + pace * BURST_SPEED_RANGE + BURST_NEAR_BOOST / (1 + 0.5 * distance);
    const cosTilt = tilt * 2 - 1;
    const sinTilt = Math.sqrt(1 - cosTilt * cosTilt);
    block.flight = {
      x: block.x + 0.5,
      y: posed.y,
      z: block.y + 0.5,
      scale: posed.s,
      vx: Math.cos(heading) * speed,
      vy: BURST_KICK + kick * BURST_KICK_RANGE,
      vz: Math.sin(heading) * speed,
      axis: new Vector3(sinTilt * Math.cos(turn * Math.PI * 2), sinTilt * Math.sin(turn * Math.PI * 2), cosTilt),
      spin: (BURST_SPIN + rate * BURST_SPIN_RANGE) * (sense < 0.5 ? -1 : 1),
    };
    block.state = 'burst';
    block.t = 0;
    // Its flight starts now, so it is the newest to go.
    leaving.delete(block);
    leaving.add(block);
    animating.add(block);
    writeMatrix(block);
  };

  const flush = (): void => {
    matrixUploads.flush();
    colourUploads.flush();
  };

  const styleTarget = (pulse: number): void => {
    if (!targetState) return;
    const colour = targetState.burst
      ? SANDBOX_THEME.targetBurst
      : targetState.valid
        ? SANDBOX_THEME.targetValid
        : SANDBOX_THEME.targetInvalid;
    for (const targetMaterial of [ringMaterial, ghostMaterial, outlineMaterial]) targetMaterial.color.setHex(colour);
    ghostMaterial.opacity = (targetState.pick ? 0.2 : 0.38) * (0.75 + 0.25 * pulse);
    outlineMaterial.opacity = 0.7 + 0.3 * pulse;
    ringMaterial.opacity = 0.55 + 0.35 * pulse;
    marker.scale.setScalar((targetState.pick ? 1.05 : 1) + 0.025 * pulse);
  };

  return {
    group,
    setColumns(input) {
      if (disposed) return;
      const next = normalise(input);
      for (const [key, blocks] of columns) {
        const wanted = next.get(key)?.colours ?? [];
        let keep = 0;
        while (keep < blocks.length && keep < wanted.length && blocks[keep]!.colour === wanted[keep]) keep++;
        for (let k = blocks.length - 1; k >= keep; k--) startLeaving(blocks[k]!);
        blocks.length = keep;
        if (keep === 0) columns.delete(key);
      }
      for (const [key, column] of next) {
        let blocks = columns.get(key);
        if (!blocks) {
          blocks = [];
          columns.set(key, blocks);
        }
        for (let k = blocks.length; k < column.colours.length; k++) {
          const block: Block = {
            x: column.x,
            y: column.y,
            k,
            colour: column.colours[k]!,
            state: 'settle',
            t: 0,
            index: -1,
            flight: null,
          };
          if (!allocate(block)) break;
          animating.add(block);
          blocks.push(block);
        }
        if (blocks.length === 0) columns.delete(key);
      }
      flush();
    },
    expectDrop(tile) {
      if (disposed || tile === null || typeof tile !== 'object') return;
      if (!isSandboxTile(tile.x, tile.y)) return;
      const key = tileKey(tile.x, tile.y);
      // The hint follows the state that adds the block, so the block is here,
      // settling from a short drop. Upgrade it to a sky drop while it is still
      // arriving. A settled block is left alone, and a sky drop never lands
      // where a player just placed one (drops keep a tile away from players).
      const stack = columns.get(key);
      const top = stack?.[stack.length - 1];
      if (!top || top.state !== 'settle' || top.t >= SETTLE_MS) return;
      top.state = 'drop';
      top.t = 0;
      animating.add(top);
      writeMatrix(top);
      flush();
    },
    burst(tile) {
      if (disposed || tile === null || typeof tile !== 'object') return;
      if (!isSandboxTile(tile.x, tile.y)) return;
      // Everything drawn now: the board, and blocks already popping out (an
      // empty snapshot that arrived first). Blocks already flying keep flying.
      const thrown: Block[] = [];
      for (const blocks of columns.values()) thrown.push(...blocks);
      for (const block of leaving) if (block.state === 'leave') thrown.push(block);
      columns.clear();
      const still = reducedMotion();
      for (const block of thrown) {
        if (!still) launch(block, tile);
        else if (block.state !== 'leave') startLeaving(block);
      }
      flush();
    },
    setTarget(value) {
      if (disposed) return;
      const valid =
        value !== null &&
        typeof value === 'object' &&
        isSandboxTile(value.x, value.y) &&
        Number.isFinite(value.level) &&
        (value.mode === 'pick' || value.mode === 'place');
      if (!valid) {
        target.visible = false;
        targetState = null;
        target.userData = {};
        return;
      }
      const level = Math.min(SANDBOX_MAX_HEIGHT, Math.max(0, Math.floor(value.level)));
      const pick = value.mode === 'pick';
      target.position.set(value.x + 0.5, 0, value.y + 0.5);
      // Picking takes the top block (centred half a block under the column
      // top); placing lands a new block on it. An empty tile has nothing to
      // pick, so only its ring shows.
      marker.visible = !(pick && level < 1);
      marker.position.y = pick ? level - 0.5 : level + 0.5;
      target.visible = true;
      // D-071: a place onto a full column would burst the sandbox; say so.
      const burst = !pick && value.valid === true && level >= SANDBOX_BURST_HEIGHT;
      targetState = { pick, valid: value.valid === true, burst };
      target.userData = { mode: value.mode, valid: value.valid === true, level, burst };
      styleTarget(0.5 + 0.5 * Math.sin((elapsed / 1000) * 6));
    },
    update(deltaMs) {
      if (disposed) return;
      const dt = Number.isFinite(deltaMs) && deltaMs > 0 ? Math.min(deltaMs, 250) : 0;
      elapsed += dt;
      if (dt > 0) {
        for (const block of animating) {
          block.t += dt;
          if (block.state === 'leave' || block.state === 'burst') {
            if (block.t >= (block.state === 'leave' ? LEAVE_MS : SANDBOX_BURST_MS)) {
              animating.delete(block);
              leaving.delete(block);
              release(block);
              continue;
            }
          } else if (finished(block)) {
            block.state = 'idle';
            animating.delete(block);
          }
          writeMatrix(block);
        }
      }
      styleTarget(0.5 + 0.5 * Math.sin((elapsed / 1000) * 6));
      flush();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      columns.clear();
      leaving.clear();
      animating.clear();
      group.removeFromParent();
      group.clear();
      mesh.dispose();
      geometry.dispose();
      material.dispose();
      ringGeometry.dispose();
      ringMaterial.dispose();
      ghostMaterial.dispose();
      outlineGeometry.dispose();
      outlineMaterial.dispose();
    },
  };
}

/** A flat square frame on a tile, for the target's footprint. */
function targetRingGeometry(): BufferGeometry {
  const o = 0.5;
  const i = 0.4;
  const quads: number[][] = [
    [-o, -o, o, -i],
    [-o, i, o, o],
    [-o, -i, -i, i],
    [i, -i, o, i],
  ];
  const positions: number[] = [];
  for (const [x0, z0, x1, z1] of quads) {
    positions.push(x0!, 0, z0!, x0!, 0, z1!, x1!, 0, z1!, x0!, 0, z0!, x1!, 0, z1!, x1!, 0, z0!);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}

// ---------------------------------------------------------------------------
// Carried blocks: one per avatar, so they share a cached geometry and one
// material per colour. `disposeSandboxCaches` releases them at engine teardown.
// ---------------------------------------------------------------------------

let carriedGeometry: BufferGeometry | null = null;
const carriedMaterials = new Map<number, MeshStandardMaterial>();

function sharedCarriedGeometry(): BufferGeometry {
  carriedGeometry ??= bevelledBlockGeometry(CARRIED_BLOCK_SIZE, 0.04);
  return carriedGeometry;
}

function sharedCarriedMaterial(colour: number): MeshStandardMaterial {
  let material = carriedMaterials.get(colour);
  if (!material) {
    material = new MeshStandardMaterial({
      color: SANDBOX_BLOCK_PALETTE[colour]!,
      roughness: 0.5,
      metalness: 0,
      flatShading: true,
    });
    carriedMaterials.set(colour, material);
  }
  return material;
}

/**
 * A ~0.55-unit block, centred on its origin, for the presenter to parent
 * above an avatar's head. Per instance it allocates one Mesh; geometry and
 * materials are shared, so its `dispose` detaches it and releases nothing
 * shared.
 */
export function createCarriedBlock(colour: number | null): CarriedBlock {
  const mesh = new Mesh(sharedCarriedGeometry(), sharedCarriedMaterial(0));
  mesh.name = 'sandbox:carried-block';
  mesh.castShadow = true;
  let disposed = false;
  const apply = (value: number | null): void => {
    if (!isColour(value)) {
      mesh.visible = false;
      mesh.userData['colour'] = null;
      return;
    }
    mesh.material = sharedCarriedMaterial(value);
    mesh.visible = true;
    mesh.userData['colour'] = value;
  };
  apply(colour);
  return {
    object: mesh,
    setColour(value) {
      if (!disposed) apply(value);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      mesh.visible = false;
      mesh.removeFromParent();
    },
  };
}

/** Engine teardown: release the geometry and materials shared by carried blocks. */
export function disposeSandboxCaches(): void {
  carriedGeometry?.dispose();
  carriedGeometry = null;
  for (const material of carriedMaterials.values()) material.dispose();
  carriedMaterials.clear();
}
