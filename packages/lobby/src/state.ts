/**
 * The room schema. This file is the enforcement point.
 *
 * `PresenceState` in `@strkworld/shared` is frozen (D-011) and is the complete
 * list of what the lobby may hold or broadcast. The schema below mirrors it
 * field for field and adds nothing. A field that is not declared here is not
 * encoded, is not stored and cannot reach another client — so the way to be
 * sure the lobby never sees money is to keep this list short, not to be
 * careful everywhere else.
 *
 * `privacy.test.ts` reads the field set back out of the schema at runtime and
 * compares it with the frozen type, so drift fails a test rather than shipping.
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
 */
export const PresenceEntry = schema(
  {
    gameId: 'string',
    position: PositionSchema,
    facing: 'string',
    sprite: 'string',
  },
  'PresenceEntry',
);
export type PresenceEntry = SchemaType<typeof PresenceEntry>;

/**
 * The room's root state: one entry per visible session, keyed by `gameId`.
 *
 * Keyed by `gameId` on purpose. Colyseus would happily key this by its own
 * per-connection session id, but that would put a second identifier on the
 * wire beside the one the frozen seam already defines, and two identifiers per
 * player is one more than the lobby needs.
 *
 * `view: true` makes the map per-observer: an entry reaches a client only
 * while the room has added it to that client's `StateView`. That is the
 * interest management, and it is enforced by the encoder rather than by a
 * filter the room could forget to apply.
 */
export const LobbyState = schema(
  {
    peers: { map: PresenceEntry, view: true },
  },
  'LobbyState',
);
export type LobbyState = SchemaType<typeof LobbyState>;
