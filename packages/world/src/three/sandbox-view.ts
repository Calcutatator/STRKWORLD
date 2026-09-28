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
 * are dropped rather than drawn.
 */

/** 8 toy-block colours; index = `SandboxColumn` colour. Lives in the palette. */
export const SANDBOX_BLOCK_PALETTE: readonly number[] = SANDBOX_THEME.blocks;

/** Live blocks plus room for blocks still popping out. */
export const SANDBOX_INSTANCE_CAPACITY = SANDBOX_MAX_BLOCKS + 128;

/** Edge of a carried block, in world units. */
export const CARRIED_BLOCK_SIZE = 0.55;

const SETTLE_HEIGHT = 1;
const SETTLE_MS = 240;
const DROP_HEIGHT = 40;
const GRAVITY = 42;
/** Rebound speed after a sky drop lands: a hop of a few centimetres. */
const BOUNCE_SPEED = 2.2;
const LEAVE_MS = 180;

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
  /** Where E will act: a pulsing ghost and outline; null hides it. */
  setTarget(target: SandboxTarget | null): void;
  update(deltaMs: number): void;
  dispose(): void;
}

export interface CarriedBlock {
  readonly object: Object3D;
  /** A palette index shows the block; null (or a bad index) hides it. */
  setColour(colour: number | null): void;
  dispose(): void;
}

type BlockState = 'idle' | 'settle' | 'drop' | 'leave';

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

const PALETTE_COLOURS = SANDBOX_BLOCK_PALETTE.map((hex) => new Color(hex));
const scratchMatrix = new Matrix4();
const scratchPosition = new Vector3();
const scratchScale = new Vector3();
const IDENTITY = new Quaternion();

export function buildSandbox(): SandboxView {
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
  const leaving: Block[] = [];
  const slots: (Block | null)[] = new Array(SANDBOX_INSTANCE_CAPACITY).fill(null);
  const animating = new Set<Block>();
  let active = 0;
  let elapsed = 0;
  let targetState: { pick: boolean; valid: boolean } | null = null;
  let disposed = false;

  const writeMatrix = (block: Block): void => {
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
        break;
    }
    scratchPosition.set(block.x + 0.5, y, block.y + 0.5);
    scratchScale.set(s, sy, s);
    scratchMatrix.compose(scratchPosition, IDENTITY, scratchScale);
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
      // Out of room: finish the oldest pop-out now rather than drop a live block.
      const victim = leaving.shift();
      if (!victim) return false;
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
    leaving.push(block);
    animating.add(block);
    writeMatrix(block);
  };

  const flush = (): void => {
    matrixUploads.flush();
    colourUploads.flush();
  };

  const styleTarget = (pulse: number): void => {
    if (!targetState) return;
    const colour = targetState.valid ? SANDBOX_THEME.targetValid : SANDBOX_THEME.targetInvalid;
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
          const block: Block = { x: column.x, y: column.y, k, colour: column.colours[k]!, state: 'settle', t: 0, index: -1 };
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
      targetState = { pick, valid: value.valid === true };
      target.userData = { mode: value.mode, valid: value.valid === true, level };
      styleTarget(0.5 + 0.5 * Math.sin((elapsed / 1000) * 6));
    },
    update(deltaMs) {
      if (disposed) return;
      const dt = Number.isFinite(deltaMs) && deltaMs > 0 ? Math.min(deltaMs, 250) : 0;
      elapsed += dt;
      if (dt > 0) {
        for (const block of animating) {
          block.t += dt;
          if (block.state === 'leave') {
            if (block.t >= LEAVE_MS) {
              animating.delete(block);
              const at = leaving.indexOf(block);
              if (at >= 0) leaving.splice(at, 1);
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
      leaving.length = 0;
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
