/**
 * The room schema. This file is the enforcement point.
 *
 * `PresenceState` in `@strkworld/shared` is frozen (D-011) and is the complete
 * list of what the lobby may hold or broadcast about a player. The presence
 * entry below mirrors it field for field and adds nothing. A field that is not
 * declared here is not encoded, is not stored and cannot reach another client
 * — so the way to be sure the lobby never sees money is to keep this list
 * short, not to be careful everywhere else.
 *
 * The one thing beside presence is D-060's block sandbox: stacks of palette
 * indices keyed by street tile. A column names a tile and its colours and
 * nothing else — no player, no identifier, no time — so block state carries
 * no identity field. That is not the same as being unattributable: an
 * observer inside the presence interest radius can correlate a peer's
 * `carrying` change with a neighbouring column change in the same patch, and
 * any observer learns that someone was within reach of a tile that changed.
 * Neither says anything about money; see README.md.
 *
 * `privacy.test.ts` reads the field sets back out of the schema at runtime and
 * compares them with the frozen types, so drift fails a test rather than
 * shipping.
 *
 * Defined with the functional `schema()` API rather than `@type()` decorators:
 * the repository's TypeScript configuration enables neither legacy nor
 * standard decorators, and this form needs neither.
 */

import { schema, type SchemaType } from '@colyseus/schema';

/** Mirrors `Position` from the frozen seam. */
export const PositionSchema = schema(
  {
    x: 'number',
    y: 'number',
  },
  'Position',
);
export type PositionSchema = SchemaType<typeof PositionSchema>;

/**
 * Mirrors `PresenceState` from the frozen seam, exactly.
 *
 * `facing` and `sprite` are declared as strings because the wire format has no
 * enum type. They are narrowed at the boundary instead — see `policy.ts` — so
 * nothing outside the four facings or the sprite list ever reaches an instance.
 *
 * `carrying` (D-060) is an `int8`: a sandbox palette index, or -1 for empty
 * hands. Only the room writes it, from the sandbox authority's own record, so
 * a client has no way to put a value of its choosing there.
 */
export const PresenceEntry = schema(
  {
    gameId: 'string',
    position: PositionSchema,
    facing: 'string',
    sprite: 'string',
    carrying: { type: 'int8', default: -1 },
  },
  'PresenceEntry',
);
export type PresenceEntry = SchemaType<typeof PresenceEntry>;

/**
 * One sandbox stack (D-060): a street tile and its colours from the ground up.
 *
 * `uint8` throughout. Sandbox tiles, heights and palette indices all fit, and
 * a byte-sized field has no room to carry anything else. The room never keeps
 * an empty column: the entry is deleted when its last block is taken.
 */
export const SandboxColumnEntry = schema(
  {
    x: 'uint8',
    y: 'uint8',
    colours: { array: 'uint8' },
  },
  'SandboxColumn',
);
export type SandboxColumnEntry = SchemaType<typeof SandboxColumnEntry>;

/**
 * The room's root state.
 *
 * `peers` holds one entry per visible session, keyed by `gameId`. Keyed by
 * `gameId` on purpose: Colyseus would happily key this by its own
 * per-connection session id, but that would put a second identifier on the
 * wire beside the one the frozen seam already defines, and two identifiers per
 * player is one more than the lobby needs.
 *
 * `view: true` makes `peers` per-observer: an entry reaches a client only
 * while the room has added it to that client's `StateView`. That is the
 * interest management, and it is enforced by the encoder rather than by a
 * filter the room could forget to apply.
 *
 * `sandbox` holds the block stacks, keyed by `"x,y"`. It is deliberately
 * *not* view-filtered: everyone in the room shares one sandbox and it is small
 * (at most 900 blocks), so every client receives all of it (D-060).
 */
export const LobbyState = schema(
  {
    peers: { map: PresenceEntry, view: true },
    sandbox: { map: SandboxColumnEntry },
  },
  'LobbyState',
);
export type LobbyState = SchemaType<typeof LobbyState>;
