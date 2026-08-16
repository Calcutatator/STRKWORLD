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

```ts
interface PrivacyOperations {
  balances(tokens?: string[]): Promise<PrivateBalance[]>
  shield(token: string, amount: bigint): Promise<TxResult>
  unshield(token: string, amount: bigint): Promise<TxResult>
  recipientStatus(address: string): Promise<RecipientStatus>
  transfer(token: string, amount: bigint, recipient: string): Promise<TxResult>
  privateSwap(input: PrivateSwapInput): Promise<TxResult>
}
```

`WalletApiPrivacyOperations` is the implementation. The interface exists so
that:

1. the whole financial layer can be driven by a mock in tests,
2. a second implementation can be added without touching callers,
3. the forward-compatibility test can prove a non-extension wallet works.

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

**Batching is the only lever against prompts and fees.** The `actions` array
executes atomically, so several operations share one prompt, one proof and
one fee. The batch accumulator lives in `apps/web` because it sits between
game and money; this package just executes what it is handed.

---

## Version pins that matter

`starknet` must be pinned to **10.7.0**. npm `latest` is 10.0.2 and contains
none of the STRK20 surface — every symbol is `undefined` at runtime with no
useful error.

Use `WalletAccountV6` instance methods. The standalone `strk20*` functions
are not exported from the package root.

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
not what breaks: notes are unspendable until they mature, the fee comes out of
the balance being spent, a shield is never batched with what it funds, and
deposits are always to self.

Parity tests against `shieldup`'s known-good mainnet behaviour come next —
there is a working implementation to diff against, so parity beats exploration.

Never put real key material or a real RPC key in a fixture.
