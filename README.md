# STRKWORLD

**A 2D top-down city where the buildings are Starknet privacy protocols.**

Walk around a shared pseudonymous world, step into a building, and use a real
privacy-preserving protocol with real funds on Starknet mainnet. One balance,
one world, several protocols — with the rule that the player's privacy is
preserved throughout.

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
| The Vault | Vesu lending | After v1 | Yes |

---

## How it works

The game never touches private key material, never runs a prover, and never
holds a viewing key. It asks the player's wallet to perform a private action,
and the wallet handles keys, note discovery, proof generation and submission.

```
Player  →  STRKWORLD  →  wallet_strk20InvokeTransaction  →  Wallet
                                                              ├─ holds viewing key
                                                              ├─ discovers notes
                                                              ├─ generates proof
                                                              └─ submits to Starknet
```

That is the whole privacy integration: three RPC methods on the connected
wallet. Everything else is a game.

---

## Repository layout

Each package has a single job and a documented boundary. Read the package
README before changing anything inside it.

```
apps/
  web/          The application shell. Composes everything. Owns routing,
                layout, and the React ↔ Phaser bridge.

packages/
  privacy/      The financial seam. Owns the PrivacyOperations interface and
                its wallet-backed implementation. The only package that talks
                to Starknet.

  world/        The game. Phaser scenes, movement, collision, tilemaps,
                sprites. Knows nothing about wallets or money.

  lobby/        Multiplayer presence. Colyseus server broadcasting ephemeral
                positions. Structurally incapable of seeing an address.

  shared/       Types and constants crossing package boundaries. No logic.

docs/
  SPEC.md       The technical specification. Start here.
  ARCHITECTURE.md  Boundaries, data flow, and what must never cross them.
  DECISIONS.md  Decision log with reasoning.
  research/     Primary-source audits backing the spec.
```

---

## Getting started

Requires Node 20+ and npm 10+.

```bash
npm install
cp .env.example .env.local     # then fill in your own RPC key
npm run dev
```

### Environment

Create a free key at [alchemy.com](https://www.alchemy.com) and put it in
`.env.local`. **Never commit it.** `.env.local` is gitignored; `.env.example`
is the committed template and contains no secrets.

```
VITE_STARKNET_RPC_URL=https://starknet-mainnet.g.alchemy.com/v2/<YOUR_KEY>
VITE_STARKNET_CHAIN_ID=SN_MAIN
```

---

## Wallet requirement

STRKWORLD needs a wallet implementing the STRK20 Wallet API (`>= 0.10.3`).
Today that means a browser extension. The code is written against the wallet
standard interface rather than any specific wallet, so email/social login
works the moment a web wallet ships the methods — with no code change here.

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
3. Verify claims against installed packages, not documentation.
4. Add what you learn to the findings log.

---

## Licence

TBD.
