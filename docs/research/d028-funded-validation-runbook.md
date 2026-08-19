# D-028 funded validation runbook

**Status:** preparation only. Do not execute this run without the project lead's
explicit go-ahead, a funded test wallet, and a reviewed deployment. This note
does not authorize a transaction and never asks anyone to paste a secret.

## Purpose

D-028 moves the live-wallet run out of the development critical path, but keeps
it mandatory before launch. The run answers only the unresolved live questions:

- what the wallet actually renders and prompts for;
- end-to-end latency and expiry behavior;
- whether the wallet-produced STRK20 artifact is accepted by the live AVNU
  private paymaster;
- whether the public-shield route has source-verified, fee-aware approval and
  estimation evidence.

Do not turn observations into hardcoded prompt counts. Record what happened,
including zero, one, multiple, or wallet-specific prompts.

## Prerequisites

- A disposable, funded Starknet **mainnet** account in a wallet that exposes
  the required Wallet API methods. Record wallet name/version and the tested
  Wallet API capability result, but never record seed phrases, private keys,
  JWTs, RPC keys, paymaster keys, or raw signed payloads.
- A production-like same-origin web/backend deployment with the selected
  server RPC, AVNU paymaster key/credits, HMAC authorization secret, route
  ceilings, kill switches and aggregate budget configured from the secret
  store. Never put any of these in Vite, a Docker build argument, or chat.
- A reviewed fee-aware public-shield route. D-043 currently says the Ready
  high-level approval shape is not sufficient evidence; stop before signing a
  public shield if the extra fee allowance/transfer path has not been proven.
- A test operator who can stop the run and preserve the signed Bridge record.
  Use a tiny amount chosen for the run, with enough public STRK left for any
  explicitly approved follow-up transaction. Do not use a player's normal
  account.
- A timestamped evidence sheet and screen recording or screenshots with
  addresses, hashes, secrets and signed data redacted.

## Sequence

1. **Preflight without spending.** Confirm the deployed origin, chain ID
   `SN_MAIN`, route enablement and fee ceilings. Confirm that the browser has
   no paymaster/RPC/HMAC secret in its bundle. Connect the wallet through
   runtime capability detection; do not branch by wallet name.
2. **Private balance consent.** Enter Bank and explicitly request the private
   balance. Record whether the wallet shows a balance-consent prompt, its copy,
   ordering and elapsed time. Do not infer spendable/maturing notes from the
   aggregate balance; the production Wallet API result marks maturity unknown.
3. **Small shield, only if the reviewed public route is ready.** Capture the
   live pool fee and the exact gas/fee estimate from the approved estimator.
   Verify the reserve arithmetic and denomination before wallet handoff. Run
   the public approval and shield as the separate explicit operation required
   by D-013/D-043. Record the visible calls/prompts, actual wallet response and
   resulting hash. If fee allowance or estimator evidence is incomplete, stop
   here without signing.
4. **Private transfer.** Prepare one small private transfer through
   `wallet_strk20PrepareInvoke(actions, false)`, then submit through the
   approved backend/paymaster path. Record preparation latency, every visible
   wallet step, whether the returned artifact is accepted, relay latency and
   the first accepted transaction hash. Do not call the simulation form with
   `true` as a submission artifact.
5. **Private batch.** If the wallet and account remain healthy, repeat with a
   small homogeneous batch. Compare the actual prompt sequence and latency to
   the one-intent case; do not assume batching means one visible prompt.
6. **Unshield.** Prepare and submit one small unshield only if the preceding
   route is healthy. Confirm that the public destination and amount are shown
   honestly and that the receipt is retained independently of the panel.
7. **AVNU private swap.** Request one bounded quote for a supported test pair,
   check the displayed expected/protected minimum, slippage and expiry, then
   prove and submit immediately. Confirm the backend rejects a stale or altered
   plan and that a valid wallet-produced artifact reaches AVNU's live
   paymaster. Never delay a quote-bound submission.

## Stop conditions

Stop immediately and preserve evidence if any of the following occurs:

- a wallet prompt contains an unexpected recipient, token, amount, calldata,
  approval, or route;
- the browser bundle or network request exposes a secret or a lobby payload
  contains an address, balance, building, action, or transaction hash;
- the app proposes a guessed maximum, hardcoded public fee, automatic retry,
  unshield-and-call fallback, or a public-shield approval whose fee coverage
  is not proven;
- a prepared artifact is malformed, expired, not bound to the requested route,
  or rejected by backend/AVNU validation;
- a submit response is lost after dispatch. Treat it as
  `submission-uncertain`; do not retry. Wait for the prescribed balance and
  receipt acknowledgement path;
- the wallet signs or broadcasts anything outside the exact test step. Stop
  before any further action and do not attempt cleanup by guessing.

## Evidence to record

For each step record: UTC start/end times; wallet and extension version;
capability result; route and asset names; redacted amount band; whether the
wallet prompt appeared and its exact user-facing copy; prompt count as
observed (never assumed); latency ranges; success/failure state; sanitized
error kind; whether a hash was returned; and a redacted hash prefix only if the
project's evidence policy permits it. Record pool fee, gas estimate, reserve,
slippage and quote expiry as values used by the test, with token/address
identifiers redacted where they could correlate the operator.

Keep the wallet's own activity/history and the backend/AVNU response available
to the project lead through a secure channel. Do not paste screenshots of seed
phrases, private keys, JWTs, API keys, RPC URLs containing keys, HMAC material,
raw proofs, signed artifacts, or unredacted recipient/transaction data into
chat, issues, Git, or this repository.

## Authority

This runbook is derived from D-028, D-022, D-023, D-043, the current
`packages/privacy` README, and the production environment/operations docs.
The run is a prelaunch validation, not a change to the frozen privacy seam.
The public-shield portion remains blocked until the D-043 fee-aware route is
source- and funded-verified; no product decision was made by writing this note.
