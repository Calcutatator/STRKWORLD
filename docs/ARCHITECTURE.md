# Architecture

How STRKWORLD is put together, and what must never cross a boundary.

---

## The shape

Three concerns that barely talk to each other, composed by a thin shell.

```
┌──────────────────────────────────────────────────────────┐
│  apps/web — the shell                                     │
│  routing · layout · event bus · providers       │
└───────┬──────────────────┬───────────────────┬───────────┘
        │                  │                   │
┌───────▼────────┐ ┌───────▼────────┐ ┌────────▼────────┐
│ packages/      │ │ packages/      │ │ packages/       │
│ privacy        │ │ world          │ │ lobby           │
│                │ │                │ │                 │
│ Starknet.      │ │ Phaser.        │ │ Colyseus.       │
│ Money.         │ │ Movement.      │ │ Positions.      │
│ Wallet.        │ │ Tilemaps.      │ │ Ephemeral IDs.  │
│                │ │                │ │                 │
│ Knows nothing  │ │ Knows nothing  │ │ Knows nothing   │
│ about the game │ │ about money    │ │ about anything  │
└────────┬───────┘ └────────────────┘ └─────────────────┘
         │
    ┌────▼─────┐
    │  Wallet  │  holds viewing key · discovers notes
    │          │  generates proof · submits to Starknet
    └──────────┘
```

The wallet is outside our trust boundary in the useful sense: we never hold
key material, so we cannot lose it.

---

## Data flow

### Reading a balance

```
React (useStrk20Balances)
  → walletV6.strk20Balances([])
  → wallet resolves from its own note discovery
  → React state
  → event emitter → Phaser HUD
```

Phaser never calls Starknet. It receives values it can render.

### Performing a shielded action

```
Player enters building
  → Phaser emits `building:entered`
  → React opens the building panel
  → player composes intent (accumulated, not submitted)
  → player leaves / confirms
  → batch accumulator produces one STRK20_ACTION[]
  → submission queue applies randomised delay      ← privacy control
  → walletV6.strk20InvokeTransaction(actions)
  → wallet prompts, proves, submits
  → receipt → React state → HUD
```

The submission queue is not an optimisation. Entering a building is a
publicly observable event; the resulting pool interaction is publicly
observable on-chain. Linking them in time is a deanonymisation oracle, and
the delay is what breaks the link.

### Multiplayer presence

```
Phaser position tick
  → throttled → lobby client
  → Colyseus room broadcasts { gameId, x, y, sprite }
  → other clients → Phaser
```

`gameId` is ephemeral and per-session. It is generated client-side, never
derived from an address, and is discarded on disconnect.

---

## Boundaries

### `packages/privacy`

The only package that imports `starknet`. Exposes one interface so the rest
of the app never depends on how privacy is achieved:

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

`WalletApiPrivacyOperations` is the implementation. The interface exists so a
second implementation can be added later without touching callers — and so
the whole financial layer can be driven by a mock in tests.

**Must not:** import from `world` or `lobby`, contain UI, or branch on wallet
identity.

### `packages/world`

Phaser scenes, tilemaps, collision, sprites, camera, input. Emits semantic
events (`building:entered`, `player:moved`) and consumes plain data.

**Must not:** import `starknet` or any wallet package. If Phaser code needs
to know a balance, it is being asked to do the wrong job.

Tilemaps: **embed tilesets on export.** Phaser rejects external `.tsx` — see
the findings log.

### `packages/lobby`

Colyseus room broadcasting positions. This package is where a privacy failure
would be quietest, so it is deliberately the dumbest thing in the repo.

**Must not:** receive, store, log or broadcast an address, balance,
transaction hash, building name, or any financial action. It may know a
player is at a coordinate. It may not know who they are.

Server state schema is the enforcement point — if a field cannot be added to
the schema, it cannot leak.

### `packages/shared`

Types and constants used across boundaries. No logic, no dependencies.

### `apps/web`

Providers, routing, layout, and the bridge. Owns the batch accumulator and
the submission queue, because both sit between the game and the money and
belong to neither.

---

## The event bus (React ↔ Phaser)

One-directional by design.

- React owns wallet connection, balances, pending operations, and all
  financial state.
- Phaser owns scenes, movement and rendering.
- React pushes into Phaser via an event emitter.
- Phaser emits semantic events back; it never reads React state and never
  calls Starknet.

This means the game can run with no wallet connected — which is exactly what
Phase 1 builds, and what makes the world independently testable.

---

## Forward compatibility

The privacy layer targets `WalletWithStarknetFeatures`, not a wallet. Web
wallets register on the same feature surface as extensions, so email/social
login lights up with no code change here when a vendor ships the methods.

Five rules keep that true — they are in [`SPEC.md`](SPEC.md) §5, and a CI
test enforces them. The load-bearing one: discover wallets dynamically via
`get-starknet-discovery`, never from the static `get-starknet-wallets` list.
