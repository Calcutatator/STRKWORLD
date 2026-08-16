# @strkworld/lobby

**Multiplayer presence. Deliberately the dumbest package in the repo.**

A Colyseus room that broadcasts where avatars are. That is all it does, and
that is all it is permitted to do.

---

## The rule

**The lobby never sees money.**

No address. No balance. No transaction hash. No building name. No financial
action. Not in traffic, not in server state, not in logs, not in metrics.

This is where a privacy failure would be quietest — the cryptography can be
perfect and the product still leaks, because the game itself becomes a
side channel. So the constraint is structural rather than a matter of care:

- The room schema is the enforcement point. A field that cannot be added to
  the schema cannot leak.
- Player identity is an **ephemeral per-session `gameId`**, generated
  client-side, never derived from an address, discarded on disconnect.
- No persistence. When the room empties, nothing remains.

If a feature seems to need an address in the lobby, it needs a different
design. Raise it as a decision entry before writing code.

---

## What this owns

- The Colyseus room, its schema and its transport
- Position broadcast and interest management
- Ephemeral session identity

## What this must never do

- Import `@strkworld/privacy` or `starknet`
- Store or log anything that could identify a player across sessions
- Persist state

---

## Why positions are still sensitive

Avatar position is not money, but it is a timing signal. An observer watching
the street learns *when* a player approached a building, and pool activity is
public on-chain — correlating the two is the deanonymisation path.

The lobby cannot fix that on its own. The mitigation lives in the submission
queue (`apps/web`), which decouples transaction broadcast from avatar action.
See `docs/DECISIONS.md` D-004.

What this package must do is avoid making it worse: never broadcast that a
player *entered* a building, only where they are. Entry is a private fact.

---

## Scale

Presence only, so the load is modest — position updates for players sharing a
street. Throttle client-side; do not broadcast every frame. Use interest
management so a player receives only nearby avatars, which bounds traffic and
incidentally limits how much any one observer can watch.
