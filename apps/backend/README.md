# @strkworld/backend

**The server-side privacy boundary. Planned; no implementation yet.**

The browser cannot hold the paymaster key or send privacy-sensitive RPC reads
directly to a third party. This app owns the smallest server surface needed to
submit eligible prepared Wallet API calls and proxy those reads.

## What this owns

- Paymaster-key custody and fee-action ceiling checks
- Recipient-registration and receipt RPC proxies
- Bounded submission jitter for eligible prepared calls only
- Aggregate rate, budget and health counters
- Global and per-route kill switches

AVNU's quote-bound first-party flow does not pass through the delay queue.

## Request boundary

Accept strict, versioned request shapes only. A request identifies an approved
route and carries only the data that route requires. Validate the visible
submission target, chain, pool/executor address, fee action, proof freshness and
route state. `packages/privacy` remains responsible for constructing the typed
action and its contract, selector, token, quote and slippage allowlists.

Never expose a generic transaction relay or accept an arbitrary destination or
calldata blob. If route validation cannot be completed, fail closed; the
client keeps the building locked (D-018).

## What this must never do

- Log or persist per-request IPs, calls, proofs, timings, recipients or
  transaction hashes
- Correlate lobby sessions with financial requests
- Inspect or hold a viewing key, note set or user secret
- Delay an AVNU quote or a prepared proof beyond its validity window
- Turn a missing private route into a public transaction

See D-014 for the backend threat model, D-015 for queue placement and D-018
for the building privacy-admission rule.
