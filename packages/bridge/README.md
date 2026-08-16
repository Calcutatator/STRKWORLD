# @strkworld/bridge

**One path in. Deposit from another chain and end up shielded.**

```
any asset, any chain  →  STRK on Starknet  →  STRK20 privacy pool
```

That is the whole building. No direction toggle, no destination token picker,
no route options. The player clicks **Deposit**, and there is exactly one
outcome.

---

## Why it is this narrow

Every option removed here is a decision the player does not have to make and a
failure mode we do not have to handle.

- **No OUT direction.** Exiting is the Bank's job (`unshield`), and mixing
  "get money in" with "get money out" in one building doubles its surface for
  no gain.
- **Destination is always STRK.** NEAR Intents 1Click delivers STRK on Starknet
  natively, so fixing the output **removes the AVNU swap leg entirely** — no
  second slippage, no second quote, no second thing that can fail halfway.
- **Always ends shielded.** The player's intent is "put money in this world",
  and in this world money lives in the pool.

`shieldup`'s bridge was bidirectional with an arbitrary destination token and
an AVNU leg downstream. Roughly half of that complexity does not come across.

---

## The two-transaction truth

**"Directly into the pool" is one intent and two transactions.** Say so in the
copy; do not imply atomicity.

`STRK20_DEPOSIT_ACTION` has no recipient field — pool deposits are always to
self and must be signed by the account making them. The bridge therefore cannot
shield on the player's behalf. The sequence is:

1. **Solver delivers STRK to the player's Starknet address.** Public. The
   amount and the recipient are visible on-chain.
2. **The player signs a shield.** Also a public leg — every pool deposit names
   its depositor.

So an observer sees "this address received STRK from a bridge, then put it in
the pool". That linkage is unavoidable and delay does not meaningfully hide it,
because the deposit leg is public either way.

**What privacy actually begins here:** everything the player does *after* the
funds are in the pool. Their transfers, swaps and balances are private. Their
arrival is not.

The building's copy must land that distinction. A player who deposits and
believes they have become invisible has been misled by us.

### Leave a gas reserve

Step 2 costs gas, and that gas must be **public** STRK — a pool deposit cannot
be paid for out of the pool balance it is about to create (D-013).

So the deposit flow must never shield the full delivered amount. Size the
reserve from a live fee estimate, not a constant, and shield the remainder. A
player who shields everything is stranded one transaction short of doing
anything at all, and it reads as the app having taken their money. `shieldup`
shipped this as a known open UX defect — do not inherit it.

The happy consequence: this building is the *only* place a player needs public
STRK, and it is also the place that produces it. Every private-side action
afterwards pays its own fee from shielded notes.

---

## What this owns

- The NEAR Intents 1Click integration — quote, deposit submission, execution
  status polling
- The source-asset registry and per-chain address validation
- The resumable pipeline: a bridge takes minutes and must survive a page
  reload, a tab close and a crash
- Receipts

## What this must never do

- Import `@strkworld/privacy` — CI enforces this. The shell sequences the two
  steps; this package does not reach into the pool
- Offer an OUT direction, a destination token choice, or a route picker
- Imply that arriving is private

---

## Manual mode is the common case

Some chains support a wallet-signed deposit. Many do not, and the player goes
off to a centralised exchange withdrawal screen while we poll for arrival.

**That is the normal path for someone funding from an exchange, so build for it
first.** It shapes the whole room: the player leaves, comes back minutes later,
possibly on a different device, and must find their deposit still in progress.

---

## Reuse from shieldup

Mostly a port. `apps/shield20-app/src/bridge/`:

| Module | Take it? |
|---|---|
| `one-click.ts` (521) | **Yes**, minus the OUT paths — typed wrapper over `OneClickService` |
| `persistence.ts` (140) | **Yes** — resumable pipeline state. The piece that makes a multi-minute flow survivable |
| `source-tokens.ts` (328) | **Yes**, simplified — only source assets matter now; the destination is fixed |
| `address-validation.ts` (88) | **Yes** — cheap, and catches a class of unrecoverable mistakes |
| `receipts.ts`, `balances.ts`, `submit-state.ts` | **Yes** — small and self-contained |
| `execute.ts` (1,181) | **Adapt, roughly half** — the OUT orchestration and the AVNU leg both go |
| `BridgeModal.tsx` (1,956) | **No** — rewrite. It is a wallet modal; ours is a room |

Port behaviour, not the lockfile — shieldup's tree carries 36 transitive
advisories.

---

## Tuning, inherited from production

- Default slippage **100 bps**
- Quote deadline **30 minutes** — long enough for a player to reach an exchange
  withdrawal screen, short enough that the price does not drift
- Status polling **every 3s** for signed deposits, slower for manual mode
- Stop spinning after **10 minutes** and switch to a "still pending" state the
  player can leave and return to

---

## Dependency note

`@defuse-protocol/one-click-sdk-typescript` — pin exactly. shieldup ran
`^0.1.17`; current is `0.1.25`. It is a 0.x package, so treat minor bumps as
breaking and re-verify quote and status shapes when moving.

The EVM side pulls `viem`. Lazy-load the building so that chunk only reaches
players who open it.

---

## An alternative worth tracking

StarkWare's own [privacy-bridge](https://github.com/starkware-libs/privacy-bridge)
moves USDC between EVM chains and the pool over Circle's CCTP, binding the
cross-chain message and the private note in a **single transaction** — no
public intermediate landing.

That is strictly better than what this building can do, and it would collapse
the two-transaction truth above into one private step. It is `0.1.x` and
USDC-only today. Read it before v2; do not pin it yet.
