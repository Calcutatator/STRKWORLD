# @strkworld/privacy

**The financial seam. The only package that talks to Starknet.**

Everything the rest of the app knows about money goes through one interface,
`PrivacyOperations`. Nothing outside this package imports `starknet`.

---

## What this owns

- The `PrivacyOperations` interface and its implementations
- Wallet connection, capability detection and error mapping
- Action-array construction, including the open-note invariant
- Recipient registration preflight
- Runtime pool config reads (fee, proof-validity window)

## The building privacy gate

A building is UI over a typed intent, not a generic transaction composer. An
active financial building must map to exactly one approved execution route:

- a pool-native Wallet API action (Bank, Post Office),
- a protocol's first-party STRK20 integration (AVNU Exchange), or
- a reviewed, audited and allowlisted app-specific anonymizer (Vault).

There is no public fallback. If a route is unavailable, stale or killed, the
door stays locked. Never expose raw contract targets, selectors or calldata to
the shell; this package owns their allowlists plus token, quote, slippage, fee
and action-limit validation. See `docs/DECISIONS.md` D-018.

Every enabled route also receives an explicit token allowlist. Syntactically
valid is not admitted: input and output tokens must pass that route's list
before the wallet is asked to prove or sign.

## What this must never do

- Import from `@strkworld/world` or `@strkworld/lobby`
- Contain UI
- Branch on wallet identity — no `wallet.id ===`, no name matching, no
  allowlist. Capability is determined at runtime, and this is what keeps web
  wallets possible later
- Hold key material, run a prover, or manage note discovery. The wallet does
  all of that

---

## The interface

Intent-based and two-phase since D-015 — the earlier single-shot
shield/unshield/transfer shape is superseded. `src/operations.ts` is
authoritative; in outline:

```ts
interface PrivacyOperations {
  capability(signal?: AbortSignal): Promise<WalletCapability>
  poolConfig(signal?: AbortSignal): Promise<PoolConfig>
  balances(tokens?: Address[], signal?: AbortSignal): Promise<PrivateBalance[]>
  recipientStatus(address: Address, signal?: AbortSignal): Promise<RecipientStatus>
  prepare(intents: Intent[], signal?: AbortSignal): Promise<PreparedBatch>
  // PreparedBatch.confirm({ feeCeiling, onProgress?, signal? }) executes;
  // it refuses to sign if the fee moved past the ceiling.
}
```

The interface remains **provisional until the Chain lane explicitly freezes
it** under D-028. Source-derived implementation work proceeds now; a change
still needs a decision entry and a heads-up to the shell lane — never a quiet
edit.

`WalletApiPrivacyOperations` is the source-derived wallet-backed
implementation and `FakePrivacyOperations` implements the same interface for
deterministic offline work. The implementation has not yet passed the funded
pre-launch run required by D-028, so rendered prompt sequence, latency and
live-paymaster artifact acceptance remain provisional. The interface exists so
that:

1. the whole financial layer can be driven by a mock in tests,
2. a second implementation can be added without touching callers,
3. the forward-compatibility test can prove a non-extension wallet works.

The seam is **source-derived and provisional pending an explicit Chain-lane
freeze decision**. D-015 replaced the earlier one-shot methods because they
could not express atomic batches, fee validation before proving, cancellation,
or backend-delayed submission. D-028 moved the funded wallet run to the
pre-launch checklist rather than leaving it as a development gate. Any seam
change still needs a decision entry and a heads-up to the Shell lane.

The shipped Wallet API types expose one aggregate balance per token, not the
spendable/maturing split used by the low-level SDK. Real wallet results therefore
set `maturityKnown: false` and keep both subfields at conservative zero. The
shell may display `total`, but must not offer MAX from an invented maturity
split; proof-time wallet validation is authoritative.

### Prepare, then submit through the correct route

`prepare()` translates typed intents into an allowlisted `STRK20_ACTION[]` and
returns costs, warnings and a confirmation handle. The submission path depends
on the route:

- A private pool action is proven with
  `wallet_strk20PrepareInvoke(actions, false)`. The resulting call and proof can
  be validated, queued within the live proof-validity window, and relayed by
  AVNU's paymaster without the user's account signer.
- A quote-bound AVNU swap uses the same wallet proof artifact but skips timing
  delay; delaying it risks submitting an expired quote. The backend chooses
  the private quote and executor calls, then the browser passes that bounded
  plan through AVNU's `buildStrk20Actions()`. The bought asset is created
  directly as an `OPEN` pool note; there is no public output or second shield
  step.
- A shield starts with a public ERC-20 approval and cannot be funded from the
  pool. It is not the private queued path, and it is never bundled with the
  action it later funds.

Mixed shield/private input is rejected rather than silently split. One
`PreparedBatch.confirm()` returns one transaction hash, so claiming to split it
would lose one receipt and blur the public/private boundary. The shell must run
the two explicit operations in sequence.

`strk20PrepareInvoke(actions, true)` is simulation only. It skips proof
generation and returns an empty, non-submittable proof; use it for previews,
never for the submission queue.

---

## Non-obvious things

**Amounts are `bigint`, always.** No `number`, no float, no string
arithmetic. Token amounts exceed `Number.MAX_SAFE_INTEGER` routinely and a
silent precision loss here is a lost-funds bug.

**Addresses need padding-tolerant comparison.** The same address appears
padded and unpadded depending on source. Compare normalised, never with
`===`.

**Read the pool fee at runtime.** `get_fee_amount()` is governance-settable
and has already changed once. Do not hardcode it. A proof-validity window
also applies, so a prepared proof expires — submit promptly or re-prepare.

**Registration is preflightable, and the Wallet API cannot do it.** Use the
pool's `get_public_key(address)` over ordinary RPC; unregistered returns
`0x0`. Preflight *and* map error 118 at transaction time — the two must
agree.

**Batching is the only lever against prompts and fees.** Ready 5.33.8 creates
one wallet action for an entire STRK20 action array and folds deposit approval
calls into the same transaction action. The funded Phase 0 UI run must still
confirm the visible prompt sequence before the seam promises an exact count.
The batch accumulator lives in `apps/web` because it sits between game and
money; this package just executes what it is handed.

---

## Version pins that matter

Pin the tested connection stack together and exactly:

```text
starknet                                      10.4.0
@starknet-io/types-js                         0.10.3
@starknet-io/get-starknet-discovery           6.0.3
@starknet-io/get-starknet-wallet-standard     6.0.3
```

npm `latest` for `starknet` is not a safe instruction: the published tags do
not advance monotonically, and a version without the v6 STRK20 surface can
otherwise fail as `undefined` at runtime. Upgrade all four together and rerun
the real-wallet Phase 0 checks.

The committed lockfile is part of that pin. The discovery package has caret
transitives and beta `types-js` dependencies, so regenerating the lock can
change the effective wallet-standard tree even when these four direct versions
do not move.

Use `WalletAccountV6` instance methods. The standalone `strk20*` functions
are not exported from the package root.

`@avnu/avnu-sdk` is pinned exactly at `4.2.0`. Its manifest requires Node 22;
the repository now requires Node 22.12 or newer and Node 20 is not a target.

---

## Testing

**`FakePrivacyOperations` is the point of the interface.** A deterministic,
in-memory implementation with fault injection — no network, no wallet, no
chain, no 6 STRK per action. Import it from any lane:

```ts
import { FakePrivacyOperations } from '@strkworld/privacy'

const ops = new FakePrivacyOperations({
  balances: { [STRK]: 100n * 10n ** 18n },
  registered: [bob],
})

ops.injectFault({ kind: 'not-registered', on: 'prepare' })
ops.advanceBlocks(10)        // mature pending notes
ops.setPoolFee(20n * 10n**18n) // governance moved the fee mid-flight
```

It models the sharp edges rather than the happy path, because the happy path is
not what breaks: notes are unspendable until they mature, operation amounts are
charged in their own tokens while the complete private fee (pool plus relay) is
charged in the live fee token, a shield is never batched with what it funds,
and deposits are always to self. Prepared batches are single-attempt: after any
confirmation attempt the caller must prepare again, which prevents a
double-click from submitting the same financial intent twice.

The offline adapter tests now cover ShieldUp-derived action construction,
fee-ceiling rechecks, recipient preflight, proof submission and private AVNU
swap shape. The remaining parity work is the funded Ready/paymaster run on the
D-028 pre-launch checklist; no fixture claims it happened.

Never put real key material or a real RPC key in a fixture.
