import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  Group,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Raycaster,
  SRGBColorSpace,
  Texture,
  Vector3,
  type MeshBasicMaterial,
} from 'three';
import { describe, expect, it, vi } from 'vitest';
import { EXCHANGE_DEGEN_LEVEL, createFixedRoomLevel, isFixedRoomSolidAt } from '../fixed-room.js';
import { ROOM_ORIGIN } from '../world-layout.js';
import { AVATAR_FIGURE_HEIGHT } from './avatar-figure.js';
import { CAMERA_FOV, createCameraRig } from './camera-rig.js';
import {
  DEGEN_CAT_CUTOUT,
  DEGEN_CAT_CUTOUT_SIZE,
  DEGEN_CAT_HEIGHT,
  DEGEN_CAT_OUTLINE,
  DEGEN_CAT_STANDEE,
  degenCatStandee,
} from './degen-cat.js';
import { createNullLabelFactory } from './labels.js';
import { GeometryBin, ResourceBag, flushBin } from './palette.js';
import { INTERIOR_WALL_HEIGHT, buildFixedRoom } from './room-builder.js';
import type { ImageTextureLoader } from './types.js';

/**
 * The Degen floor's cardboard cutout of the lead's crying-cat photo. These
 * tests pin what ships, where the standee stands and how its face loads.
 */

const CREDITS = fileURLToPath(new URL('../../assets/CREDITS.md', import.meta.url));
const SOURCE = fileURLToPath(new URL('../../tools/degen-cat/crying-cat.jpg', import.meta.url));
const TOOL = fileURLToPath(new URL('../../tools/degen-cat/make-cutout.py', import.meta.url));
const MAX_CUTOUT_BYTES = 150 * 1024;
const OX = ROOM_ORIGIN.x / 32;
const OZ = ROOM_ORIGIN.y / 32;
const map = createFixedRoomLevel(EXCHANGE_DEGEN_LEVEL);
const station = map.stations[0]!;

function deferredImages() {
  const requests: { url: string; resolve(texture: Texture): void; reject(error: unknown): void }[] = [];
  const loader: ImageTextureLoader = {
    load: (url) => new Promise<Texture>((resolve, reject) => requests.push({ url, resolve, reject })),
  };
  return { loader, requests };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** The standee alone: its cardboard as one mesh (in room space), and its face if a loader was given. */
function standeeAlone(images: ImageTextureLoader | null = null) {
  const bin = new GeometryBin();
  const group = new Group();
  group.name = 'room';
  const res = new ResourceBag();
  degenCatStandee(bin, group, res, images);
  const cardboard = flushBin(bin, 'body', res.material(new MeshStandardMaterial()), res, group, { name: 'cardboard' })!;
  bin.dispose();
  const face = () => group.children.find((child) => child.userData['cutout'] !== undefined) as Mesh<PlaneGeometry, MeshBasicMaterial> | undefined;
  return { group, res, cardboard, face };
}

function verticesOf(mesh: Mesh): Vector3[] {
  mesh.updateMatrixWorld(true);
  const position = mesh.geometry.getAttribute('position');
  const out: Vector3[] = [];
  for (let i = 0; i < position.count; i++) out.push(new Vector3().fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld));
  return out;
}

/** A WebP's canvas size and whether its image data is lossless, or null if it is not one. */
function webpInfo(bytes: Buffer): { width: number; height: number; lossless: boolean } | null {
  if (bytes.length < 30 || bytes.toString('latin1', 0, 4) !== 'RIFF' || bytes.toString('latin1', 8, 12) !== 'WEBP') return null;
  const lossless = bytes.includes(Buffer.from('VP8L', 'latin1')) && !bytes.includes(Buffer.from('VP8 ', 'latin1'));
  switch (bytes.toString('latin1', 12, 16)) {
    case 'VP8L': {
      const bits = bytes.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1, lossless };
    }
    case 'VP8X':
      return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1, lossless };
    default:
      return null;
  }
}

describe('the crying-cat cutout', () => {
  it('ships as one bundled lossless WebP within budget, re-made from the committed photo', () => {
    const url = new URL(DEGEN_CAT_CUTOUT);
    // In node the bundler's URL is the file itself; in the browser it is the game's own origin.
    expect(url.protocol).toBe('file:');
    const bytes = readFileSync(fileURLToPath(url));
    expect(bytes.length).toBeLessThanOrEqual(MAX_CUTOUT_BYTES);
    expect(bytes.readUInt32LE(4) + 8).toBe(bytes.length);
    // Lossless: what ships is the photo's own pixels, not a re-encoding of them.
    expect(webpInfo(bytes)).toEqual({ ...DEGEN_CAT_CUTOUT_SIZE, lossless: true });
    // The tool checks the photo it reads is the one the lead supplied.
    const digest = createHash('sha256').update(readFileSync(SOURCE)).digest('hex');
    expect(readFileSync(TOOL, 'utf8')).toContain(`SOURCE_SHA256 = "${digest}"`);
  });

  it('is credited as the lead-supplied crying cat photo', () => {
    const credits = readFileSync(CREDITS, 'utf8');
    expect(credits).toContain('degen-cat/cutout.webp');
    expect(credits).toMatch(/crying cat/i);
    expect(credits).toMatch(/lead/i);
  });

  it('has a die-cut silhouette inside the texture: ears up top, the cut across the chest below', () => {
    expect(DEGEN_CAT_OUTLINE.length).toBeGreaterThanOrEqual(24);
    for (const [u, v] of DEGEN_CAT_OUTLINE) {
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThanOrEqual(1);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    // Two ear tips near the top corners, both higher than the head between them.
    const top = (from: number, to: number) => Math.max(...DEGEN_CAT_OUTLINE.filter(([u]) => u >= from && u <= to).map(([, v]) => v));
    expect(top(0, 0.15)).toBeGreaterThan(0.95);
    expect(top(0.85, 1)).toBeGreaterThan(0.95);
    expect(top(0.4, 0.6)).toBeLessThan(0.92);
  });
});

describe('the cat standee', () => {
  it('stands on the back room\'s fixtures behind the counter, a head taller than an avatar', () => {
    const { cardboard, res } = standeeAlone();
    const points = verticesOf(cardboard);
    expect(points.length).toBeGreaterThan(0);
    for (const p of points) {
      const [tx, ty] = [Math.floor(p.x), Math.floor(p.z)];
      // On a fixture tile of the booth, never on a wall or the walkable floor.
      expect(map.tiles[ty]?.[tx], `${p.x.toFixed(2)}, ${p.z.toFixed(2)}`).toBe('fixture');
      expect(isFixedRoomSolidAt(map, tx, ty)).toBe(true);
      // Inside the booth's partitions, and behind the counter's bar.
      expect(p.x).toBeGreaterThan(station.x - 1 + 0.18);
      expect(p.x).toBeLessThan(station.x + station.width + 1 - 0.18);
      expect(p.z).toBeLessThan(station.y + 0.12);
      expect(p.y).toBeGreaterThanOrEqual(0);
    }
    const height = Math.max(...points.map((p) => p.y));
    expect(height).toBeGreaterThan(AVATAR_FIGURE_HEIGHT);
    expect(height).toBeLessThan(INTERIOR_WALL_HEIGHT);
    // Its easel reaches the floor behind it.
    const feet = points.filter((p) => p.y < 0.02);
    expect(Math.min(...feet.map((p) => p.z))).toBeLessThan(DEGEN_CAT_STANDEE.z - 0.3);
    res.dispose();
  });

  it('turns its face to the counter\'s approach, in full view from there over the counter', async () => {
    const images = deferredImages();
    const room = buildFixedRoom(map, createNullLabelFactory(), ROOM_ORIGIN, images.loader);
    images.requests.forEach((request) => request.resolve(new Texture()));
    await settle();
    room.group.updateMatrixWorld(true);
    let face: Mesh | undefined;
    room.group.traverse((object) => {
      if (object.userData['cutout'] !== undefined) face = object as Mesh;
    });
    expect(face).toBeDefined();
    const approach = new Vector3(OX + station.x + station.width / 2, 0, OZ + station.y + station.height + 0.5);
    const centre = face!.getWorldPosition(new Vector3());
    const normal = new Vector3(0, 0, 1).transformDirection(face!.matrixWorld);
    const toApproach = approach.clone().sub(centre).setY(0).normalize();
    expect(normal.clone().setY(0).normalize().dot(toApproach)).toBeGreaterThan(0.9);
    // The game's camera on a player at the approach sees the face's eyes and
    // its corners: nothing in the room stands in front of them.
    const camera = new PerspectiveCamera(CAMERA_FOV, 16 / 9, 0.1, 240);
    createCameraRig({ camera }).update(16, { x: approach.x, z: approach.z }, { minX: OX, maxX: OX + map.width, minZ: OZ, maxZ: OZ + map.height }, 0, 'street');
    camera.updateMatrixWorld(true);
    const eye = camera.getWorldPosition(new Vector3());
    const blockers: Mesh[] = [];
    room.group.traverse((object) => {
      if (object instanceof Mesh && object !== face && object.visible) blockers.push(object);
    });
    const w = DEGEN_CAT_STANDEE.width;
    const h = DEGEN_CAT_HEIGHT;
    // Between the eyes, then the card's four quarters.
    const points = [[-0.08 * w, 0.12 * h], [-0.3 * w, 0.3 * h], [0.3 * w, 0.3 * h], [-0.3 * w, -0.3 * h], [0.3 * w, -0.3 * h]] as const;
    for (const [u, v] of points) {
      const target = new Vector3(u, v, 0).applyMatrix4(face!.matrixWorld);
      const ray = new Raycaster(eye, target.clone().sub(eye).normalize(), 0, eye.distanceTo(target) - 0.01);
      expect(ray.intersectObjects(blockers, false).map((hit) => hit.object.name), `${u}, ${v}`).toEqual([]);
      // And it is in the frame.
      const ndc = target.clone().project(camera);
      expect(Math.abs(ndc.x)).toBeLessThan(1);
      expect(Math.abs(ndc.y)).toBeLessThan(1);
    }
    room.dispose();
  });

  it('loads its face through the loader: hidden until decoded, then an sRGB, mipmapped, alpha-tested card', async () => {
    const images = deferredImages();
    const { face, res } = standeeAlone(images.loader);
    expect(images.requests.map((request) => request.url)).toEqual([DEGEN_CAT_CUTOUT]);
    const art = face()!;
    expect(art.visible).toBe(false);
    expect(art.material.alphaTest).toBe(0.5);
    expect(art.material.toneMapped).toBe(false);
    expect(art.geometry.parameters.width).toBe(DEGEN_CAT_STANDEE.width);
    expect(art.geometry.parameters.width / art.geometry.parameters.height).toBeCloseTo(DEGEN_CAT_CUTOUT_SIZE.width / DEGEN_CAT_CUTOUT_SIZE.height);
    const texture = new Texture();
    images.requests[0]!.resolve(texture);
    await settle();
    expect(art.visible).toBe(true);
    expect(art.material.map).toBe(texture);
    expect(texture.colorSpace).toBe(SRGBColorSpace);
    expect(texture.generateMipmaps).toBe(true);
    expect(texture.minFilter).toBe(LinearMipmapLinearFilter);
    expect(texture.magFilter).toBe(LinearFilter);
    // Its top stands at the standee's height, less the lean.
    art.updateMatrixWorld(true);
    const corner = new Vector3(0, DEGEN_CAT_HEIGHT / 2, 0).applyMatrix4(art.matrixWorld);
    expect(corner.y).toBeCloseTo(DEGEN_CAT_STANDEE.top * Math.cos(DEGEN_CAT_STANDEE.tilt), 2);
    const spy = vi.spyOn(texture, 'dispose');
    res.dispose();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('keeps its bare cardboard, at no draw call, when there is no loader or the face fails', async () => {
    expect(standeeAlone(null).face()).toBeUndefined();
    const images = deferredImages();
    const failing = standeeAlone(images.loader);
    images.requests[0]!.reject(new Error('decode failed'));
    await settle();
    expect(failing.face()).toBeUndefined();
    const throwing = standeeAlone({
      load() {
        throw new Error('no decoder');
      },
    });
    await settle();
    expect(throwing.face()).toBeUndefined();
  });

  it('frees a face that arrives after its room has gone', async () => {
    const images = deferredImages();
    const { res } = standeeAlone(images.loader);
    res.dispose();
    const texture = new Texture();
    const spy = vi.spyOn(texture, 'dispose');
    images.requests[0]!.resolve(texture);
    await settle();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
