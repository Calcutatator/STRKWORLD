import {
  ExtrudeGeometry,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  Shape,
  Vector2,
  Vector3,
  type BufferGeometry,
  type Group,
  type Texture,
} from 'three';
import { DEGEN_CAT_CUTOUT_SIZE, DEGEN_CAT_OUTLINE } from './degen-cat-outline.js';
import { beamGeometry, boxGeometry, type GeometryBin, type ResourceBag, type Vec3 } from './palette.js';
import type { ImageTextureLoader } from './types.js';

export { DEGEN_CAT_CUTOUT_SIZE, DEGEN_CAT_OUTLINE };

/**
 * The Degen floor's cardboard cutout: the lead-supplied "crying cat" photo,
 * die-cut round the cat's head and chest (`tools/degen-cat/make-cutout.py`
 * keeps the photo's own pixels), standing on a folding easel in the back
 * room behind the DEGEN SWAP counter. Bundled with the World, so the browser
 * fetches it from the game's own origin (assets/CREDITS.md).
 */
export const DEGEN_CAT_CUTOUT = new URL('../../assets/degen-cat/cutout.webp', import.meta.url).href;

/**
 * Where the standee stands, in room tiles: in the booth's east half, between
 * the back bar and the counter, turned a little towards the counter's
 * approach and leaning back on its easel. Its head clears the counter's
 * lintel from the approach, and the DEGEN MODE sign's lettering stays in
 * view to its west. Every part of it is on the booth's fixture tiles.
 */
export const DEGEN_CAT_STANDEE = Object.freeze({
  /** The foot of the card, at the middle of its width. */
  x: 10.32,
  z: 1.6,
  /** Turned towards the approach (negative: its face looks south-west). */
  yaw: -0.32,
  /** How far it leans back on the easel, in radians. */
  tilt: 0.1,
  /** The card's width; its height follows the cutout's aspect. */
  width: 0.96,
  /** The top of the card above the floor, before the lean: a head over an avatar's. */
  top: 2.06,
  /** The card's thickness: the cardboard edge. */
  thickness: 0.016,
});

/** Kraft board: the card's back and edge, the stick and the easel. */
export const DEGEN_CAT_CARDBOARD = Object.freeze({ card: 0xb48a58, stick: 0x9c7446, easel: 0xa67c4c });

/** The card's height in world units, from the cutout's aspect. */
export const DEGEN_CAT_HEIGHT = (DEGEN_CAT_STANDEE.width * DEGEN_CAT_CUTOUT_SIZE.height) / DEGEN_CAT_CUTOUT_SIZE.width;

/** Standee space (x across the card, y up, z out of its face, origin at its foot) to room space. */
function standeeMatrix(): Matrix4 {
  const s = DEGEN_CAT_STANDEE;
  return new Matrix4()
    .makeTranslation(s.x, 0, s.z)
    .multiply(new Matrix4().makeRotationY(s.yaw))
    .multiply(new Matrix4().makeRotationX(-s.tilt));
}

/**
 * Builds the standee. The cardboard (the die-cut card with its edge, the stick
 * behind it and the easel strut) rides the room's shared counters bin at no
 * draw call; the printed face is one alpha-tested plane that `images` decodes,
 * hidden until it arrives. Without a loader, or if the load fails, the plain
 * cardboard stands there instead and no draw call is spent.
 */
export function degenCatStandee(bin: GeometryBin, parent: Group, res: ResourceBag, images: ImageTextureLoader | null): void {
  const s = DEGEN_CAT_STANDEE;
  const w = s.width;
  const h = DEGEN_CAT_HEIGHT;
  const bottom = s.top - h;
  const d = s.thickness;
  const toRoom = standeeMatrix();
  const place = (geometry: BufferGeometry): BufferGeometry => geometry.applyMatrix4(toRoom);

  // The die-cut card, its front face at z = 0 and its edge running back from it.
  const shape = new Shape(DEGEN_CAT_OUTLINE.map(([u, v]) => new Vector2((u - 0.5) * w, bottom + v * h)));
  const card = new ExtrudeGeometry(shape, { depth: d, bevelEnabled: false, curveSegments: 1 });
  card.translate(0, 0, -d);
  bin.add('body', place(card), DEGEN_CAT_CARDBOARD.card);
  // The stick down the back of the card to the floor (its foot lifted by the lean).
  bin.add('body', place(boxGeometry(-0.05, 0.01, -d - 0.012, 0.05, bottom + 0.4, -d)), DEGEN_CAT_CARDBOARD.stick);
  // The easel: a strut hinged on the stick, folded out to the floor behind.
  const hinge = new Vector3(0, bottom + 0.1, -d - 0.012).applyMatrix4(toRoom);
  const back = new Vector3(0, 0, -1).transformDirection(new Matrix4().makeRotationY(s.yaw));
  const foot: Vec3 = [hinge.x + back.x * 0.4, 0.005, hinge.z + back.z * 0.4];
  bin.add('body', beamGeometry([hinge.x, hinge.y, hinge.z], foot, 0.16, 0.01), DEGEN_CAT_CARDBOARD.easel);
  // Its hinge tape across the stick.
  bin.add('body', place(boxGeometry(-0.09, bottom + 0.06, -d - 0.016, 0.09, bottom + 0.14, -d - 0.012)), DEGEN_CAT_CARDBOARD.stick);

  if (!images) return;
  const material = res.material(new MeshBasicMaterial({ toneMapped: false, alphaTest: 0.5 }));
  const art = new Mesh(res.geometry(new PlaneGeometry(w, h)), material);
  art.name = `${parent.name}:degen-cat`;
  art.userData['cutout'] = 'crying-cat';
  art.position.set(0, bottom + h / 2, 0.002);
  art.updateMatrix();
  art.applyMatrix4(toRoom);
  // Hidden until decoded: a map with no image yet samples black.
  art.visible = false;
  parent.add(art);

  const show = (texture: Texture): void => {
    // The room may be gone by the time the image arrives; nothing may leak.
    if (res.disposed) {
      texture.dispose();
      return;
    }
    res.texture(texture);
    texture.colorSpace = SRGBColorSpace;
    texture.generateMipmaps = true;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.magFilter = LinearFilter;
    texture.anisotropy = 4;
    texture.needsUpdate = true;
    material.map = texture;
    material.needsUpdate = true;
    art.visible = true;
  };
  const plain = (): void => {
    // The bare cardboard stays: no art, and no draw call.
    if (!res.disposed) art.removeFromParent();
  };
  let pending: Promise<Texture>;
  try {
    pending = images.load(DEGEN_CAT_CUTOUT);
  } catch (error) {
    pending = Promise.reject(error);
  }
  pending.then(show, plain).catch(() => {
    // Nothing can fail after this point, but a stray rejection must never surface.
  });
}
