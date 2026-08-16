# @strkworld/web

**The shell. Composes everything.**

Providers, routing, layout, and the event bus. Owns the building panels and the
batch accumulator that sits between the game and the financial seam:

- **The batch accumulator** — collects player intent during a building visit
  and emits one atomic `STRK20_ACTION[]` on exit. This is the only lever
  against per-action prompts and fees, so it is load-bearing for the economy.

The shell emits only typed intents. It never accepts a raw contract target,
selector or calldata blob, and it never falls back to unshielding and calling a
protocol publicly. An unavailable private route means a locked building
(D-018).

The submission queue is backend-owned on prepared Wallet API paths, bounded by
proof validity, and never delays quote-bound AVNU actions (D-015). Entering a
building separately suspends lobby presence; other players seeing the avatar
disappear is accepted for v1 (D-019).

## What this must never do

- Contain business logic that belongs in a package
- Set `COOP: same-origin` or `COEP: require-corp` — they break web wallets
  and we do not need them. There is a CI check
- Expose a paymaster key to the browser bundle. It is proxied server-side
