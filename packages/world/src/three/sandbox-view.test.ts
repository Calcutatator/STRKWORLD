import { describe, expect, it, vi } from 'vitest';
import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  Color,
  InstancedMesh,
  LineBasicMaterial,
  Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  Vector3,
} from 'three';
import {
  SANDBOX_AREA,
  SANDBOX_COLOURS,
  SANDBOX_MAX_BLOCKS,
  SANDBOX_MAX_HEIGHT,
  type SandboxColumn,
} from '@strkworld/shared';
import { SANDBOX_THEME } from './palette.js';
import {
  CARRIED_BLOCK_SIZE,
  SANDBOX_BLOCK_PALETTE,
  SANDBOX_INSTANCE_CAPACITY,
  buildSandbox,
  createCarriedBlock,
  disposeSandboxCaches,
  type SandboxView,
} from './sandbox-view.js';

const X = SANDBOX_AREA.x;
const Y = SANDBOX_AREA.y;

function blocks(view: SandboxView): InstancedMesh {
  return view.group.getObjectByName('sandbox:blocks') as InstancedMesh;
}

function instancePositions(view: SandboxView): Vector3[] {
  const mesh = blocks(view);
  const matrix = new Matrix4();
  return Array.from({ length: mesh.count }, (_, i) => {
    mesh.getMatrixAt(i, matrix);
    return new Vector3().setFromMatrixPosition(matrix);
  });
}

function blockAt(view: SandboxView, x: number, y: number, k: number): number {
  return instancePositions(view).findIndex(
    (p) => Math.abs(p.x - (x + 0.5)) < 1e-6 && Math.abs(p.z - (y + 0.5)) < 1e-6 && Math.abs(p.y - (k + 0.5)) < 1e-6,
  );
}

function colourAt(view: SandboxView, index: number): number {
  return blocks(view).getColorAt(index, new Color()).getHex();
}

function settle(view: SandboxView, ms = 3000): void {
  for (let t = 0; t < ms; t += 50) view.update(50);
}

function heightOf(view: SandboxView, index: number): number {
  return instancePositions(view)[index]!.y;
}

/** Deterministic PRNG, so a failure is reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface GpuMirror {
  /** One drawn frame: upload each instanced attribute exactly as three would. */
  draw(): void;
  /** The floats the GPU holds for instance `index`. */
  matrix(index: number): number[];
  colour(index: number): number[];
}

/**
 * What the GPU holds for the block mesh, updated the way three's
 * `WebGLAttributes` does it and only when a frame is drawn: the first draw
 * uploads the whole array (`createBuffer`, which leaves the update ranges
 * alone); a later draw, only if the version moved, uploads the update ranges —
 * the whole array when there are none — then clears them (`updateBuffer`).
 * Both then call the attribute's upload callback.
 */
function gpuMirror(mesh: InstancedMesh): GpuMirror {
  const mirror = (attribute: BufferAttribute, size: number) => {
    let data: Float32Array | null = null;
    let version = 0;
    return {
      draw(): void {
        const source = attribute.array as Float32Array;
        if (data === null) {
          data = Float32Array.from(source);
        } else if (version < attribute.version) {
          if (attribute.updateRanges.length === 0) {
            data.set(source);
          } else {
            for (const { start, count } of attribute.updateRanges) {
              data.set(source.subarray(start, start + count), start);
            }
            attribute.clearUpdateRanges();
          }
        } else {
          return;
        }
        version = attribute.version;
        attribute.onUploadCallback();
      },
      read(index: number): number[] {
        if (data === null) throw new Error('nothing drawn yet');
        return Array.from(data.subarray(index * size, (index + 1) * size));
      },
    };
  };
  const matrices = mirror(mesh.instanceMatrix, 16);
  const colours = mirror(mesh.instanceColor!, 3);
  return {
    draw() {
      matrices.draw();
      colours.draw();
    },
    matrix: (index) => matrices.read(index),
    colour: (index) => colours.read(index),
  };
}

/** A palette colour as the instance colour attribute stores it: linear, in float32. */
function paletteFloats(colour: number): number[] {
  return Array.from(new Float32Array(new Color(SANDBOX_BLOCK_PALETTE[colour]!).toArray()));
}

/** Every drawn instance whose GPU matrix or colour differs from the CPU arrays. */
function unmirrored(mesh: InstancedMesh, gpu: GpuMirror): string[] {
  const wrong: string[] = [];
  const matrices = mesh.instanceMatrix.array as Float32Array;
  const colours = mesh.instanceColor!.array as Float32Array;
  for (let index = 0; index < mesh.count; index += 1) {
    const matrix = Array.from(matrices.subarray(index * 16, index * 16 + 16));
    const colour = Array.from(colours.subarray(index * 3, index * 3 + 3));
    if (gpu.matrix(index).some((value, i) => value !== matrix[i])) wrong.push(`matrix ${index}`);
    if (gpu.colour(index).some((value, i) => value !== colour[i])) wrong.push(`colour ${index}`);
  }
  return wrong;
}

describe('instance uploads (three uploads update ranges only when it draws)', () => {
  it('keeps both of two patches that land between frames in the colour upload', () => {
    const view = buildSandbox();
    const mesh = blocks(view);
    const gpu = gpuMirror(mesh);
    gpu.draw();
    view.setColumns([{ x: X, y: Y, colours: [2] }]);
    view.setColumns([
      { x: X, y: Y, colours: [2] },
      { x: X + 1, y: Y, colours: [5] },
    ]);
    // No frame between the patches: both new instances are still pending.
    expect(mesh.instanceColor!.updateRanges).toEqual([{ start: 0, count: 6 }]);
    expect(mesh.instanceMatrix.updateRanges).toEqual([{ start: 0, count: 32 }]);
    gpu.draw();
    expect(unmirrored(mesh, gpu)).toEqual([]);
    expect(gpu.colour(0)).toEqual(paletteFloats(2));
    view.dispose();
  });

  it("keeps a patch's colours when the frame's update moves a block into a freed slot", () => {
    const view = buildSandbox();
    const mesh = blocks(view);
    const gpu = gpuMirror(mesh);
    view.setColumns([
      { x: X, y: Y, colours: [0] },
      { x: X + 1, y: Y, colours: [1] },
      { x: X + 2, y: Y, colours: [2] },
    ]);
    settle(view);
    gpu.draw();
    // One patch pops the middle block (slot 1) and adds two (slots 3 and 4)...
    view.setColumns([
      { x: X, y: Y, colours: [0] },
      { x: X + 2, y: Y, colours: [2] },
      { x: X + 3, y: Y, colours: [3] },
      { x: X + 4, y: Y, colours: [4] },
    ]);
    // ...and before the next frame, update() finishes the pop-out: the last
    // instance moves into slot 1, a colour write there.
    view.update(250);
    expect(mesh.count).toBe(4);
    expect(mesh.instanceColor!.updateRanges).toEqual([{ start: 3, count: 12 }]);
    gpu.draw();
    expect(unmirrored(mesh, gpu)).toEqual([]);
    // Slot 3 is the patch's first new block, which never moved: not white.
    expect(gpu.colour(3)).toEqual(paletteFloats(3));
    view.dispose();
  });

  it('forgets what three has uploaded: only later writes stay pending', () => {
    const view = buildSandbox();
    const mesh = blocks(view);
    const gpu = gpuMirror(mesh);
    view.setColumns([{ x: X, y: Y, colours: [0, 1] }]);
    gpu.draw();
    view.setColumns([{ x: X, y: Y, colours: [0, 1, 2] }]);
    expect(mesh.instanceColor!.updateRanges).toEqual([{ start: 6, count: 3 }]);
    expect(mesh.instanceMatrix.updateRanges).toEqual([{ start: 32, count: 16 }]);
    gpu.draw();
    expect(mesh.instanceColor!.updateRanges).toEqual([]);
    expect(mesh.instanceMatrix.updateRanges).toEqual([]);
    view.setColumns([{ x: X, y: Y, colours: [0, 1, 2, 3] }]);
    expect(mesh.instanceColor!.updateRanges).toEqual([{ start: 9, count: 3 }]);
    expect(mesh.instanceMatrix.updateRanges).toEqual([{ start: 48, count: 16 }]);
    gpu.draw();
    expect(unmirrored(mesh, gpu)).toEqual([]);
    view.dispose();
  });

  it('keeps one range per attribute however many flushes go undrawn', () => {
    const view = buildSandbox();
    const mesh = blocks(view);
    gpuMirror(mesh).draw();
    for (let n = 0; n < 50; n += 1) {
      view.setColumns([{ x: X + (n % 7), y: Y + Math.floor(n / 7), colours: [n % SANDBOX_COLOURS] }]);
      view.update(16);
    }
    expect(mesh.instanceMatrix.updateRanges).toHaveLength(1);
    expect(mesh.instanceColor!.updateRanges).toHaveLength(1);
    view.dispose();
  });

  it('draws what the CPU holds on every frame, whatever lands between frames (seeded)', () => {
    const tiles = 12;
    for (let seed = 1; seed <= 40; seed += 1) {
      const random = mulberry32(seed);
      const view = buildSandbox();
      const mesh = blocks(view);
      const gpu = gpuMirror(mesh);
      const stacks: number[][] = Array.from({ length: tiles }, () => []);
      const tileOf = (index: number) => ({ x: X + (index % 4), y: Y + Math.floor(index / 4) });
      const columns = (): SandboxColumn[] =>
        stacks.flatMap((colours, index) => (colours.length > 0 ? [{ ...tileOf(index), colours: [...colours] }] : []));
      for (let step = 0; step < 300; step += 1) {
        const roll = random();
        if (roll < 0.35) {
          // One patch: a block lands, is taken, or a column is rebuilt.
          const stack = stacks[Math.floor(random() * tiles)]!;
          const kind = random();
          if (kind < 0.5) stack.push(Math.floor(random() * SANDBOX_COLOURS));
          else if (kind < 0.85) stack.pop();
          else stack.splice(0, stack.length, ...Array.from({ length: Math.floor(random() * 4) }, () => Math.floor(random() * SANDBOX_COLOURS)));
          view.setColumns(columns());
        } else if (roll < 0.45) {
          view.expectDrop(tileOf(Math.floor(random() * tiles)));
        } else if (roll < 0.75) {
          view.update(Math.floor(random() * 120));
        } else {
          gpu.draw();
          expect(unmirrored(mesh, gpu), `seed ${seed}, step ${step}`).toEqual([]);
        }
      }
      view.dispose();
    }
  });
});

describe('late sky-drop hints (lobby order)', () => {
  it('upgrades a block that is still arriving into a sky drop', () => {
    const view = buildSandbox();
    view.setColumns([{ x: X + 3, y: Y + 3, colours: [2] }]);
    view.update(16);
    view.expectDrop({ x: X + 3, y: Y + 3 });
    view.update(16);
    const index = instancePositions(view).findIndex((p) => Math.abs(p.x - (X + 3.5)) < 1e-6);
    expect(heightOf(view, index)).toBeGreaterThan(20);
    settle(view);
    expect(blockAt(view, X + 3, Y + 3, 0)).toBeGreaterThanOrEqual(0);
    view.dispose();
  });

  it('leaves a block that has already settled where it is', () => {
    const view = buildSandbox();
    view.setColumns([{ x: X + 4, y: Y + 4, colours: [1] }]);
    settle(view);
    view.expectDrop({ x: X + 4, y: Y + 4 });
    view.update(16);
    expect(blockAt(view, X + 4, Y + 4, 0)).toBeGreaterThanOrEqual(0);
    view.dispose();
  });
});

describe('SANDBOX_BLOCK_PALETTE', () => {
  it('has one distinct colour per sandbox colour index, from the palette module', () => {
    expect(SANDBOX_BLOCK_PALETTE).toHaveLength(SANDBOX_COLOURS);
    expect(new Set(SANDBOX_BLOCK_PALETTE).size).toBe(SANDBOX_COLOURS);
    expect(SANDBOX_BLOCK_PALETTE).toBe(SANDBOX_THEME.blocks);
  });
});

describe('buildSandbox', () => {
  it('draws columns as stacked unit blocks centred on their tiles, in one instanced mesh', () => {
    const view = buildSandbox();
    const mesh = blocks(view);
    expect(mesh).toBeInstanceOf(InstancedMesh);
    expect(mesh.instanceMatrix.count).toBeGreaterThanOrEqual(SANDBOX_MAX_BLOCKS);
    expect(mesh.count).toBe(0);
    expect(mesh.castShadow && mesh.receiveShadow).toBe(true);
    expect(mesh.frustumCulled).toBe(false);

    view.setColumns([
      { x: X, y: Y, colours: [0, 1, 2] },
      { x: X + 5, y: Y + 3, colours: [4] },
    ]);
    settle(view);
    expect(mesh.count).toBe(4);
    for (const [x, y, k, colour] of [
      [X, Y, 0, 0],
      [X, Y, 1, 1],
      [X, Y, 2, 2],
      [X + 5, Y + 3, 0, 4],
    ] as const) {
      const index = blockAt(view, x, y, k);
      expect(index, `${x},${y},${k}`).toBeGreaterThanOrEqual(0);
      expect(colourAt(view, index)).toBe(new Color(SANDBOX_BLOCK_PALETTE[colour]!).getHex());
    }
    const box = new Box3().setFromBufferAttribute(mesh.geometry.getAttribute('position') as never);
    expect(box.max.x - box.min.x).toBeCloseTo(1);
    expect(box.max.y - box.min.y).toBeCloseTo(1);
    view.dispose();
  });

  it('settles new blocks in from about one unit above', () => {
    const view = buildSandbox();
    view.setColumns([{ x: X + 2, y: Y + 2, colours: [3] }]);
    const start = heightOf(view, 0);
    expect(start).toBeGreaterThan(0.5);
    expect(start).toBeLessThanOrEqual(1.51);
    view.update(120);
    const mid = heightOf(view, 0);
    expect(mid).toBeLessThan(start);
    expect(mid).toBeGreaterThan(0.5);
    settle(view);
    expect(heightOf(view, 0)).toBe(0.5);
    view.dispose();
  });

  it('diffs: growing a stack animates only the new block', () => {
    const view = buildSandbox();
    const mesh = blocks(view);
    view.setColumns([{ x: X, y: Y, colours: [0, 1] }]);
    settle(view);
    gpuMirror(mesh).draw();
    const before = Array.from(mesh.instanceMatrix.array.slice(0, 32));
    view.setColumns([{ x: X, y: Y, colours: [0, 1, 2] }]);
    expect(mesh.count).toBe(3);
    expect(Array.from(mesh.instanceMatrix.array.slice(0, 32))).toEqual(before);
    // Once the settled stack has been drawn, only the new instance is queued.
    expect(mesh.instanceMatrix.updateRanges).toEqual([{ start: 32, count: 16 }]);
    settle(view);
    expect(blockAt(view, X, Y, 2)).toBeGreaterThanOrEqual(0);
    view.dispose();
  });

  it('pops removed blocks out, then frees their instances', () => {
    const view = buildSandbox();
    const mesh = blocks(view);
    view.setColumns([{ x: X, y: Y, colours: [0, 1, 2] }]);
    settle(view);
    view.setColumns([{ x: X, y: Y, colours: [0, 1] }]);
    expect(mesh.count).toBe(3);
    view.update(60);
    expect(mesh.count).toBe(3);
    settle(view, 500);
    expect(mesh.count).toBe(2);
    expect(blockAt(view, X, Y, 0)).toBeGreaterThanOrEqual(0);
    expect(blockAt(view, X, Y, 1)).toBeGreaterThanOrEqual(0);
    view.setColumns([]);
    settle(view, 500);
    expect(mesh.count).toBe(0);
    view.dispose();
  });

  it('treats reordered columns as no change', () => {
    const view = buildSandbox();
    const mesh = blocks(view);
    const a: SandboxColumn = { x: X, y: Y, colours: [0, 1] };
    const b: SandboxColumn = { x: X + 1, y: Y + 1, colours: [2] };
    view.setColumns([a, b]);
    settle(view);
    const version = mesh.instanceMatrix.version;
    const matrices = Array.from(mesh.instanceMatrix.array.slice(0, mesh.count * 16));
    view.setColumns([b, a]);
    view.update(16);
    expect(mesh.instanceMatrix.version).toBe(version);
    expect(Array.from(mesh.instanceMatrix.array.slice(0, mesh.count * 16))).toEqual(matrices);
    view.dispose();
  });

  it('replaces a block whose colour changed', () => {
    const view = buildSandbox();
    view.setColumns([{ x: X, y: Y, colours: [0, 1] }]);
    settle(view);
    view.setColumns([{ x: X, y: Y, colours: [0, 6] }]);
    settle(view);
    expect(blocks(view).count).toBe(2);
    expect(colourAt(view, blockAt(view, X, Y, 1))).toBe(new Color(SANDBOX_BLOCK_PALETTE[6]!).getHex());
    view.dispose();
  });

  it('drops an expected block from the sky and lands it exactly on the stack, with a tiny bounce', () => {
    const view = buildSandbox();
    view.setColumns([{ x: X + 4, y: Y + 4, colours: [0, 1] }]);
    settle(view);
    view.setColumns([
      { x: X + 4, y: Y + 4, colours: [0, 1, 5] },
      { x: X + 9, y: Y + 9, colours: [2] },
    ]);
    // The hint follows the state that adds the block, as the lobby sends it.
    view.expectDrop({ x: X + 4, y: Y + 4 });
    const dropIndex = instancePositions(view).findIndex((p) => p.x === X + 4.5 && p.y > 30);
    expect(dropIndex).toBeGreaterThanOrEqual(0);
    expect(heightOf(view, dropIndex)).toBeGreaterThanOrEqual(2.5 + 39);
    const other = instancePositions(view).findIndex((p) => p.x === X + 9.5);
    expect(heightOf(view, other)).toBeLessThanOrEqual(1.51);

    let landed = false;
    let hop = 0;
    for (let t = 0; t < 4000; t += 16) {
      view.update(16);
      const y = instancePositions(view).find((p) => p.x === X + 4.5 && p.y > 2)!.y;
      if (y <= 2.5 + 1e-6) landed = true;
      else if (landed) hop = Math.max(hop, y - 2.5);
    }
    expect(landed).toBe(true);
    expect(hop).toBeGreaterThan(0.01);
    expect(hop).toBeLessThan(0.2);
    expect(blockAt(view, X + 4, Y + 4, 2)).toBeGreaterThanOrEqual(0);
    view.dispose();
  });

  it('drops only the arriving top block, and ignores hints with nothing arriving', () => {
    const view = buildSandbox();
    view.setColumns([{ x: X, y: Y, colours: [0, 1] }]);
    view.expectDrop({ x: X, y: Y });
    // The top block (level 1) falls; the one beneath it just settles.
    const heights = instancePositions(view).map((p) => p.y).sort((a, b) => a - b);
    expect(heights[0]).toBeLessThanOrEqual(1.51);
    expect(heights[1]).toBeGreaterThan(30);

    // A hint that arrives before anything is there waits for nothing: the
    // block that later appears settles normally.
    const later = buildSandbox();
    later.expectDrop({ x: X, y: Y });
    later.setColumns([{ x: X, y: Y, colours: [0] }]);
    expect(heightOf(later, 0)).toBeLessThanOrEqual(1.51);

    later.expectDrop({ x: X - 1, y: Y });
    later.expectDrop({ x: X + 0.5, y: Y });
    later.setColumns([{ x: X, y: Y, colours: [0, 1] }]);
    expect(heightOf(later, 1)).toBeLessThanOrEqual(2.51);
    view.dispose();
    later.dispose();
  });

  it('fails closed on invalid input', () => {
    const view = buildSandbox();
    view.setColumns([
      { x: X - 1, y: Y, colours: [0] },
      { x: X + SANDBOX_AREA.width, y: Y, colours: [0] },
      { x: X + 1.5, y: Y, colours: [0] },
      { x: X + 2, y: Y + SANDBOX_AREA.height, colours: [0] },
      { x: X + 3, y: Y, colours: [0, SANDBOX_COLOURS, 1] },
      { x: X + 4, y: Y, colours: [-1] },
      { x: X + 5, y: Y, colours: 'red' as never },
      null as never,
      { x: X + 6, y: Y, colours: [2] },
      { x: X + 6, y: Y, colours: [3, 3] },
      { x: X + 7, y: Y, colours: [1.5] },
    ]);
    settle(view);
    expect(blocks(view).count).toBe(2);
    expect(blockAt(view, X + 3, Y, 0)).toBeGreaterThanOrEqual(0);
    expect(colourAt(view, blockAt(view, X + 6, Y, 0))).toBe(new Color(SANDBOX_BLOCK_PALETTE[2]!).getHex());
    view.setColumns('nope' as never);
    settle(view, 500);
    expect(blocks(view).count).toBe(0);
    view.dispose();
  });

  it('caps the sandbox at SANDBOX_MAX_BLOCKS, cutting in a stable (y, x) order', () => {
    const view = buildSandbox();
    const tall = Array.from({ length: SANDBOX_MAX_HEIGHT + 20 }, (_, i) => i % SANDBOX_COLOURS);
    view.setColumns([
      { x: X + 3, y: Y + 2, colours: tall },
      { x: X + 1, y: Y + 2, colours: tall },
      { x: X + 9, y: Y + 1, colours: tall },
      { x: X, y: Y + 5, colours: tall },
    ]);
    settle(view);
    const mesh = blocks(view);
    expect(mesh.count).toBe(SANDBOX_MAX_BLOCKS);
    expect(SANDBOX_INSTANCE_CAPACITY).toBeGreaterThan(SANDBOX_MAX_BLOCKS);
    // (y, x) order: (X+9, Y+1), (X+1, Y+2), (X+3, Y+2) whole; (X, Y+5) gets the rest.
    expect(blockAt(view, X + 3, Y + 2, SANDBOX_MAX_HEIGHT - 1)).toBeGreaterThanOrEqual(0);
    expect(blockAt(view, X + 3, Y + 2, SANDBOX_MAX_HEIGHT)).toBe(-1);
    expect(blockAt(view, X, Y + 5, SANDBOX_MAX_BLOCKS - 3 * SANDBOX_MAX_HEIGHT - 1)).toBeGreaterThanOrEqual(0);
    expect(blockAt(view, X, Y + 5, SANDBOX_MAX_BLOCKS - 3 * SANDBOX_MAX_HEIGHT)).toBe(-1);
    // Replacing everything at the cap still fits: pop-outs give way to live blocks.
    view.setColumns([
      { x: X + 20, y: Y + 20, colours: tall },
      { x: X + 21, y: Y + 20, colours: tall },
      { x: X + 22, y: Y + 20, colours: tall },
      { x: X + 23, y: Y + 20, colours: tall },
    ]);
    expect(mesh.count).toBeLessThanOrEqual(SANDBOX_INSTANCE_CAPACITY);
    settle(view);
    expect(mesh.count).toBe(SANDBOX_MAX_BLOCKS);
    view.dispose();
  });

  it('draws a full-height tower and never frustum-culls it', () => {
    const view = buildSandbox();
    view.setColumns([{ x: X + 10, y: Y + 10, colours: Array.from({ length: SANDBOX_MAX_HEIGHT }, () => 5) }]);
    settle(view);
    expect(blocks(view).count).toBe(SANDBOX_MAX_HEIGHT);
    expect(blockAt(view, X + 10, Y + 10, SANDBOX_MAX_HEIGHT - 1)).toBeGreaterThanOrEqual(0);
    expect(blocks(view).frustumCulled).toBe(false);
    view.dispose();
  });

  it('highlights the target: white-gold when valid, red when not, over the block to pick or the cell to fill', () => {
    const view = buildSandbox();
    const target = view.group.getObjectByName('sandbox:target')!;
    const marker = view.group.getObjectByName('sandbox:target-marker')!;
    const ghost = view.group.getObjectByName('sandbox:target-ghost') as Mesh;
    const outline = view.group.getObjectByName('sandbox:target-outline') as Mesh;
    expect(target.visible).toBe(false);

    view.setTarget({ x: X + 2, y: Y + 3, level: 3, mode: 'pick', valid: true });
    expect(target.visible).toBe(true);
    expect(target.position.toArray()).toEqual([X + 2.5, 0, Y + 3.5]);
    expect(marker.visible).toBe(true);
    expect(marker.position.y).toBe(2.5);
    expect((ghost.material as MeshBasicMaterial).color.getHex()).toBe(new Color(SANDBOX_THEME.targetValid).getHex());
    expect((outline.material as LineBasicMaterial).color.getHex()).toBe(new Color(SANDBOX_THEME.targetValid).getHex());
    expect(target.userData).toMatchObject({ mode: 'pick', valid: true, level: 3 });

    view.setTarget({ x: X + 2, y: Y + 3, level: 3, mode: 'place', valid: false });
    expect(marker.position.y).toBe(3.5);
    expect((ghost.material as MeshBasicMaterial).color.getHex()).toBe(new Color(SANDBOX_THEME.targetInvalid).getHex());

    const opacity = (ghost.material as MeshBasicMaterial).opacity;
    view.update(120);
    expect((ghost.material as MeshBasicMaterial).opacity).not.toBe(opacity);

    view.setTarget({ x: X, y: Y, level: 0, mode: 'pick', valid: false });
    expect(target.visible).toBe(true);
    expect(marker.visible).toBe(false);

    for (const bad of [
      null,
      { x: X - 1, y: Y, level: 1, mode: 'place', valid: true },
      { x: X, y: Y, level: Number.NaN, mode: 'place', valid: true },
      { x: X, y: Y, level: 1, mode: 'dig', valid: true },
    ]) {
      view.setTarget({ x: X, y: Y, level: 1, mode: 'place', valid: true });
      view.setTarget(bad as never);
      expect(target.visible).toBe(false);
    }
    view.dispose();
  });

  it('animates deterministically and never writes NaN, whatever the deltas', () => {
    const run = (): number[] => {
      const view = buildSandbox();
      view.setColumns([{ x: X, y: Y, colours: [0, 1, 2] }]);
      view.setColumns([
        { x: X, y: Y, colours: [0, 1, 2] },
        { x: X + 1, y: Y, colours: [4] },
      ]);
      view.expectDrop({ x: X + 1, y: Y });
      view.setTarget({ x: X, y: Y, level: 3, mode: 'place', valid: true });
      for (const delta of [16, Number.NaN, -5, 33, Number.POSITIVE_INFINITY, 1e9, 7, 250, 16]) view.update(delta);
      view.setColumns([{ x: X + 1, y: Y, colours: [4] }]);
      for (const delta of [16, 16, 90]) view.update(delta);
      const mesh = blocks(view);
      const values = Array.from(mesh.instanceMatrix.array.slice(0, mesh.count * 16));
      view.dispose();
      return values;
    };
    const first = run();
    expect(first.every(Number.isFinite)).toBe(true);
    expect(run()).toEqual(first);
  });

  it('disposes its resources once and ignores calls afterwards', () => {
    const view = buildSandbox();
    view.setColumns([{ x: X, y: Y, colours: [0] }]);
    const geometries = new Set<BufferGeometry>();
    const materials = new Set<Material>();
    view.group.traverse((object) => {
      if (object instanceof Mesh) {
        geometries.add(object.geometry);
        materials.add(object.material as Material);
      }
    });
    const lines = view.group.getObjectByName('sandbox:target-outline') as unknown as { geometry: BufferGeometry; material: Material };
    geometries.add(lines.geometry);
    materials.add(lines.material);
    const spies = [...geometries, ...materials].map((value) => vi.spyOn(value, 'dispose'));
    const meshDispose = vi.spyOn(blocks(view), 'dispose');
    const parent = new Object3D();
    parent.add(view.group);
    view.dispose();
    view.dispose();
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
    expect(meshDispose).toHaveBeenCalledTimes(1);
    expect(parent.children).toHaveLength(0);
    view.setColumns([{ x: X, y: Y, colours: [1] }]);
    view.expectDrop({ x: X, y: Y });
    view.setTarget({ x: X, y: Y, level: 0, mode: 'place', valid: true });
    view.update(16);
  });
});

describe('createCarriedBlock', () => {
  it('shows a palette colour, and hides for null or a bad colour', () => {
    const carried = createCarriedBlock(null);
    const mesh = carried.object as Mesh;
    expect(mesh.visible).toBe(false);
    carried.setColour(2);
    expect(mesh.visible).toBe(true);
    expect((mesh.material as MeshStandardMaterial).color.getHex()).toBe(new Color(SANDBOX_BLOCK_PALETTE[2]!).getHex());
    carried.setColour(SANDBOX_COLOURS);
    expect(mesh.visible).toBe(false);
    carried.setColour(-1);
    expect(mesh.visible).toBe(false);
    const box = new Box3().setFromBufferAttribute(mesh.geometry.getAttribute('position') as never);
    expect(box.max.x - box.min.x).toBeCloseTo(CARRIED_BLOCK_SIZE);
    expect(mesh.castShadow).toBe(true);
    carried.dispose();
  });

  it('shares geometry and per-colour materials across avatars, released only at engine teardown', () => {
    disposeSandboxCaches();
    const first = createCarriedBlock(4);
    const second = createCarriedBlock(4);
    const third = createCarriedBlock(1);
    const a = first.object as Mesh;
    const b = second.object as Mesh;
    const c = third.object as Mesh;
    expect(a.geometry).toBe(b.geometry);
    expect(a.material).toBe(b.material);
    expect(c.material).not.toBe(a.material);

    const geometryDispose = vi.spyOn(a.geometry, 'dispose');
    const materialDispose = vi.spyOn(a.material as Material, 'dispose');
    const parent = new Object3D();
    parent.add(a);
    first.dispose();
    first.dispose();
    first.setColour(2);
    expect(parent.children).toHaveLength(0);
    expect(geometryDispose).not.toHaveBeenCalled();
    expect(materialDispose).not.toHaveBeenCalled();

    second.dispose();
    third.dispose();
    disposeSandboxCaches();
    disposeSandboxCaches();
    expect(geometryDispose).toHaveBeenCalledTimes(1);
    expect(materialDispose).toHaveBeenCalledTimes(1);
    const fresh = createCarriedBlock(4);
    expect((fresh.object as Mesh).geometry).not.toBe(a.geometry);
    fresh.dispose();
    disposeSandboxCaches();
  });
});
