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

## Building presence in v1

When a player enters a building, the client leaves or suspends lobby presence.
Other players see the avatar disappear. A nearby observer may therefore infer
the chosen building and visit timing from the last coordinate; that leak is an
explicitly accepted v1 trade-off (D-019).

The lobby still never receives an entry event or building ID. Financial
submission remains a separate privacy problem: where the route permits it, the
backend decouples prepared-action broadcast from the avatar event. That
mitigation is bounded and must not be described as defeating timing
correlation (D-015).

---

## Scale

Presence only, so the load is modest — position updates for players sharing a
street. Throttle client-side; do not broadcast every frame. Use interest
management so a player receives only nearby avatars, which bounds traffic and
incidentally limits how much any one observer can watch.
