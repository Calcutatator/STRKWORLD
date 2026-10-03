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
 * Beside presence there is D-060's block sandbox: stacks of palette
 * indices keyed by street tile. A column names a tile and its colours and
 * nothing else — no player, no identifier, no time — so block state carries
 * no identity field. That is not the same as being unattributable: an
 * observer inside the presence interest radius can correlate a peer's
 * `carrying` change with a neighbouring column change in the same patch, and
 * any observer learns that someone was within reach of a tile that changed.
 * Neither says anything about money; see README.md.
 *
 * And there is D-078's football: one ball, the score and the phase of play.
 * It names no one either: a kick or a push shows only as the ball moving, so
 * an observer who sees a peer beside the ball when it moves can guess who
 * touched it, as with the sandbox, and nothing more.
 *
 * And D-114's arena ring: a phase, a round, two slots of counters and the
 * result, all bytes but the round. A player slot carries the presence id
 * arena peers already hold for that avatar, and the entry is view-filtered
 * to arena members, so nobody outside the arena learns who is fighting.
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
 *
 * `jumps` (D-097) is a `uint8` counter that wraps at 256: peers play a jump
 * when it changes. Only the room writes it, one step per accepted `jump`
 * message, so a client cannot choose its value either, and a byte holds
 * nothing else. It rides the same per-observer view as the rest of the entry,
 * so only peers that already see this player are told it jumped.
 *
 * `seat` (D-127) is an `int8`: an index into `STREET_SEATS`, or -1 standing.
 * One byte is the whole cost of sitting on a bench, because the seat's own
 * place and the way a sitter looks are in that shared table. Only the room
 * writes it, and only for an index that is a real seat whose spot is where the
 * room already holds that player, and only while no other live entry holds it,
 * so a client can neither invent a seat nor share one.
 */
export const PresenceEntry = schema(
  {
    gameId: 'string',
    position: PositionSchema,
    facing: 'string',
    sprite: 'string',
    carrying: { type: 'int8', default: -1 },
    jumps: { type: 'uint8', default: 0 },
    seat: { type: 'int8', default: -1 },
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
 * The ball, the score and the phase of play (D-078), written only by the
 * room from its own simulation: nothing a client sends is copied here.
 *
 * `x`/`y` are World pixels and `vx`/`vy` World pixels per second, each in
 * whole 64ths (`FOOTBALL_WIRE_SCALE`) as an `int32`: whole numbers, like
 * every other field here, so the state has no spare precision for anything
 * to hide in. `tick` is the simulation step the sample is from, so a client
 * can place each sample in time however patches arrive. The score and the
 * phase are bytes: a score never passes `FOOTBALL_WIN_SCORE`, and the phase
 * is 0 live, 1 goal, 2 full time. No field could name a player.
 */
export const FootballEntry = schema(
  {
    tick: 'uint32',
    x: 'int32',
    y: 'int32',
    vx: 'int32',
    vy: 'int32',
    west: 'uint8',
    east: 'uint8',
    phase: 'uint8',
  },
  'Football',
);
export type FootballEntry = SchemaType<typeof FootballEntry>;

/**
 * One slot of the arena ring (D-114): who or what stands there and its
 * counters, written only by the room from its ring authority.
 *
 * `kind` is a byte (0 empty, 1 player, 2 dummy: `ARENA_SLOT_KINDS`'s
 * index). `gameId` is the ephemeral presence id when `kind` is a player and
 * empty otherwise: the same id every peer in the arena already holds for
 * that avatar, and nothing else. `hp` is 0..100, and `swings` and `hits`
 * are counters that wrap at 256 so peers can animate a swing or a hit from a
 * change. D-128 adds `guarding` (0 or 1: the slot holds a block) and
 * `blocks`, a counter that wraps the same way for blocked hits. No field
 * could hold anything else.
 */
export const ArenaSlotEntry = schema(
  {
    kind: 'uint8',
    gameId: 'string',
    hp: 'uint8',
    swings: 'uint8',
    hits: 'uint8',
    guarding: 'uint8',
    blocks: 'uint8',
  },
  'ArenaSlot',
);
export type ArenaSlotEntry = SchemaType<typeof ArenaSlotEntry>;

/**
 * The arena ring (D-114): the phase (`ARENA_PHASES`'s index), the round
 * (mod 65536, +1 per accepted claim), the two slots, the whole seconds left
 * in a countdown or a fight, and the result (`reason` and `winner` are
 * `ARENA_END_REASONS`'s and `ARENA_SIDES`'s index plus one; 0 is none).
 * Bytes and one 16-bit counter, plus the slots' presence ids. D-128 adds
 * `champion`, the ephemeral presence id of whoever last won a fight here (or
 * empty), and `seated` (0 or 1: they are on the emperor's throne).
 */
export const ArenaRingEntry = schema(
  {
    phase: 'uint8',
    round: 'uint16',
    challenger: ArenaSlotEntry,
    opponent: ArenaSlotEntry,
    secondsLeft: 'uint8',
    reason: 'uint8',
    winner: 'uint8',
    champion: 'string',
    seated: 'uint8',
  },
  'ArenaRing',
);
export type ArenaRingEntry = SchemaType<typeof ArenaRingEntry>;

/** The one key the `arena` map holds. */
export const ARENA_RING_KEY = 'ring';

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
 *
 * `football` is the one ball (D-078), shared the same way: every client sees
 * the same ball and scoreboard.
 *
 * `arena` (D-114) holds one entry, key `'ring'`, and is `view: true` like
 * `peers`: the room adds the entry to a client's view only while that client
 * is live in the arena, so no street, roof, Studio or bunker player is ever
 * sent who is fighting. That keeps D-087's rule that no field says which area
 * anyone is in.
 */
export const LobbyState = schema(
  {
    peers: { map: PresenceEntry, view: true },
    sandbox: { map: SandboxColumnEntry },
    football: FootballEntry,
    arena: { map: ArenaRingEntry, view: true },
  },
  'LobbyState',
);
export type LobbyState = SchemaType<typeof LobbyState>;
