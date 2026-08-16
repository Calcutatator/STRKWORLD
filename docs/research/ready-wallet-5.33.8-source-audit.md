# Ready Wallet 5.33.8 — shipped-extension audit

**Date:** 2026-08-16
**Scope:** Phase 0 evidence that can be established without opening a wallet or
moving funds. This does not replace the funded mainnet UI run.

## Artifact

- Chrome Web Store extension:
  [`dlcobpjiigpikoobohmabehhmhfoodbb`](https://chromewebstore.google.com/detail/ready-wallet-formerly-arg/dlcobpjiigpikoobohmabehhmhfoodbb)
- Downloaded through Google's public CRX update endpoint.
- Manifest name: Ready X
- Manifest version: `5.33.8`
- CRX SHA-256:
  `2f6014522d1a6d6881bcbb0cdd427d11aa497c6684c35dc3e21947b91bd23fb6`

The package was unpacked into a temporary directory and inspected read-only.
No extension was installed, no wallet was opened, no account or key was
created, and no transaction was built or submitted.

## What the shipped wallet does

| Wallet API operation | Shipped behavior | Phase 0 implication |
|---|---|---|
| `wallet_strk20Balances` | Provisions the wallet's local privacy material, checks pool registration, then creates a `STRK20_BALANCES` approval action. The English screen says “Share private balances” and explains that the dapp wants to view the selected private balances. | A balance read prompts. Do not poll it for a HUD and never use it for capability detection. |
| `wallet_strk20PrepareInvoke` | Validates the full action array, checks registration, then creates one `STRK20_PREPARE` action. The screen title is “Prove transaction”. Approval runs either the simulation or proof-producing path. | Preparing a proof is itself a deliberate wallet confirmation, not a silent preview. |
| `wallet_strk20InvokeTransaction` | Validates the full array, groups deposit amounts by token, prepends one ERC-20 `approve` call per deposited token, appends the pool `privacy_intent` call, and creates one `TRANSACTION` wallet action containing the resulting calls. | Current Ready does not implement deposit as two separate wallet actions. The live UI run must still confirm what the player actually sees. |
| Registration precondition | All three dapp-facing handlers call `isRegistered` and return `NOT_REGISTERED` when false. None calls the wallet's separate registration operation. | Current Ready does not auto-register through these first-use dapp calls. STRKWORLD needs explicit registration onboarding or a supported-wallet handoff. |

## Invoke boundary

The wallet's request validator accepts an `invoke.contract` that is any valid
Starknet address felt. It then enforces structural constraints: at most one
invoke, the invoke must be last, and it cannot be the only action. Open-note
placeholders must correspond exactly to open-note transfers in the same batch.

That proves the extension does not carry a client-side contract-address
allowlist in its Wallet API request schema. It does **not** prove arbitrary
targets will execute. The shipped paymaster path exposes an explicit
`TX_PAYMASTER_INVOKE_NOT_ALLOWED` failure, so an effective allowlist may be
enforced by the remote paymaster. A funded mainnet attempt against a harmless
test helper is still required before admitting the Vault route.

Prepared-proof submission has a separate hard boundary: the final call must
target the active privacy pool's `apply_actions` entrypoint, and proof data and
proof facts must be present. This supports the backend queue design, but the
backend must independently validate the decoded route rather than trusting a
client-provided proof wrapper.

## Prepared-proof calldata boundary

The prepared proof output is `[class_hash, ...serialized_server_actions]`.
Ready 5.33.8 submits those actions as the exact prefix of the pool call, then
appends the independently serialized `Option<ScreeningAttestation>` required by
the current `apply_actions` ABI. A relay must compare the proof output with the
action prefix and strictly parse the suffix; comparing it with all calldata
would reject a valid current artifact.

The current canonical Cairo source and pool ABI both expose twelve
`ServerAction` variants: `EmitEncNoteCreated` is tag 8, `EmitNoteUsed` tag 9,
`Invoke` tag 10, and `InvokeWithComputation` tag 11. This was checked against
the shipped bundle, canonical source and current class ABI without generating a
proof or submitting a transaction.

## Phase 0 answer matrix

| Question | Current answer | Evidence strength |
|---|---|---|
| Does `strk20Balances` prompt? | Yes, Ready creates an explicit balance-sharing approval screen. | Shipped UI and background implementation; live click-through still pending. |
| Does a three-action array create one or three wallet actions? | One action object for the whole array. | Shipped implementation; live visible prompt count still pending. |
| Does first use auto-register? | Not through the three dapp methods; they reject with `NOT_REGISTERED`. | Shipped implementation. |
| Is deposit always two prompts? | No such guarantee. Ready currently places approval call(s) and the privacy call in one transaction action. | Shipped implementation; live visible prompt count still pending. |
| Are arbitrary invoke targets accepted end to end? | Schema accepts them; the remote paymaster may reject them. | Incomplete until harmless mainnet execution. |
| What is end-to-end latency? | Unknown. | Requires the funded mainnet UI run. |
| What is the pool fee? | 6 STRK at the separately verified live read on 2026-08-16. | Live mainnet RPC read; governance-settable. |

## Remaining manual run

Use the installed Ready extension with an already-created, tiny-funded mainnet
account. Record screen capture and timestamps for:

1. capability query, then a deliberate one-token balance read;
2. a three-private-action prepare, reject before proving if cost is unexpected;
3. a tiny shield, recording the exact approval/review sequence;
4. a harmless reviewed helper invocation to determine the paymaster target
   boundary; and
5. registration behavior from an account that has never enabled private
   tokens.

Never submit a transaction until the exact token, amount, public disclosure,
fee ceiling and target have been shown to and confirmed by the user.
