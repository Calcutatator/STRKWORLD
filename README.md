# STRKWORLD

**A 2D top-down city where the buildings are Starknet privacy protocols.**

Walk around a shared pseudonymous world, step into a building, and use a real
privacy-preserving protocol with real funds on Starknet mainnet. One balance,
one world, several protocols — with the rule that a financial building cannot
open unless it has an approved private execution path.

Built on [STRK20](https://strk20-by-example.org), Starknet's confidential
token standard.

---

## Status

Pre-build. The world and the financial layer are specified but not yet
implemented. See [`docs/SPEC.md`](docs/SPEC.md) for the full technical
specification and [`docs/DECISIONS.md`](docs/DECISIONS.md) for why things are
the way they are.

| Building | Protocol | v1 | Cairo needed |
|---|---|---|---|
| The Bank | STRK20 pool — shield, unshield, private transfer | ✅ | No |
| The Exchange | AVNU private swaps | ✅ | No |
| The Post Office | Private address-to-address transfer | ✅ | No |
| The Bridge | Deposit from any chain → STRK → the pool. Arrival is **public** | ✅ | No |
| The Vault | Vesu lending | After v1 | Yes |

---

## How it works

The game never touches private key material, never runs a prover, and never
holds a viewing key. Each building turns a player choice into a narrow typed
intent and passes it through the privacy-route gate.

```
Building UI → typed intent → approved route
                              ├─ Wallet API pool action
                              ├─ AVNU first-party private executor
                              └─ audited app-specific anonymizer
```

The wallet still owns keys, note discovery and proving. STRKWORLD owns the
allowlists, limits and honest product boundary: no raw calldata and no public
fallback. A missing or disabled route means a locked building. Anonymizers
hide the player's address from a protocol action; app activity, timing and
open-note amounts may remain public.

---

## Repository layout

Each package has a single job and a documented boundary. Read the package
README before changing anything inside it.

```
apps/
  web/          The application shell. Composes everything. Owns routing,
                layout, and the event bus.

  backend/      Planned paymaster/RPC proxy and bounded submission queue.
                No per-request financial or network-identity logs.

packages/
  privacy/      The STRK20 seam. Owns the PrivacyOperations interface and
                its wallet-backed implementation.

  bridge/       One-way cross-chain funding via NEAR Intents. Public rails —
                shielding is a separate step.

  world/        The game. Phaser scenes, movement, collision, tilemaps,
                sprites. Knows nothing about wallets or money.

  lobby/        Multiplayer presence. Colyseus server broadcasting ephemeral
                positions. Structurally incapable of seeing an address.

  shared/       Types and constants crossing package boundaries. No logic.

docs/
  SPEC.md       The technical specification. Start here.
  ARCHITECTURE.md  Boundaries, data flow, and what must never cross them.
  WORKPLAN.md   Division of labour, sequencing and lane briefs.
  DECISIONS.md  Decision log with reasoning.
  research/     Primary-source audits backing the spec.
```

---

## Getting started

Requires Node 22.12+ and npm 10+.

```bash
npm install
cp .env.example .env.local     # then fill in your own RPC key

# Terminal 1 — privacy-minimal multiplayer presence
npm run dev --workspace=@strkworld/lobby

# Terminal 2 — game at http://localhost:5173/
npm run dev
```

### Environment

The web workspace is configured to load the repository-root `.env.local`.
That file is gitignored; `.env.example` is the committed template and contains
no secrets. Any browser-exposed `VITE_` RPC key is compiled into the public
bundle and must be domain allowlisted; privacy-sensitive reads go through the
backend proxy.

Server-side credentials are runtime environment variables for the backend;
Vite does not load or expose them. Export/inject them into that process using
the deployment mechanism described in `docs/OPS.md`, and never commit them.
If `VITE_LOBBY_URL` is absent or invalid, the game deliberately starts in
explicit solo mode rather than guessing an endpoint.

```
VITE_STARKNET_CHAIN_ID=SN_MAIN
VITE_LOBBY_URL=ws://localhost:2567
```

---

## Wallet requirement

STRKWORLD needs a wallet implementing the STRK20 Wallet API (`>= 0.10.3`).
Today that means a browser extension. The code is written against the wallet
standard interface rather than any specific wallet, so email/social login
works the moment a web wallet ships the methods — with no code change here.
In the production composition, connecting a Starknet mainnet wallet and
passing its STRK20 capability check is the app entry gate: before admission the
World, lobby and building panels are not mounted. Local demo/test compositions
remain explicit non-production seams.

See **Forward compatibility** in [`docs/SPEC.md`](docs/SPEC.md) for the rules
that keep that true, and the CI test that enforces them.

---

## Contributing

Read [`AGENTS.md`](AGENTS.md) first — it carries the project invariants, the
verified traps that have already cost time, and the findings log. It applies
to human and agent contributors equally.

The short version:

1. Work inside one package. Cross-boundary changes need a decision entry.
2. Never put an address, balance, transaction hash or building name into
   lobby traffic.
3. Never enable a financial building without its approved private route; there
   is no public fallback.
4. Verify claims against installed packages, not documentation.
5. Add what you learn to the findings log.

---

## Licence

TBD.
