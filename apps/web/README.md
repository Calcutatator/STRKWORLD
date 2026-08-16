# @strkworld/web

**The shell. Composes everything.**

Providers, routing, layout, and the event bus. Owns two
subsystems that sit between the game and the money and belong to neither:

- **The batch accumulator** — collects player intent during a building visit
  and emits one atomic `STRK20_ACTION[]` on exit. This is the only lever
  against per-action prompts and fees, so it is load-bearing for the economy.

- **The submission queue** — applies randomised delay and batching between
  avatar action and transaction broadcast, breaking the timing correlation
  between entering a building and the resulting on-chain activity. A privacy
  control with its own tests, not an optimisation. See DECISIONS.md D-004.

## What this must never do

- Contain business logic that belongs in a package
- Set `COOP: same-origin` or `COEP: require-corp` — they break web wallets
  and we do not need them. There is a CI check
- Expose a paymaster key to the browser bundle. It is proxied server-side
