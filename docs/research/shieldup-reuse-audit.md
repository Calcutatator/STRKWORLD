# ShieldUp reuse audit for Privacy City

**Audited:** 2026-08-16  
**Repository:** [`Calcutatator/shieldup`](https://github.com/Calcutatator/shieldup)  
**Pinned commit:** [`290f8306571ce45e630c5a08b243d7b5f8c232b4`](https://github.com/Calcutatator/shieldup/tree/290f8306571ce45e630c5a08b243d7b5f8c232b4) (2026-07-10)

## Corrected verdict

ShieldUp materially increases the feasible Privacy City scope. **The Bank, the Exchange, and the private-send part of the Post Office are existing integrations to migrate and re-present, not greenfield protocol work.** Vesu remains the only new privacy-protocol integration among the proposed buildings. The genuinely new product work is the Phaser world, shared lobby, building-overlay shell, PWA packaging, and the bilateral trading/consent experience.

The architectural migration is narrower than the earlier feasibility review assumed:

- keep ShieldUp's action semantics, recipient checks, AVNU route logic, fee/slippage protections, error handling, and transaction UX;
- replace ShieldUp's custom viewing-key, low-level privacy SDK, proof-aware signer, self-hosted prover, and indexer with a small Wallet API adapter;
- build the city around those already-proven financial operations.

Mainnet-first is consistent with the existing evidence. ShieldUp was deliberately mainnet-only and has recorded successful mainnet transactions. The repo demonstrates a **gated mainnet product**, however, rather than evidence of an open-public, high-concurrency deployment.

## Evidence levels

| Capability | Verdict | Evidence strength |
|---|---|---|
| Mainnet application | Deployed behind a password gate | The production `/api/health` returned `200 {"ok":true}` during this audit; `/` returned the repository's expected `401` test gate. The [README identifies the live domain and mainnet-only posture](https://github.com/Calcutatator/shieldup/blob/290f8306571ce45e630c5a08b243d7b5f8c232b4/README.md#L1-L20). |
| Bank: shield/unshield | Implemented; repo records successful mainnet round trip | Deposit and withdraw are complete code paths. The [incident record says shield was restored and reverified after Starknet 0.14.3](https://github.com/Calcutatator/shieldup/blob/290f8306571ce45e630c5a08b243d7b5f8c232b4/docs/HANDOFF-2026-07-prover-0143-upgrade.md#L154-L174), but it does not publish the transaction hash. |
| Exchange: public AVNU swap | Implemented and independently transaction-verifiable | The repo records the first successful mainnet `deploy_and_invoke` swap and its [transaction hash](https://github.com/Calcutatator/shieldup/blob/290f8306571ce45e630c5a08b243d7b5f8c232b4/apps/shield20-app/HANDOFF-privy-deploy.md#L1-L5). A mainnet receipt query during this audit returned `SUCCEEDED`, `ACCEPTED_ON_L1`, block `10,047,602`. |
| Exchange: private AVNU swap | Implemented and UI-wired | Code and logic tests prove assembly and routing. The repo calls it live/on-probation, but contains no equivalent pinned private-swap receipt. Treat this as deployed integration code, not independent evidence of repeated production use. |
| Post Office: private transfer | Implemented and UI-wired | Recipient registration preflight, proof construction, fee action, submission, and UI flow are present. No pinned end-to-end transfer receipt was found. |
| Bilateral player trade | Not implemented | There is no lobby identity, mutual-consent reveal, trade request, or atomic two-party exchange flow. |
| Extensionless onboarding | Implemented through Privy | It creates/reuses a user-owned Starknet wallet and signs client-side. This is not the STRK20 Wallet API route. |
| Passkeys | Not implemented | Current login methods are email and external wallet. The prior passkey-guardian design was explicitly abandoned. |
| Vesu | Not implemented | No Vesu/Nostra calls, contract addresses, or frontend integration exist under `apps/` or `packages/`. |
| Game/lobby/PWA | Not implemented | No Phaser, Colyseus/presence service, service worker, or PWA manifest exists. |

The live application server was reachable during the audit. `prover.shieldup.online` and `indexer.shieldup.online` both resolved correctly but timed out from the audit runner, including their `sslip.io` fallbacks. That may be transient or network-specific, but it means current prover availability was **not** independently confirmed. It does not negate the recorded mainnet runs; it does mean the report should not call the old self-hosted stack currently healthy without a fresh operator-side check.

## What already exists

### The Bank

ShieldUp contains a complete low-level STRK20 implementation:

- Mainnet pool address, six default shieldable tokens, production flag, and 10-block note maturity are [pinned in network configuration](https://github.com/Calcutatator/shieldup/blob/290f8306571ce45e630c5a08b243d7b5f8c232b4/packages/core/src/config.ts#L105-L123).
- Shielding performs token and fee approval, builds a deposit proof, submits it, waits for confirmation, and invalidates proof nonce state on failure ([`shield()`](https://github.com/Calcutatator/shieldup/blob/290f8306571ce45e630c5a08b243d7b5f8c232b4/apps/shield20-app/src/lib/shielded-ops.ts#L241-L299)).
- Unshielding appends AVNU's private fee action and submits the proof through private `apply_action` ([`unshield()`](https://github.com/Calcutatator/shieldup/blob/290f8306571ce45e630c5a08b243d7b5f8c232b4/apps/shield20-app/src/lib/shielded-ops.ts#L301-L359)).
- Shielded balances are discovered for every held token, normalized across felt padding, tallied, and split into mature/maturing amounts ([balance discovery](https://github.com/Calcutatator/shieldup/blob/290f8306571ce45e630c5a08b243d7b5f8c232b4/apps/shield20-app/src/lib/shielded-balances.ts#L54-L108)).
- Private receiving registration is a real operation rather than a placeholder ([registration flow](https://github.com/Calcutatator/shieldup/blob/290f8306571ce45e630c5a08b243d7b5f8c232b4/apps/shield20-app/src/lib/shielded-ops.ts#L362-L409)).

Under Wallet API this code becomes substantially smaller. Approval, discovery, proof generation, and submission move into the wallet. Preserve the product behavior and replace the mechanism behind an interface such as:

```ts
interface PrivacyOperations {
  balances(tokens?: string[]): Promise<PrivateBalance[]>;
  shield(token: string, amount: bigint): Promise<TxResult>;
  unshield(token: string, amount: bigint): Promise<TxResult>;
  recipientStatus(address: string): Promise<"registered" | "unregistered" | "unknown">;
  transfer(token: string, amount: bigint, recipient: string): Promise<TxResult>;
  privateSwap(input: PrivateSwapInput): Promise<TxResult>;
}
```

### The Post Office

The private payment component already exists. It:

- checks the recipient with `discoverRequirement`;
- blocks an unregistered receiver with actionable copy;
- selects shielded notes;
- creates a private transfer;
- appends the AVNU private fee;
- submits and confirms the transaction.

See [`transferShielded`](https://github.com/Calcutatator/shieldup/blob/290f8306571ce45e630c5a08b243d7b5f8c232b4/apps/shield20-app/src/lib/shielded-ops.ts#L411-L477) and the separate public [`get_public_key` preflight](https://github.com/Calcutatator/shieldup/blob/290f8306571ce45e630c5a08b243d7b5f8c232b4/apps/shield20-app/src/lib/recipient-setup.ts#L7-L46).

Privacy City can therefore ship the Post Office as private address-to-address transfer in v1. The proposed click-player/request-trade experience is additional product work: the lobby should use an ephemeral player ID and reveal wallet addresses only after bilateral consent. Sharing a public balance is presentation logic; atomic two-sided asset exchange is a separate contract/protocol feature and should not be conflated with the existing transfer.

### The Exchange

Both AVNU surfaces are present:

- Public swaps support fresh-account `deploy_and_invoke`, paymaster-paid execution in another token, and direct STRK-paid execution ([three execution branches](https://github.com/Calcutatator/shieldup/blob/290f8306571ce45e630c5a08b243d7b5f8c232b4/apps/shield20-app/src/lib/swap.ts#L172-L302)).
- Private quote/build requests force `private: true` and consume AVNU's returned executor rather than hard-coding it ([private REST adapter](https://github.com/Calcutatator/shieldup/blob/290f8306571ce45e630c5a08b243d7b5f8c232b4/apps/shield20-app/src/lib/avnu-private-swap.ts#L65-L140)).
- The private action is an atomic withdraw-to-executor, external invoke, and open output note, with the AVNU fee appended to the same action set ([`swapShielded`](https://github.com/Calcutatator/shieldup/blob/290f8306571ce45e630c5a08b243d7b5f8c232b4/apps/shield20-app/src/lib/shielded-ops.ts#L480-L580)).
- Quote freshness and slippage/minimum-received rules already exist and have tests ([30-second quote TTL](https://github.com/Calcutatator/shieldup/blob/290f8306571ce45e630c5a08b243d7b5f8c232b4/apps/shield20-app/src/lib/quote-ttl.ts#L16-L30), [slippage rules](https://github.com/Calcutatator/shieldup/blob/290f8306571ce45e630c5a08b243d7b5f8c232b4/apps/shield20-app/src/lib/slippage.ts#L15-L55)).

During this audit AVNU mainnet reported the paymaster available with 33 fee tokens. A live `paymaster_buildTransaction` for the mainnet privacy pool returned an `apply_action` and fee withdrawal without an API key. The returned fee was dynamic and sizeable, reinforcing ShieldUp's existing rule to validate token, recipient, and amount against caps before proving ([fee validation](https://github.com/Calcutatator/shieldup/blob/290f8306571ce45e630c5a08b243d7b5f8c232b4/apps/shield20-app/src/lib/private-paymaster.ts#L197-L245)).

For Privacy City, use the current AVNU package/API rather than carrying forward ShieldUp's older REST workaround. Preserve its executor-not-hardcoded rule, quote binding, slippage floor, fee-token checks, and failure copy.

## What the Wallet API replaces

ShieldUp's privacy path is genuinely self-hosted and substantial:

- it derives a viewing identity from a wallet signature and keeps it in the application ([identity derivation](https://github.com/Calcutatator/shieldup/blob/290f8306571ce45e630c5a08b243d7b5f8c232b4/apps/shield20-app/src/lib/identity.ts#L21-L118));
- it has a custom proof-aware Starknet signer because `proofFacts` must be committed into the transaction hash ([signer adapter](https://github.com/Calcutatator/shieldup/blob/290f8306571ce45e630c5a08b243d7b5f8c232b4/apps/shield20-app/src/lib/sdk.ts#L40-L94));
- it directly constructs `IndexerDiscoveryProvider`, `ProvingServiceProofProvider`, and `createPrivateTransfers` ([provider wiring](https://github.com/Calcutatator/shieldup/blob/290f8306571ce45e630c5a08b243d7b5f8c232b4/apps/shield20-app/src/lib/sdk.ts#L186-L238));
- it operates k3s, Pathfinder, prover, indexer, TLS, screening, concurrency, and retry infrastructure ([deployment configuration](https://github.com/Calcutatator/shieldup/blob/290f8306571ce45e630c5a08b243d7b5f8c232b4/deploy/privacy-starknet/values.shield20.yaml#L19-L108)).

Do not port those pieces into the Wallet API implementation. The wallet should own privacy identity, note discovery, proof generation, and submission. This removes the most operationally expensive part of ShieldUp while retaining the user-facing integrations.

The self-hosted implementation is still valuable as a reference oracle for action order, error conditions, note maturity, recipient registration, private swap construction, and mainnet behavior.

## Wallet and passkey boundary

ShieldUp proves that extensionless onboarding is possible, but through a different architecture. Current ShieldUp:

- authenticates with Privy email or an external EVM/Solana wallet;
- creates or reuses a user-owned Starknet wallet client-side;
- signs raw Starknet hashes through the active Privy browser session ([Privy wallet creation](https://github.com/Calcutatator/shieldup/blob/290f8306571ce45e630c5a08b243d7b5f8c232b4/apps/shield20-app/src/lib/privy-context.tsx#L49-L123));
- does not call `wallet_strk20*` and does not configure a passkey login path ([current login configuration](https://github.com/Calcutatator/shieldup/blob/290f8306571ce45e630c5a08b243d7b5f8c232b4/apps/shield20-app/src/App.tsx#L87-L115)).

Therefore:

- ShieldUp is strong evidence for no-extension, client-side signing UX.
- It is not evidence that a passkey wallet currently exposes the STRK20 Wallet API.
- If Privacy City insists on Wallet API for every privacy operation, its passkey connector still needs a compatible wallet implementation.
- Retaining ShieldUp's Privy/self-hosted path solely for passkey-like onboarding would create two privacy architectures and preserve the prover/indexer burden. That is possible, but it is a deliberate expansion rather than a free reuse.

This is the one major unresolved product integration. It should not force Bank, Exchange, or Post Office out of scope.

## Security and operational patterns worth retaining

- Runtime pool-fee reads; never hard-code the displayed fee.
- BigInt throughout and felt-padding-tolerant address comparisons.
- Recipient registration preflight before a private transfer.
- Quote TTL, bounded slippage, minimum-received display, and no hard-coded executor.
- AVNU fee token/amount/recipient validation before proving or signing.
- Bounded proof retry and honest failure states. Wallet API changes ownership of retry, but the UX state model remains useful.
- Enforcing CSP, no third-party runtime scripts, no telemetry, and explicit off-chain metadata disclosure ([CSP and headers](https://github.com/Calcutatator/shieldup/blob/290f8306571ce45e630c5a08b243d7b5f8c232b4/apps/shield20-app/server.ts#L103-L186), [privacy dataflow](https://github.com/Calcutatator/shieldup/blob/290f8306571ce45e630c5a08b243d7b5f8c232b4/docs/PRIVACY.md#L22-L64)).
- A building/action allow-list and kill switches in the city adapter. Financial state should remain in React/domain services, never Phaser or lobby state.

## Local verification at the pinned commit

- `npm ci`: passed from the committed lockfile.
- Strict application and API typecheck: passed.
- Logic suite: **213/213 passed**, covering private paymaster invariants, private-swap action assembly, recipient registration, quote TTL, slippage, gas policy, felt normalization, and note maturity.
- Production build: passed; Vite transformed 8,161 modules and warned about JavaScript chunks over 500 KB.
- GitHub CI for this exact commit: [passed](https://github.com/Calcutatator/shieldup/actions/runs/29104839839).
- Current `npm audit --omit=dev`: **36 advisories** — 1 critical, 6 high, 28 moderate, 1 low. The critical finding is `decompress` through `starknet-devnet`; high findings include current advisories in Axios, `form-data`, `socket.io-parser`, and `ws` paths.

The dependency result does not undermine the integration evidence, but Privacy City should **reuse code and behavioral invariants, not ShieldUp's lockfile**. ShieldUp uses AVNU 4.0.1, a commit-pinned Starknet 9.4 privacy fork, and a vendored privacy SDK 0.14.2 release candidate ([dependency manifest](https://github.com/Calcutatator/shieldup/blob/290f8306571ce45e630c5a08b243d7b5f8c232b4/apps/shield20-app/package.json#L15-L33)). Start Privacy City on the verified fresh Wallet API dependency set.

## Revised Privacy City scope implication

The corrected implementation sequence is:

1. Create a fresh `PrivacyOperations` Wallet API adapter and prove the exact mainnet Bank, transfer, and AVNU action batches against the selected wallet(s).
2. Port ShieldUp's Bank, Exchange, and Post Office behavior and protections behind that adapter.
3. Build the Phaser city, React building overlays, manifest-driven building registry, and pseudonymous presence lobby.
4. Add bilateral player consent/address reveal if desired; treat atomic trading as its own feature.
5. Add Vesu after its anonymizer deployment and production assumptions are verified.

This supports **mainnet-first and all non-Vesu buildings**. The scope is a wallet-layer migration plus a new game-world presentation, not a from-zero set of privacy integrations.
