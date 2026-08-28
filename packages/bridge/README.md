# @strkworld/bridge

**One path in. Deposit from another chain, then explicitly shield when the
public-cost route is available.**

```
any asset, any chain  →  STRK on Starknet  →  STRK20 privacy pool
```

That is the whole building. No direction toggle, no destination token picker,
no route options. The intended flow has one direction, but every step fails
closed: recovery remains usable even when a safe new deposit or shield cannot
be offered.

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
- **The intended terminal state is shielded.** The player's intent is "put
  money in this world", and in this world money lives in the pool. If exact
  public-cost planning is unavailable, the handoff stays locked rather than
  guessing a reserve or claiming completion.

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
reserve from a verified live fee estimate, not a constant, and shield the
remainder. A
player who shields everything is stranded one transaction short of doing
anything at all, and it reads as the app having taken their money. `shieldup`
shipped this as a known open UX defect — do not inherit it.

The happy consequence: this building is the *only* place a player needs public
STRK, and it is also the place that produces it. Every private-side action
afterwards pays its own fee from shielded notes.

The current production Ready route does not prove the pool-fee allowance that
this estimate must cover. No production planner is exported, so real new quote
instructions and the Bridge-to-Bank handoff remain locked. The checked-in fake
exists only for deterministic offline demo and tests.

---

## What this owns

- The NEAR Intents 1Click integration — quote, deposit submission, execution
  status polling
- A live source-asset registry, with curated fallback IDs and per-chain address
  validation. Symbols, names, prices and route availability are never trusted
  from the old ShieldUp list alone
- The resumable pipeline: a bridge takes minutes and must survive a page
  reload, a tab close and a crash
- The signed, browser-local Bridge record used as progress and dispute evidence

## Implemented recovery boundary

`BridgeService` now owns the manual inbound quote and resume state machine. It
constructs only exact-input quotes whose destination is Starknet STRK,
validates the refund and recipient shapes, verifies the 1Click signature, and
persists the complete signed response as dispute evidence. `refresh()` maps
solver states into the small `BridgeStatus` vocabulary without leaking raw
provider states into the shell.

The production browser now lazily constructs one `BridgeService` over the
shipped 1Click client and `LocalBridgeStore`, so the signed record survives a
reload or a new runtime instance. Construction performs no provider request or
storage read. Reopening exposes a concise resume action that refreshes provider
status before presenting the next safe step. Merely opening the recovery-only
panel reads local evidence and does not fetch new-deposit source metadata; only
the player's explicit refresh contacts 1Click. This is recovery of saved
evidence, not permission to issue a new quote: the production planner remains
null, and real new quotes and deposit instructions remain gated on the reviewed
planner described by D-043.

The live registry loader currently maps every non-Starknet blockchain label
returned by 1Click into a source-chain family, while deliberately excluding
same-chain Starknet assets from the Bridge picker. Address checks are only a
fast shape guard; the signed quote endpoint remains authoritative. Executable
quote amounts, output minimum, time estimate, deadline and exact request
binding are all rechecked before a deposit address is retained.

`OneClickClient` and `BridgeStore` are ports. Production uses the shipped SDK
and browser storage; tests use deterministic in-memory implementations. The
remaining funded acceptance test is an issued deposit address that is actually
funded and reaches `SUCCESS`. No test fixture pretends that has happened.

Network responses remain untrusted even though the SDK supplies TypeScript
types. A settlement requires a validated positive uint256 `amountOut`; any
transaction hash surfaced to the shell is bounded and whitespace-free. The SDK
permits a successful response without a destination hash, so the actual amount,
not an invented hash requirement, decides settlement. Malformed status leaves
the prior record intact and produces one generic local error.

`watch()` polls manual deposits on a bounded clock. After ten active minutes it
persists a resumable "still pending" state instead of calling that timeout a
failure; terminal solver states stop immediately. An unfunded quote becomes
`expired` only after checking 1Click still reports `PENDING_DEPOSIT`.

Signed quote evidence is retained until the player explicitly discards it; it
is not silently deleted after an arbitrary local TTL. `exportResumeRecord()`
and `importResumeRecord()` provide an explicit cross-device path. The exported
record contains addresses and timing and must be labelled sensitive; imports
revalidate the route and quote signature and reset display state until the
provider is checked again. An import cannot replace an existing valid record:
the player must explicitly discard the retained evidence first. A provider
refresh or wallet-deposit report that was already in flight likewise persists
its status only while the complete retained record still matches the version
captured before the provider call. It cannot revive discarded evidence,
overwrite a replacement record or regress newer progress for the same signed
evidence. The verified provider status is still returned to the caller when
persistence ownership has moved on.

Resume imports are capped at 256 kB before JSON parsing. This is both a browser
resource bound and a reminder that import is signed evidence recovery, not an
arbitrary document upload.

The package retains a post-v1 wallet-signed-origin API using the same signed
quote and resume record, but v1 Shell does not expose it.
`createSignedDeposit()` prepares that route; the origin-wallet adapter signs
and broadcasts the chain-specific transfer, then
`reportDepositTransaction()` submits its hash to 1Click and verifies the
returned quote binding. Chain-wallet UI remains a shell concern, not a generic
private-key surface in this package.

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
and must find their deposit still in progress.

Browser-local persistence covers reloads, tab closes and crashes on the same
device. Cross-device resume is explicit export/import, not background sync.
The backend must not quietly acquire a durable database of deposit addresses,
recipients and timing.

The signed recipient is always the active connected Starknet account. It is
not editable. Recovery inspection, refresh, import and export work while
disconnected or while planning is unavailable, but a new quote or
post-settlement shield continuation requires the same account after
field-element-normalized comparison. The Bridge record remains authoritative
until explicit discard; the separate shield receipt belongs to the Bank, and
the app stores no Bridge-to-shield correlation. Switching accounts blocks new
funding and shielding but preserves the old recipient-bound record for status
refresh and export; it never retargets or silently deletes that evidence.

Persist the complete signed 1Click quote, not only the display fields. The
current SDK marks the response signature, timestamp, original request and
quote as dispute evidence that must be retained. The deposit address and memo
remain the status lookup key, but they are not the whole receipt.

---

## Reuse from shieldup

Mostly a port. `apps/shield20-app/src/bridge/`:

| Module | Take it? |
|---|---|
| `one-click.ts` (521) | **Yes**, minus the OUT paths — typed wrapper over `OneClickService` |
| `persistence.ts` (140) | **Adapt** — preserve resume behaviour, but retain the complete signed quote and version the record |
| `source-tokens.ts` (328) | **Adapt** — keep verified fallback IDs and validators; merge live registry metadata because the old labels already drifted |
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

V1 deliberately uses the SDK directly without authentication. Official 1Click
authentication and fee docs say this route pays a 0.2% platform fee; the room
must disclose it. There is no JWT proxy, and a JWT must never be bundled in
this package or any browser configuration. A live dry quote currently echoes
an `appFees` entry even when the request omits one; do not call that a
STRKWORLD fee or invent a total fee breakdown until the provider clarifies its
meaning. The signed expected and minimum outputs remain the exact review data.

Post-settlement shielding uses a separate optional Chain-owned public planning
capability, not an import from this package and not a `PrivacyOperations`
method. A future production implementation must estimate the precise public
approve-plus-privacy call shape against fresh wallet/account state; it cannot
guarantee the eventual fee. Shell
requires the capability before quoting, preflights the signed minimum before
showing deposit instructions, replans from actual received STRK, and revalidates
at the Bank commit point. The ordinary Bank fee ceiling still applies. A failed
or inconsistent plan blocks the relevant step; nothing auto-submits.

The current Shell composition uses this contract only with the deterministic
offline planner. In production, a missing planner locks new quote creation and
deposit instructions, but an existing signed record can still be inspected,
refreshed, exported or explicitly replaced. The package never performs the
shield and stores no Bridge-to-shield correlation.

---

## An alternative worth tracking

StarkWare's own [privacy-bridge](https://github.com/starkware-libs/privacy-bridge)
moves USDC between EVM chains and the pool over Circle's CCTP, binding the
cross-chain message and the private note in a **single transaction** — no
public intermediate landing.

That is strictly better than what this building can do, and it would collapse
the two-transaction truth above into one private step. It is `0.1.x` and
USDC-only today. Read it before v2; do not pin it yet.
