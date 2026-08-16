# CLAUDE.md

**→ Read [`AGENTS.md`](AGENTS.md) first.** It is the project contract and the
shared findings log, and it applies to every contributor. This file exists so
Claude Code loads the essentials automatically; `AGENTS.md` is canonical.

## The five invariants

Breaking one of these is a defect even if everything appears to work.

1. **No privacy infrastructure in this repo.** No prover, no discovery
   service, no viewing keys. The wallet does all of it.
2. **The lobby never sees money.** No address, balance, transaction hash or
   building name in lobby traffic or state. Ephemeral game IDs only.
3. **Submission is decoupled from avatar action.** Never causally link
   entering a building to broadcasting a transaction.
4. **Never branch on wallet identity** in the privacy path.
5. **Never set `COOP: same-origin` / `COEP: require-corp`.** They break web
   wallets, and we do not need them.

## Before you claim something is true

Install the package and read the types. Read contract state over RPC. This
project has been repeatedly misled by confident documentation — a method in a
doc page is not a method in a shipped package, and a config variable is not a
service.

Canonical STRK20 docs: `https://strk20-by-example.org/llms-full.txt`

## Where things live

| Need | Go to |
|---|---|
| What we are building and why | [`docs/SPEC.md`](docs/SPEC.md) |
| Boundaries and data flow | [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) |
| Why a decision was made | [`docs/DECISIONS.md`](docs/DECISIONS.md) |
| Primary-source evidence | [`docs/research/`](docs/research/) |
| Traps that already cost time | Findings log in [`AGENTS.md`](AGENTS.md) |

## When you finish

Append what you learned to the findings log in `AGENTS.md`, with how you
verified it. A finding without a verification method is a rumour.
