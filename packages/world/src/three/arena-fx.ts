import {
  BoxGeometry,
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
} from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { ARENA_DUMMY_TILE, ARENA_DUMMY_YAW, ARENA_ORIGIN_PX, type GameId } from '@strkworld/shared';
import type { ArenaViewFrame } from '../arena-channel.js';
import { CAMERA_PITCH } from './camera-rig.js';
import { tileCenterToGround } from './coords.js';

/**
 * D-114: the arena's combat feedback (stream C): the training dummy itself,
 * its flash, wobble and topple, the damage numbers and the HP bar.
 *
 * Everything here is driven by the ring frame, which is the server's state:
 * a damage number is the dummy's HP delta between two frames (split across
 * the hits counter's delta when one patch carries several), the bar is the
 * server's HP, and the topple is the server's knockout. Nothing is guessed
 * from local input, so a swing that misses on the server shows no number.
 *
 * Reduced motion (§5.5 of the design): a hit is a 120 ms colour flash with no
 * wobble or straw; a number appears in place and fades over 500 ms; the bar
 * snaps; the knockout snaps the dummy flat and dims it. No camera shake or
 * hit-stop in either mode.
 *
 * The dummy belongs here, not to the room, so its flash and topple need no
 * handle into the room's meshes. The group is in World units with the room
 * origin applied, like every fixed room's geometry; the presenter mounts it
 * in the arena room.
 */

/** The arena room's dummy group (stream A's `arena-room.ts`): its origin is the post's foot. */
export const ARENA_ROOM_DUMMY_NAME = 'arena:dummy';
const ROOM_DUMMY_NAME = ARENA_ROOM_DUMMY_NAME;

/** How the fx asks the remote avatar layer (C's `remote-avatars.ts`) to play a peer's swing. */
export interface RemoteSwingPort {
  playSwing(gameId: GameId): void;
  /** C (optional): the peer in the ring holds the battle stance; null for nobody. */
  setFighter?(gameId: GameId | null): void;
}

export interface ArenaFxDeps {
  /** Reduced motion: no wobble, rise, topple or burst (§5.5 of the design). */
  reducedMotion(): boolean;
  /**
   * C (optional): the room's own training dummy, a group whose origin is the
   * post's foot, in the same frame as the fx group's parent (the room's
   * `fxMount` beside it). The fx then flashes, wobbles and topples it (on
   * cloned materials, so nothing else in the room flashes) and builds no
   * dummy of its own. Absent, the fx adopts the room's `arena:dummy`
   * (`ARENA_ROOM_DUMMY_NAME`) once it is mounted beside it, and until then
   * draws its own at the dummy tile in World units with the room origin
   * applied.
   */
  readonly dummy?: Object3D | null;
}

export interface ArenaFx {
  /** Apply the latest ring frame; `remote` plays peers' swings, null while there is no remote layer. */
  sync(frame: ArenaViewFrame | null, remote: RemoteSwingPort | null): void;
  update(dt: number): void;
  /** Mounted by the presenter in the arena room. */
  readonly group: Group;
  dispose(): void;
}

// -- timings and sizes (§5.5) ------------------------------------------------------
export const ARENA_FX_FLASH_MS = 80;
export const ARENA_FX_REDUCED_FLASH_MS = 120;
export const ARENA_FX_NUMBER_MS = 700;
export const ARENA_FX_REDUCED_NUMBER_MS = 500;
export const ARENA_FX_NUMBER_RISE = 0.8;
export const ARENA_FX_TOPPLE_MS = 500;
/** Damage numbers are pooled: at most this many show at once. */
export const ARENA_FX_NUMBER_POOL = 4;
const FLECK_COUNT = 14;
const FLECK_MS = 600;
/** The bar eases to the server's HP with this time constant. */
const BAR_EASE_MS = 90;
/** Spring wobble about the post's base: stiffness and damping per second, and the kick per HP lost. */
const WOBBLE_STIFFNESS = 160;
const WOBBLE_DAMPING = 9;
const WOBBLE_KICK_PER_HP = 0.24;
const MAX_STEP_MS = 100;

const BAR_WIDTH = 1.1;
const BAR_HEIGHT = 0.13;
const BAR_Y = 2.3;
const NUMBER_Y = 1.45;
/** Numbers rise beside the bar's right end, clear of the bar and the dummy's head. */
const NUMBER_X = 0.55;
const VOXEL = 0.075;

const COLOURS = Object.freeze({
  post: 0x7a5232,
  postDark: 0x5c3c22,
  sack: 0xc9a46a,
  sackDark: 0xa8834e,
  straw: 0xf0cf6a,
  target: 0xc8321e,
  targetLight: 0xf6ecd9,
  rope: 0x8a6a40,
  barBack: 0x24120a,
  barFill: 0xf56a16,
  barFillLow: 0xffc12e,
  number: 0xffc12e,
  numberEdge: 0x24120a,
  flash: 0xffffff,
});

type Box = readonly [size: readonly [number, number, number], at: readonly [number, number, number], colour: number];

/** The straw training dummy: a post on a cross foot, a sack body with a painted target, a crossbar for arms. */
const DUMMY_BOXES: readonly Box[] = Object.freeze([
  [[0.7, 0.08, 0.12], [0, 0.04, 0], COLOURS.postDark],
  [[0.12, 0.08, 0.7], [0, 0.04, 0], COLOURS.postDark],
  [[0.12, 1.3, 0.12], [0, 0.65, 0], COLOURS.post],
  [[0.52, 0.62, 0.36], [0, 0.98, 0], COLOURS.sack],
  [[0.54, 0.06, 0.38], [0, 0.72, 0], COLOURS.rope],
  [[0.54, 0.06, 0.38], [0, 1.24, 0], COLOURS.rope],
  [[1.0, 0.09, 0.09], [0, 1.17, 0], COLOURS.post],
  [[0.12, 0.14, 0.14], [0.53, 1.17, 0], COLOURS.straw],
  [[0.12, 0.14, 0.14], [-0.53, 1.17, 0], COLOURS.straw],
  [[0.34, 0.32, 0.32], [0, 1.46, 0], COLOURS.sackDark],
  [[0.36, 0.06, 0.34], [0, 1.6, 0], COLOURS.straw],
  // The target, painted on the front (+Z, towards the gate).
  [[0.36, 0.36, 0.012], [0, 0.98, 0.186], COLOURS.target],
  [[0.24, 0.24, 0.012], [0, 0.98, 0.194], COLOURS.targetLight],
  [[0.12, 0.12, 0.012], [0, 0.98, 0.202], COLOURS.target],
  // Straw poking out under the sack.
  [[0.4, 0.08, 0.26], [0, 0.64, 0], COLOURS.straw],
]);

/** A 3 x 5 pixel font for the damage numbers, top row first. */
const GLYPHS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  '-': ['000', '000', '111', '000', '000'],
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
});

function colouredBox(size: readonly [number, number, number], at: readonly [number, number, number], colour: number): BufferGeometry {
  const box = new BoxGeometry(size[0], size[1], size[2]).toNonIndexed();
  box.translate(at[0], at[1], at[2]);
  const c = new Color(colour);
  const count = box.getAttribute('position').count;
  const colours = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) colours.set([c.r, c.g, c.b], i * 3);
  box.setAttribute('color', new Float32BufferAttribute(colours, 3));
  box.deleteAttribute('uv');
  return box;
}

function mergeBoxes(boxes: readonly Box[]): BufferGeometry {
  const parts = boxes.map(([size, at, colour]) => colouredBox(size, at, colour));
  const merged = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  if (!merged) throw new Error('arena-fx: could not merge geometry');
  return merged;
}

/** The voxel text for a damage number, centred on its origin: gold faces over a dark drop. */
export function damageNumberGeometry(text: string): BufferGeometry {
  const glyphs = [...text].map((ch) => GLYPHS[ch]).filter((g): g is readonly string[] => g !== undefined);
  const boxes: Box[] = [];
  const columns = glyphs.length * 4 - 1;
  glyphs.forEach((rows, index) => {
    rows.forEach((row, r) => {
      [...row].forEach((bit, c) => {
        if (bit !== '1') return;
        const x = (index * 4 + c - (columns - 1) / 2) * VOXEL;
        const y = (2 - r) * VOXEL;
        boxes.push([[VOXEL, VOXEL, VOXEL * 0.6], [x, y, 0.03], COLOURS.number]);
        // The brand's hard drop: the same cube behind, down and to the right.
        boxes.push([[VOXEL, VOXEL, VOXEL * 0.6], [x + VOXEL * 0.3, y - VOXEL * 0.3, -0.02], COLOURS.numberEdge]);
      });
    });
  });
  if (boxes.length === 0) return new BufferGeometry();
  return mergeBoxes(boxes);
}

/** Split an HP drop across the hits that made it: two hits of 10 in one patch are two numbers of 10. */
export function splitDamage(hpDrop: number, hitsDelta: number): number[] {
  if (!Number.isFinite(hpDrop) || hpDrop <= 0) return [];
  const count = Math.max(1, Math.min(ARENA_FX_NUMBER_POOL, Number.isFinite(hitsDelta) ? Math.floor(hitsDelta) : 1));
  const each = Math.floor(hpDrop / count);
  const parts = new Array<number>(count).fill(each);
  parts[count - 1] = hpDrop - each * (count - 1);
  return parts.filter((part) => part > 0);
}

interface DamageNumber {
  readonly mesh: Mesh<BufferGeometry, MeshBasicMaterial>;
  age: number;
  life: number;
  rise: number;
  baseX: number;
}

interface Fleck {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  age: number;
}

export function createArenaFx(deps: ArenaFxDeps): ArenaFx {
  const group = new Group();
  group.name = 'arena-fx';
  const ground = tileCenterToGround(ARENA_DUMMY_TILE.x, ARENA_DUMMY_TILE.y, { x: ARENA_ORIGIN_PX, y: ARENA_ORIGIN_PX });

  // The dummy: the room's own when it has one, else ours at the tile. Either
  // way `pivot` turns about the post's foot for the wobble and the topple.
  let adopted: Object3D | null = null;
  let owned: { readonly root: Group; readonly geometry: BufferGeometry; readonly material: MeshStandardMaterial } | null = null;
  let pivot: Object3D;
  /** The materials that flash, with the colour each started as. */
  let flashing: Array<{ readonly material: MeshStandardMaterial; readonly base: Color }> = [];
  let anchor: { readonly x: number; readonly z: number } = ground;
  /** Puts the room's own materials back on its dummy at dispose. */
  const restores: Array<() => void> = [];

  {
    const root = new Group();
    root.name = 'arena-fx-dummy';
    root.position.set(ground.x, 0, ground.z);
    // Its front (+Z) to the camera (south), as the room's dummy; the pivot turns inside the yaw.
    root.rotation.y = ARENA_DUMMY_YAW;
    const ownPivot = new Group();
    ownPivot.name = 'arena-dummy-pivot';
    const geometry = mergeBoxes(DUMMY_BOXES);
    const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
    material.name = 'arena-fx:dummy';
    const mesh = new Mesh(geometry, material);
    mesh.name = 'arena-fx:dummy';
    mesh.castShadow = true;
    ownPivot.add(mesh);
    root.add(ownPivot);
    group.add(root);
    owned = { root, geometry, material };
    pivot = ownPivot;
    flashing = [{ material, base: material.color.clone() }];
  }

  /**
   * Take over the room's dummy: drop our own, flash cloned materials (so
   * nothing else in the room flashes) and put the bar and numbers over it.
   */
  const adoptDummy = (dummy: Object3D): void => {
    if (adopted !== null) return;
    adopted = dummy;
    if (owned !== null) {
      owned.root.removeFromParent();
      owned.geometry.dispose();
      owned.material.dispose();
      owned = null;
    }
    pivot = dummy;
    anchor = { x: dummy.position.x, z: dummy.position.z };
    flashing = [];
    dummy.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      const source = object.material;
      if (!(source instanceof MeshStandardMaterial)) return;
      const material = source.clone();
      object.material = material;
      restores.push(() => {
        object.material = source;
      });
      flashing.push({ material, base: material.color.clone() });
    });
  };

  /**
   * Without a `dummy` dep, the fx finds the room's dummy once it is mounted:
   * the arena room names its dummy group `arena:dummy` beside the fx mount.
   * Searched once per new parent, never inside the fx's own group.
   */
  let searchedParent: Object3D | null = null;
  const findRoomDummy = (): void => {
    if (adopted !== null) return;
    const mount = group.parent;
    if (mount === searchedParent) return;
    searchedParent = mount;
    const room = mount?.parent ?? mount;
    if (!room) return;
    let found: Object3D | null = null;
    room.traverse((object) => {
      if (found || object.name !== ROOM_DUMMY_NAME) return;
      let inside = false;
      for (let p: Object3D | null = object; p; p = p.parent) if (p === group) inside = true;
      if (!inside) found = object;
    });
    if (found) {
      adoptDummy(found);
      placeOverDummy();
      applyPivot();
      applyFlash();
    }
  };

  // The HP bar: dark back, ember fill anchored at its left edge, tilted to face the camera.
  const bar = new Group();
  bar.name = 'arena-hp-bar';
  bar.position.set(anchor.x, BAR_Y, anchor.z);
  bar.rotation.x = -CAMERA_PITCH;
  bar.visible = false;
  const barBackMaterial = new MeshBasicMaterial({ color: COLOURS.barBack, side: DoubleSide, toneMapped: false });
  const barBack = new Mesh(new PlaneGeometry(BAR_WIDTH + 0.08, BAR_HEIGHT + 0.08), barBackMaterial);
  barBack.name = 'arena:hp-bar';
  const fillGeometry = new PlaneGeometry(BAR_WIDTH, BAR_HEIGHT);
  fillGeometry.translate(BAR_WIDTH / 2, 0, 0);
  const barFillMaterial = new MeshBasicMaterial({ color: COLOURS.barFill, side: DoubleSide, toneMapped: false });
  const barFill = new Mesh(fillGeometry, barFillMaterial);
  barFill.name = 'arena:hp-fill';
  barFill.position.set(-BAR_WIDTH / 2, 0, 0.005);
  bar.add(barBack, barFill);
  group.add(bar);

  // Damage numbers: a small pool, each with its own material so each fades alone.
  const numberGeometries = new Map<string, BufferGeometry>();
  const numberGeometry = (text: string): BufferGeometry => {
    let geometry = numberGeometries.get(text);
    if (!geometry) {
      geometry = damageNumberGeometry(text);
      numberGeometries.set(text, geometry);
    }
    return geometry;
  };
  const numbers: DamageNumber[] = [];
  for (let i = 0; i < ARENA_FX_NUMBER_POOL; i += 1) {
    const material = new MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, toneMapped: false });
    const mesh = new Mesh(numberGeometry('-10'), material);
    mesh.name = 'arena:damage-number';
    mesh.visible = false;
    mesh.rotation.x = -CAMERA_PITCH;
    mesh.renderOrder = 10;
    group.add(mesh);
    numbers.push({ mesh, age: 0, life: 0, rise: 0, baseX: 0 });
  }

  /** The bar (and any numbers showing) over wherever the dummy stands. */
  const placeOverDummy = (): void => {
    bar.position.set(anchor.x, BAR_Y, anchor.z);
    for (const n of numbers) {
      if (!n.mesh.visible) continue;
      n.mesh.position.x = anchor.x + NUMBER_X;
      n.mesh.position.z = anchor.z + 0.3;
    }
  };
  if (deps.dummy) {
    adoptDummy(deps.dummy);
    placeOverDummy();
  }

  // Straw flecks: one instanced mesh, full motion only.
  const fleckGeometry = new BoxGeometry(0.05, 0.05, 0.05);
  const fleckMaterial = new MeshStandardMaterial({ color: COLOURS.straw, roughness: 1 });
  const flecksMesh = new InstancedMesh(fleckGeometry, fleckMaterial, FLECK_COUNT);
  flecksMesh.name = 'arena:straw';
  flecksMesh.visible = false;
  flecksMesh.frustumCulled = false;
  group.add(flecksMesh);
  const flecks: Fleck[] = [];
  const scratch = new Object3D();
  const hidden = new Matrix4().makeScale(0, 0, 0);
  for (let i = 0; i < FLECK_COUNT; i += 1) flecksMesh.setMatrixAt(i, hidden);

  let disposed = false;
  let previous: ArenaViewFrame | null = null;
  let fighter: GameId | null | undefined;
  let fighterPort: RemoteSwingPort | null = null;
  let flashLeft = 0;
  let flashTotal = 0;
  let flashColour = 'emissive' as 'emissive' | 'colour';
  let wobble = 0;
  let wobbleVelocity = 0;
  let toppled = 0;
  let toppling = false;
  let barShown = 1;
  let barTarget = 1;
  let numberCursor = 0;
  let seed = 1;

  const reduced = (): boolean => {
    try {
      return deps.reducedMotion() === true;
    } catch {
      return false;
    }
  };
  const random = (): number => {
    // Deterministic, so renders and tests repeat.
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };

  const applyFlash = (): void => {
    const t = flashTotal > 0 ? Math.max(0, flashLeft / flashTotal) : 0;
    const dim = toppled >= 1 && reduced() ? 0.55 : 1;
    for (const { material, base } of flashing) {
      material.color.copy(base);
      if (flashColour === 'emissive') {
        material.emissive.setHex(COLOURS.flash).multiplyScalar(0.85 * t);
      } else {
        material.emissive.setHex(0x000000);
        // A colour flash: tint towards red and back, no light added.
        material.color.multiply(new Color(1, 1 - 0.55 * t, 1 - 0.6 * t));
      }
      if (dim !== 1) material.color.multiplyScalar(dim);
    }
  };

  const applyPivot = (): void => {
    // The topple falls east, away from the ring's west gate where the fighter
    // comes in, flat across the screen; the wobble rocks the same way.
    pivot.rotation.z = -(Math.PI / 2) * easeOut(toppled) - wobble;
  };

  const applyBar = (): void => {
    const shown = Math.max(0, Math.min(1, barShown));
    barFill.scale.x = Math.max(0.0001, shown);
    barFill.visible = shown > 0;
    barFillMaterial.color.setHex(shown <= 0.3 ? COLOURS.barFillLow : COLOURS.barFill);
  };

  const standUp = (): void => {
    toppled = 0;
    toppling = false;
    wobble = 0;
    wobbleVelocity = 0;
    flashLeft = 0;
    applyFlash();
    applyPivot();
  };

  const spawnNumber = (value: number, offset: number, quiet: boolean): void => {
    const slot = numbers[numberCursor % numbers.length]!;
    numberCursor += 1;
    slot.mesh.geometry = numberGeometry(`-${value}`);
    slot.age = 0;
    slot.life = quiet ? ARENA_FX_REDUCED_NUMBER_MS : ARENA_FX_NUMBER_MS;
    slot.rise = quiet ? 0 : ARENA_FX_NUMBER_RISE;
    slot.baseX = anchor.x + NUMBER_X + offset;
    slot.mesh.position.set(slot.baseX, NUMBER_Y, anchor.z + 0.3);
    slot.mesh.material.opacity = 1;
    slot.mesh.visible = true;
  };

  const burst = (count: number, power: number): void => {
    for (let i = 0; i < count; i += 1) {
      flecks.push({
        x: anchor.x + (random() - 0.5) * 0.4,
        y: 0.9 + random() * 0.5,
        z: anchor.z + 0.15,
        vx: (random() - 0.5) * 2.4 * power,
        vy: (1 + random() * 1.6) * power,
        vz: (0.4 + random()) * power,
        age: 0,
      });
    }
    while (flecks.length > FLECK_COUNT) flecks.shift();
    flecksMesh.visible = flecks.length > 0;
  };

  const hit = (drop: number, hitsDelta: number): void => {
    const quiet = reduced();
    const parts = splitDamage(drop, hitsDelta);
    parts.forEach((value, index) => spawnNumber(value, (index - (parts.length - 1) / 2) * 0.35, quiet));
    flashColour = quiet ? 'colour' : 'emissive';
    flashTotal = quiet ? ARENA_FX_REDUCED_FLASH_MS : ARENA_FX_FLASH_MS;
    flashLeft = flashTotal;
    applyFlash();
    if (!quiet) {
      wobbleVelocity += WOBBLE_KICK_PER_HP * drop;
      burst(4, 1);
    }
  };

  const knockout = (instant: boolean): void => {
    wobble = 0;
    wobbleVelocity = 0;
    if (instant || reduced()) {
      toppled = 1;
      toppling = false;
    } else {
      toppling = true;
      burst(10, 1.4);
    }
    applyPivot();
    applyFlash();
  };

  const syncFighter = (frame: ArenaViewFrame | null, remote: RemoteSwingPort | null): void => {
    const next = frame && frame.phase !== 'idle' ? frame.challengerId : null;
    if (remote === fighterPort && next === fighter) return;
    if (fighterPort && fighterPort !== remote) {
      try {
        fighterPort.setFighter?.(null);
      } catch {
        // A failing remote layer never stops the fx.
      }
    }
    fighterPort = remote;
    fighter = next;
    try {
      remote?.setFighter?.(next);
    } catch {
      // As above.
    }
  };

  return Object.freeze({
    sync(frame: ArenaViewFrame | null, remote: RemoteSwingPort | null): void {
      if (disposed) return;
      findRoomDummy();
      syncFighter(frame, remote);
      const prev = previous;
      previous = frame;
      if (frame === null) {
        bar.visible = false;
        if (prev !== null) standUp();
        return;
      }
      // A peer's swing, from the server's counter; the fighter's own client plays its own.
      if (
        remote && prev && frame.challengerId !== null && !frame.selfIsChallenger &&
        prev.challengerId === frame.challengerId && frame.challengerSwings !== prev.challengerSwings &&
        (frame.phase === 'fighting' || frame.phase === 'ended')
      ) {
        try {
          remote.playSwing(frame.challengerId);
        } catch {
          // A failing remote layer never stops the fx.
        }
      }
      const d = frame.dummy;
      const pd = prev?.dummy ?? null;
      bar.visible = d !== null && frame.phase !== 'idle';
      if (d === null) {
        if (pd !== null) standUp();
        return;
      }
      const target = d.maxHp > 0 ? d.hp / d.maxHp : 0;
      // A new fight (or the first frame) is a baseline: no numbers, the bar snaps.
      const fresh = pd === null || (prev?.phase === 'idle' && frame.phase !== 'idle') || d.hp > pd.hp;
      if (fresh) {
        if (!d.down) standUp();
        barTarget = target;
        barShown = target;
        applyBar();
        if (d.down) knockout(true);
        return;
      }
      const drop = pd.hp - d.hp;
      if (drop > 0) hit(drop, (d.hits - pd.hits) & 0xff);
      barTarget = target;
      if (reduced() || drop <= 0) barShown = barTarget;
      applyBar();
      if (d.down && !pd.down) knockout(false);
      else if (!d.down && pd.down) standUp();
    },
    update(dt: number): void {
      if (disposed) return;
      findRoomDummy();
      const ms = Number.isFinite(dt) && dt > 0 ? Math.min(dt, MAX_STEP_MS) : 0;
      if (ms === 0) return;
      const s = ms / 1000;
      if (flashLeft > 0) {
        flashLeft = Math.max(0, flashLeft - ms);
        applyFlash();
      }
      if (wobble !== 0 || wobbleVelocity !== 0) {
        // A damped spring about the post's base.
        wobbleVelocity += (-WOBBLE_STIFFNESS * wobble - WOBBLE_DAMPING * wobbleVelocity) * s;
        wobble += wobbleVelocity * s;
        if (Math.abs(wobble) < 1e-4 && Math.abs(wobbleVelocity) < 1e-3) {
          wobble = 0;
          wobbleVelocity = 0;
        }
      }
      if (toppling) {
        toppled = Math.min(1, toppled + ms / ARENA_FX_TOPPLE_MS);
        if (toppled >= 1) toppling = false;
      }
      applyPivot();
      if (barShown !== barTarget) {
        barShown += (barTarget - barShown) * (1 - Math.exp(-ms / BAR_EASE_MS));
        if (Math.abs(barShown - barTarget) < 0.002) barShown = barTarget;
        applyBar();
      }
      for (const n of numbers) {
        if (!n.mesh.visible) continue;
        n.age += ms;
        const t = Math.min(1, n.age / n.life);
        n.mesh.position.y = NUMBER_Y + n.rise * easeOut(t);
        // Hold, then fade over the back half.
        n.mesh.material.opacity = t < 0.4 ? 1 : 1 - (t - 0.4) / 0.6;
        if (t >= 1) n.mesh.visible = false;
      }
      if (flecks.length > 0) {
        for (let i = flecks.length - 1; i >= 0; i -= 1) {
          const f = flecks[i]!;
          f.age += ms;
          f.vy -= 9.8 * s;
          f.x += f.vx * s;
          f.y = Math.max(0.03, f.y + f.vy * s);
          f.z += f.vz * s;
          if (f.age >= FLECK_MS) flecks.splice(i, 1);
        }
        for (let i = 0; i < FLECK_COUNT; i += 1) {
          const f = flecks[i];
          if (!f) {
            flecksMesh.setMatrixAt(i, hidden);
            continue;
          }
          scratch.position.set(f.x, f.y, f.z);
          scratch.rotation.set(f.age * 0.01, f.age * 0.013, 0);
          scratch.updateMatrix();
          flecksMesh.setMatrixAt(i, scratch.matrix);
        }
        flecksMesh.instanceMatrix.needsUpdate = true;
        flecksMesh.visible = flecks.length > 0;
      }
    },
    group,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      try {
        fighterPort?.setFighter?.(null);
      } catch {
        // Best effort.
      }
      group.removeFromParent();
      group.clear();
      owned?.geometry.dispose();
      for (const restore of restores) restore();
      for (const { material } of flashing) material.dispose();
      if (adopted) (adopted as Object3D).rotation.z = 0;
      barBack.geometry.dispose();
      barBackMaterial.dispose();
      fillGeometry.dispose();
      barFillMaterial.dispose();
      for (const n of numbers) n.mesh.material.dispose();
      for (const geometry of numberGeometries.values()) geometry.dispose();
      numberGeometries.clear();
      fleckGeometry.dispose();
      fleckMaterial.dispose();
      flecksMesh.dispose();
    },
  });
}

function easeOut(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return 1 - (1 - c) * (1 - c);
}
