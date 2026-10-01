import type { AvatarSpriteKey } from '@strkworld/shared';
import { validateAvatarSprite } from '../avatar-state.js';

/**
 * The sixteen low-poly avatar looks (D-059), one per opaque wire key.
 *
 * Pure data: no three.js. The lobby still sends `avatar-1..avatar-16`, so each
 * key maps to one stable look. Cosy `avatar-N` and fighting `avatar-N+8` are
 * the same person in two outfits (`pairedAvatarSprite`), so a look is a shared
 * `character` (build, skin, hair) plus its own `outfit`. Both looks of a pair
 * reference the same character object, which makes "a pair shares skin and
 * hair" true by construction rather than by careful copying.
 *
 * Colours are sampled from the approved sprite sheets in
 * `assets/player-sprites/v1` (mid tones, nudged lighter where pixel-art shading
 * colours would read black once the 3D lighting adds its own shading).
 * Appearance carries no wallet, account, protocol or financial meaning.
 */

/** Size class from the approved sprites: only 6/14 are small, only 4/7/12/15 are large. */
export type AvatarBuild = 'small' | 'standard' | 'large';

export type AvatarHairStyle =
  | 'spiky'
  | 'ponytail'
  | 'bob'
  | 'swept'
  | 'long'
  | 'buns'
  | 'mop'
  | 'shaggy'
  | 'kitten';

export interface AvatarHair {
  readonly style: AvatarHairStyle;
  readonly color: number;
  /** Facial hair colour; absent for a clean-shaven face. */
  readonly beard?: number;
}

/** Cat ears standing up through the hair: fur outside, a paler inner ear. */
export interface AvatarEars {
  readonly fur: number;
  readonly inner: number;
}

/** A short tail from the small of the back, curling up to a paler tip. */
export interface AvatarTail {
  readonly fur: number;
  readonly tip: number;
}

/** Small marks on the face: blushed cheeks and a little cat mouth. */
export interface AvatarFace {
  readonly blush: number;
  readonly mouth: number;
}

/** Everything the cosy and fighting states of one person share. */
export interface AvatarCharacter {
  /** 1..8: the manifest's character number. */
  readonly id: number;
  readonly build: AvatarBuild;
  readonly skin: number;
  readonly hair: AvatarHair;
  readonly ears?: AvatarEars;
  readonly tail?: AvatarTail;
  readonly face?: AvatarFace;
}

export interface AvatarBelt {
  readonly color: number;
  readonly buckle: number;
}

/** Wearable extras. Each kind is built by the figure module from these colours. */
export type AvatarGear =
  | { readonly kind: 'scarf'; readonly color: number }
  | { readonly kind: 'harness'; readonly color: number; readonly buckle: number }
  | { readonly kind: 'wraps'; readonly color: number }
  | { readonly kind: 'goggles'; readonly frame: number; readonly lens: number }
  | { readonly kind: 'hood'; readonly color: number }
  | { readonly kind: 'mantle'; readonly color: number }
  | { readonly kind: 'satchel'; readonly color: number }
  /** Two pouches on the belt, a tool's handle standing out of one. */
  | { readonly kind: 'toolPouches'; readonly color: number; readonly tool: number }
  | {
      readonly kind: 'coat';
      readonly color: number;
      readonly trim: number;
      /** Knee coats are open at the front; ankle robes are closed bells. */
      readonly length: 'knee' | 'ankle';
    }
  | { readonly kind: 'furCollar'; readonly color: number }
  | { readonly kind: 'cloak'; readonly color: number }
  | { readonly kind: 'pauldrons'; readonly color: number }
  | {
      readonly kind: 'breastplate';
      readonly color: number;
      readonly trim: number;
      readonly coverage: 'full' | 'upper';
    }
  | { readonly kind: 'hornedHelmet'; readonly color: number; readonly horn: number }
  | { readonly kind: 'shield'; readonly face: number; readonly emblem: number; readonly rim: number };

/** The fighting states' one visible weapon set, held in the right hand. */
export type AvatarWeapon =
  | { readonly kind: 'sword'; readonly blade: number; readonly hilt: number }
  | {
      readonly kind: 'wrench';
      readonly size: 'hand' | 'giant';
      readonly head: number;
      readonly handle: number;
    }
  | { readonly kind: 'crossbow'; readonly stock: number; readonly limbs: number; readonly string: number }
  | { readonly kind: 'mace'; readonly head: number; readonly handle: number }
  | { readonly kind: 'staff'; readonly shaft: number; readonly ring: number; readonly orb: number }
  | { readonly kind: 'halberd'; readonly blade: number; readonly shaft: number };

export interface AvatarOutfit {
  /** The torso garment (or what shows in an open coat's front). */
  readonly top: number;
  /** Upper-arm colour; null leaves the arms bare. */
  readonly sleeves: number | null;
  /** Glove or bracer colour; null leaves the hands bare. */
  readonly gloves: number | null;
  readonly trousers: number;
  readonly boots: number;
  readonly belt: AvatarBelt | null;
  readonly gear: readonly AvatarGear[];
  readonly weapon: AvatarWeapon | null;
}

export interface AvatarLook {
  readonly key: AvatarSpriteKey;
  readonly stance: 'cosy' | 'fighting';
  readonly character: AvatarCharacter;
  readonly outfit: AvatarOutfit;
}

// Characters: one per cosy/fighting pair.

const CHARACTER_1: AvatarCharacter = {
  id: 1,
  build: 'standard',
  skin: 0xe9ad6f,
  hair: { style: 'spiky', color: 0xb3540d },
};

const CHARACTER_2: AvatarCharacter = {
  id: 2,
  build: 'standard',
  skin: 0xf3b865,
  hair: { style: 'ponytail', color: 0xd9500b },
};

const CHARACTER_3: AvatarCharacter = {
  id: 3,
  build: 'standard',
  skin: 0xefbe7e,
  hair: { style: 'bob', color: 0x1f5647 },
};

const CHARACTER_4: AvatarCharacter = {
  id: 4,
  build: 'large',
  skin: 0xd98f58,
  hair: { style: 'swept', color: 0xdea53a, beard: 0xf3d28e },
};

const CHARACTER_5: AvatarCharacter = {
  id: 5,
  build: 'standard',
  skin: 0xf6d4a0,
  hair: { style: 'long', color: 0xe7a41e },
};

// The cat girl: the pocket mechanic with cat ears up through her pink hair, a
// curling tail and a blush. Her ears and tail are the hair's pink, their
// insides and tip paler, so they read as hers rather than as a hat.
const CHARACTER_6: AvatarCharacter = {
  id: 6,
  build: 'small',
  skin: 0xf6c27a,
  hair: { style: 'kitten', color: 0xe0404f },
  ears: { fur: 0xe0404f, inner: 0xf8bfca },
  tail: { fur: 0xe0404f, tip: 0xfbe2e6 },
  face: { blush: 0xf09088, mouth: 0x8a4038 },
};

const CHARACTER_7: AvatarCharacter = {
  id: 7,
  build: 'large',
  skin: 0xe2ae78,
  hair: { style: 'mop', color: 0x37532b },
};

const CHARACTER_8: AvatarCharacter = {
  id: 8,
  build: 'standard',
  skin: 0xecc488,
  hair: { style: 'shaggy', color: 0x25498e },
};

// Outfits. Fighting states keep the cosy palette (README: "Cosy and fighting
// states preserve each character's hair and clothing palette") and add gear.

const COSY_1: AvatarOutfit = {
  top: 0x0a5663,
  sleeves: null,
  gloves: 0x8f420a,
  trousers: 0x0a4652,
  boots: 0x7a3606,
  belt: { color: 0x5b3118, buckle: 0xc09a5c },
  gear: [
    { kind: 'scarf', color: 0x0f7a89 },
    { kind: 'harness', color: 0x5e2f12, buckle: 0xc09a5c },
    { kind: 'wraps', color: 0xc7a468 },
  ],
  weapon: null,
};

const COSY_2: AvatarOutfit = {
  top: 0x676034,
  sleeves: 0x82561f,
  gloves: 0x6b3a12,
  trousers: 0x2e4630,
  boots: 0x4f2a0c,
  belt: { color: 0x4a2a10, buckle: 0xaca464 },
  gear: [{ kind: 'goggles', frame: 0x8a5a1c, lens: 0xa3a060 }],
  weapon: null,
};

const COSY_3: AvatarOutfit = {
  top: 0x1c4436,
  sleeves: 0xf2d49e,
  gloves: 0xa9702d,
  trousers: 0x25372c,
  boots: 0x6e3b09,
  belt: { color: 0x603003, buckle: 0xd28d37 },
  gear: [
    { kind: 'hood', color: 0xf3dcaa },
    { kind: 'mantle', color: 0xf1d39a },
    { kind: 'satchel', color: 0x8a4c0c },
  ],
  weapon: null,
};

const COSY_4: AvatarOutfit = {
  top: 0x2e5646,
  sleeves: 0xf3d59c,
  gloves: 0x6b3a0a,
  trousers: 0x37432c,
  boots: 0x74400a,
  belt: { color: 0x6b3905, buckle: 0xd18a27 },
  gear: [
    { kind: 'coat', color: 0xf3d59c, trim: 0xfbe9c4, length: 'knee' },
    { kind: 'furCollar', color: 0xfbe9c4 },
    { kind: 'satchel', color: 0x7a4206 },
  ],
  weapon: null,
};

const COSY_5: AvatarOutfit = {
  top: 0x3b3126,
  sleeves: 0xf0cd8a,
  gloves: null,
  trousers: 0x2f2a24,
  boots: 0x6b3a07,
  belt: { color: 0x7a4308, buckle: 0xe59108 },
  gear: [{ kind: 'coat', color: 0xf0cd8a, trim: 0xb8721c, length: 'ankle' }],
  weapon: null,
};

const COSY_6: AvatarOutfit = {
  top: 0xde7f22,
  sleeves: 0xde7f22,
  gloves: 0x8c4a0c,
  trousers: 0x1e3b45,
  boots: 0x4a2408,
  belt: { color: 0x183640, buckle: 0xd8b55f },
  gear: [
    { kind: 'goggles', frame: 0xb0701c, lens: 0x22505c },
    { kind: 'toolPouches', color: 0x8c4a0c, tool: 0xd8b55f },
  ],
  weapon: null,
};

const COSY_7: AvatarOutfit = {
  top: 0x22402a,
  sleeves: 0x4a622a,
  gloves: 0x6c3b08,
  trousers: 0x2a3a24,
  boots: 0x5d3206,
  belt: { color: 0x6c3b08, buckle: 0xa06c14 },
  gear: [
    { kind: 'cloak', color: 0x4a622a },
    { kind: 'furCollar', color: 0xf3d392 },
    { kind: 'harness', color: 0x6c3b08, buckle: 0xa06c14 },
  ],
  weapon: null,
};

const COSY_8: AvatarOutfit = {
  top: 0xd8c29a,
  sleeves: 0x1f4586,
  gloves: 0x6e3a0c,
  trousers: 0x26324a,
  boots: 0x4f2a10,
  belt: { color: 0x79410c, buckle: 0xc27310 },
  gear: [{ kind: 'coat', color: 0x1f4586, trim: 0xd09a3a, length: 'knee' }],
  weapon: null,
};

const FIGHTING_1: AvatarOutfit = {
  ...COSY_1,
  gear: [...COSY_1.gear, { kind: 'pauldrons', color: 0x9b5413 }],
  weapon: { kind: 'sword', blade: 0xe2dcc4, hilt: 0x9b5413 },
};

const FIGHTING_2: AvatarOutfit = {
  ...COSY_2,
  weapon: { kind: 'wrench', size: 'hand', head: 0xa8a36c, handle: 0xe8962e },
};

const FIGHTING_3: AvatarOutfit = {
  ...COSY_3,
  weapon: { kind: 'crossbow', stock: 0xa0621a, limbs: 0x5a4520, string: 0xe8d9b0 },
};

const FIGHTING_4: AvatarOutfit = {
  top: 0x5a6068,
  sleeves: 0x5f656c,
  gloves: 0x6d6a5c,
  trousers: 0x3b3a36,
  boots: 0x55585c,
  belt: { color: 0x6b3905, buckle: 0xe0a133 },
  gear: [
    { kind: 'furCollar', color: 0xfbe9c4 },
    { kind: 'breastplate', color: 0x6a7076, trim: 0xe0a133, coverage: 'full' },
    { kind: 'pauldrons', color: 0x6d7379 },
    { kind: 'shield', face: 0x2f5570, emblem: 0xeab54c, rim: 0x8f5212 },
  ],
  weapon: { kind: 'mace', head: 0x7b7665, handle: 0x6a3d0e },
};

const FIGHTING_5: AvatarOutfit = {
  ...COSY_5,
  weapon: { kind: 'staff', shaft: 0x8a4c0c, ring: 0xd88c12, orb: 0x3d6150 },
};

const FIGHTING_6: AvatarOutfit = {
  ...COSY_6,
  weapon: { kind: 'wrench', size: 'giant', head: 0x56554a, handle: 0xc0702a },
};

const FIGHTING_7: AvatarOutfit = {
  top: 0x96581a,
  sleeves: 0x96581a,
  gloves: 0x8d5a14,
  trousers: 0x2a3a24,
  boots: 0x736b3c,
  belt: { color: 0x5a3208, buckle: 0xe9d7a1 },
  gear: [
    { kind: 'cloak', color: 0x4a622a },
    { kind: 'hornedHelmet', color: 0xb08a3e, horn: 0xece0b4 },
    { kind: 'breastplate', color: 0xb0761a, trim: 0xe9d7a1, coverage: 'full' },
    { kind: 'pauldrons', color: 0xb0761a },
  ],
  weapon: { kind: 'halberd', blade: 0xe3d6a8, shaft: 0x7a4a12 },
};

const FIGHTING_8: AvatarOutfit = {
  ...COSY_8,
  gear: [
    ...COSY_8.gear,
    { kind: 'breastplate', color: 0xe2a335, trim: 0xf0d08a, coverage: 'upper' },
  ],
  weapon: { kind: 'sword', blade: 0xd4dae2, hilt: 0xd39a2e },
};

function look(
  key: AvatarSpriteKey,
  stance: AvatarLook['stance'],
  character: AvatarCharacter,
  outfit: AvatarOutfit,
): AvatarLook {
  return { key, stance, character, outfit };
}

/** Shared by every figure, so nothing may mutate it at runtime. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const AVATAR_LOOKS: Readonly<Record<AvatarSpriteKey, AvatarLook>> = deepFreeze({
  // Auburn spiky-haired adventurer: teal scarf and tunic, leather harness, bare arms, bracers, wrapped boots.
  'avatar-1': look('avatar-1', 'cosy', CHARACTER_1, COSY_1),
  // Red side-ponytail mechanic: olive work jacket, dark green trousers, brass goggles pushed up.
  'avatar-2': look('avatar-2', 'cosy', CHARACTER_2, COSY_2),
  // Teal-haired ranger: cream hood and puffy mantle over a forest-green tunic, satchel.
  'avatar-3': look('avatar-3', 'cosy', CHARACTER_3, COSY_3),
  // Large golden-bearded elder: cream fur-trimmed coat over a green tunic, satchel, brown gloves.
  'avatar-4': look('avatar-4', 'cosy', CHARACTER_4, COSY_4),
  // Long-haired blonde scholar: ankle-length cream-and-gold robe over a dark underdress.
  'avatar-5': look('avatar-5', 'cosy', CHARACTER_5, COSY_5),
  // Small pink cat-girl mechanic: cat ears and tail, orange jumpsuit, dark teal tool belt and trousers, brass goggles.
  'avatar-6': look('avatar-6', 'cosy', CHARACTER_6, COSY_6),
  // Large moss-haired woodsman: mossy cloak, cream fur collar, leather harness over a green tunic.
  'avatar-7': look('avatar-7', 'cosy', CHARACTER_7, COSY_7),
  // Navy-haired duellist: navy long coat with gold trim over a linen shirt, dark trousers.
  'avatar-8': look('avatar-8', 'cosy', CHARACTER_8, COSY_8),
  // Character 1 fighting: adds leather pauldrons and a sword.
  'avatar-9': look('avatar-9', 'fighting', CHARACTER_1, FIGHTING_1),
  // Character 2 fighting: adds a hand wrench.
  'avatar-10': look('avatar-10', 'fighting', CHARACTER_2, FIGHTING_2),
  // Character 3 fighting: adds a crossbow.
  'avatar-11': look('avatar-11', 'fighting', CHARACTER_3, FIGHTING_3),
  // Character 4 fighting: steel plate with gold trim, fur collar kept, kite shield and flanged mace.
  'avatar-12': look('avatar-12', 'fighting', CHARACTER_4, FIGHTING_4),
  // Character 5 fighting: adds an orb staff.
  'avatar-13': look('avatar-13', 'fighting', CHARACTER_5, FIGHTING_5),
  // Character 6 fighting: the cat girl with a giant wrench.
  'avatar-14': look('avatar-14', 'fighting', CHARACTER_6, FIGHTING_6),
  // Character 7 fighting: horned bronze helm, bronze plate and pauldrons, mossy cape, halberd.
  'avatar-15': look('avatar-15', 'fighting', CHARACTER_7, FIGHTING_7),
  // Character 8 fighting: adds a gold chest plate and a sword.
  'avatar-16': look('avatar-16', 'fighting', CHARACTER_8, FIGHTING_8),
});

/** The look for a key, falling back like `validateAvatarSprite` for untrusted input. */
export function avatarLook(key: unknown): AvatarLook {
  return AVATAR_LOOKS[validateAvatarSprite(key)];
}
