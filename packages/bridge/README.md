# @strkworld/bridge

**Cross-chain value in and out, via NEAR Intents. Public by nature.**

The Bridge building is how players get value into STRKWORLD from another chain
and back out again. It does **not** touch the STRK20 pool — that is the Bank's
job, and it happens afterwards.

---

## The honesty rule

**Bridging is not a privacy feature.** It is a funding feature.

A bridge-in lands a public ERC-20 on Starknet with a visible amount and a
visible recipient. The privacy step is shielding at the Bank, as a separate,
later transaction. Bundling them would publish exactly the link the pool exists
to break — see `docs/DECISIONS.md` D-004 and the composition-leak note in the
STRK20 concepts reference.

The building's copy must say this plainly. A player who bridges in and assumes
they are now private has been misled by us, and the fix is wording, not
cryptography.

---

## What this owns

- The NEAR Intents 1Click integration — quotes, deposit submission, execution
  status polling
- Source and destination token registries, and address validation per chain
- The resumable multi-leg pipeline: a bridge takes minutes and must survive a
  page reload, a tab close and a crash
- Receipts

## What this must never do

- Import from `@strkworld/privacy`, `world` or `lobby`
- Imply that bridging provides privacy
- Hold key material for any chain

---

## Direction matters

The two directions are genuinely different flows, not mirror images.

**IN** — origin is an asset on some other chain, destination is STRK on
Starknet. Reaching the player's actually-chosen Starknet token then needs an
AVNU swap leg downstream. Some chains support a wallet-signed deposit; others
are **MANUAL mode**, where the player goes off to an exchange withdrawal screen
and we poll for arrival. Manual mode is the common case for a player funding
from a centralised exchange, so it is not an edge case — design for it first.

**OUT** — origin is a Starknet registry asset, destination is any registry
asset. The deposit is a plain Starknet ERC-20 transfer to a quoted address and
the solver delivers directly. No AVNU leg.

---

## Reuse from shieldup

This lane is mostly a port, not an invention. `apps/shield20-app/src/bridge/`
has ~1,200 lines of proven orchestration worth carrying across:

| Module | Take it? |
|---|---|
| `one-click.ts` (521) | **Yes** — typed wrapper over `OneClickService`, with the string-union enums replaced by typed constants |
| `execute.ts` (1,181) | **Adapt** — the leg orchestration is sound; strip the shieldup-specific UI coupling |
| `persistence.ts` (140) | **Yes** — resumable pipeline state. This is the piece that makes a multi-minute flow survivable |
| `source-tokens.ts` (328) | **Yes** — registry and deposit-mode mapping |
| `address-validation.ts` (88) | **Yes** — per-chain, cheap, and catches a class of unrecoverable mistakes |
| `receipts.ts`, `balances.ts`, `submit-state.ts` | **Yes** — small and self-contained |
| `BridgeModal.tsx` (1,956) | **No** — rewrite. It is a wallet modal; ours is a room in a building |

Port behaviour, not the lockfile — shieldup's dependency tree carries 36
transitive advisories.

---

## Tuning, inherited and worth keeping

These came from production and are not arbitrary:

- Default slippage **100 bps**
- Quote deadline **30 minutes** — long enough for a player to walk to an
  exchange withdrawal screen, short enough that the price does not drift
- Status polling **every 3s** for signed deposits; slower for manual mode
- Give up spinning after **10 minutes** and switch to a "still pending" state
  the player can leave and come back to

---

## Dependency note

`@defuse-protocol/one-click-sdk-typescript` — pin explicitly. shieldup ran
`^0.1.17`; latest is `0.1.25`. It is a 0.x package, so treat minor bumps as
breaking and re-verify the quote and status shapes when moving.

The EVM side pulls `viem`. Lazy-load the whole building so that chunk only
reaches players who actually open the Bridge.

---

## An alternative worth tracking

StarkWare's own [privacy-bridge](https://github.com/starkware-libs/privacy-bridge)
moves USDC between EVM chains and the pool over Circle's CCTP, with its own
inbound and outbound anonymizer contracts, binding the cross-chain message and
the private note in a single transaction. That is strictly better privacy than
bridge-then-shield, because there is no public intermediate leg.

It is early (`0.1.x`, GitHub Packages) and USDC-only. Read it before v2 — if it
matures, the Bridge building gains a genuinely private route and the honesty
rule above softens for that path. Do not pin it as a dependency yet.
