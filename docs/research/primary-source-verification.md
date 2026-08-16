# Privacy City scope verification

Primary-source review of the 16 August 2026 feasibility draft. Verification date: **16 August 2026**. Revised after the Shieldup production codebase was supplied: the mainnet-first requirement is now treated as fixed, and Bank + Exchange + private send are retained in v1.

This is an evidence report, not an edit to the supplied scope. Labels mean:

- **Confirmed** — directly supported by current official documentation, source, published packages, or an on-chain read.
- **Contradicted** — a material statement in the draft is false or too broad.
- **Conditional** — feasible only behind an explicit dependency, product decision, or launch gate.
- **Unknown** — no current primary source establishes the claim; test or obtain a vendor commitment.

## Bottom line

**Feasible, mainnet-first:** after reviewing [Shieldup at commit `290f830`](https://github.com/Calcutatator/shieldup/tree/290f8306571ce45e630c5a08b243d7b5f8c232b4), Privacy City is not a greenfield financial application. Shieldup already implements and documents mainnet shield/unshield, shielded transfer, AVNU private swap and private `apply_action` sponsorship, recipient-registration checks, note maturity, transaction progress, recovery, screening, RPC failover, and production operations. The credible v1 therefore includes **The Bank, The Exchange, and private send/Post Office**, alongside the game world. Vesu remains the genuinely new protocol integration.

The main engineering job is now **migration and composition**: replace Shieldup's low-level privacy SDK/self-hosted prover boundary with Wallet API calls, retain its proven business rules and AVNU submission controls, and wrap the financial surfaces in a Phaser city. Six to eight weeks is plausible for a mainnet v1 containing Bank + Exchange + private send if the Wallet API compatibility seam passes in the first week and art remains deliberately small.

**Fixed product constraint:** mainnet first. A Sepolia phase is not required. Use very small operator-funded mainnet smoke transactions, feature flags, sponsor-budget/rate controls and rollback switches during the migration, but do not remove Bank, Exchange or private transfer from the planned v1 merely because they involve real funds. “Uncapped user funds” should be distinguished from “uncapped project-paid gas”: sponsor spend still needs operational limits.

## What Shieldup changes

The following were treated as unproven in the first pass but are already present in the prior product:

| Capability | Shieldup evidence | Privacy City treatment |
|---|---|---|
| Mainnet shield/unshield | Live mainnet flow and deployment/runbook documentation; low-level SDK builds proofs and handles approval/fee mechanics | Reuse UI, amount, fee, maturity, error and transaction-state logic; replace proof builder/submission boundary with Wallet API |
| Private transfer | `transferShielded` plus both SDK `discoverRequirement` and public pool `get_public_key` recipient checks | Ship in v1 as Post Office/Bank send; re-express as a Wallet API `transfer` action |
| AVNU private swap | Private quote/build, dynamic executor, open output note, slippage and quote controls | Ship Exchange in v1; replace bespoke REST/prover bridge with AVNU SDK 4.2 wallet prover where possible |
| Private paymaster | Validates AVNU fee token, fee amount, recipient, value caps and submits `apply_action` call/proof | Reuse this security logic. The only new proof is that `strk20PrepareInvoke` output is byte/schema-compatible with the already-live submission path |
| Extensionless onboarding | Privy email/EVM/Solana login creates a user-owned Starknet wallet and signs client-side | Proven zero-install path, but it uses the low-level SDK rather than Wallet API and is not evidence of passkey Wallet API support |
| Prover/indexer operations | Self-hosted Pathfinder, prover, discovery, retry and fail-closed screening runbooks | Retire from Privacy City's primary Wallet API path; keep only as migration knowledge or an explicit fallback, not as required new infrastructure |
| Production UX | Note maturity, progress tracker, quote TTL, fee ceilings, address normalization, history/recovery, CSP and privacy-safe logging rules | Port these modules instead of redesigning them |

Current code verification at commit `290f830`:

- `npm ci`, strict TypeScript checks and the production Vite build passed.
- The complete logic suite passed **213/213** checks.
- `npm audit --omit=dev` reported **36 transitive advisories** (1 critical, 6 high, 28 moderate, 1 low), mainly through the old Privy/WalletConnect surface; the vendored SDK also declares `starknet-devnet` as a production dependency even though it is test tooling. Do not copy Shieldup's lockfile wholesale; port the required source modules into the clean Wallet API dependency tree and triage any retained advisory for actual runtime reachability.
- The live web origin responded from Railway with the expected CSP/security headers, behind its configured HTTP 401 test gate. The old self-hosted prover/indexer endpoints did not respond from this review environment; that does not block the Wallet API migration, but it means their current availability was not independently re-confirmed.

## Highest-impact corrections

| Draft claim | Status | Verification and correction |
|---|---|---|
| “The game runs no privacy infrastructure.” | **Conditional** | The game can avoid operating it only when a compatible wallet supplies the SDK and reaches working discovery and proving services. The official architecture includes wallet, SDK, discovery, proving, pool, and anonymizers. The app still depends operationally on these services and needs availability, latency, version-compatibility, and incident plans. See the [Starknet Privacy architecture and compatibility matrix](https://github.com/starkware-libs/starknet-privacy/tree/66e3caae8c0201227a6719696d004e30d90aea65). |
| “The entire privacy surface is three RPC methods.” | **Conditional** | Correct for the three transaction/balance methods in stable Wallet API 0.10.3, but not the whole product surface: wallet discovery, connection, permissioned balance sharing, registration UX, status/receipt handling, paymaster submission, and service failure states are also required. `starknet@10.7.0` additionally contains an experimental shadow-account method; it is not in the stable 0.10.3 types surface. |
| `strk20Balances`, `strk20PrepareInvoke`, and `strk20InvokeTransaction` are standalone top-level `starknet` exports | **Contradicted** | A strict TypeScript probe failed on those imports. In `starknet@10.7.0` they are instance methods on `WalletAccountV6` and functions under the `walletV6` namespace. `WalletWithStarknetFeatures` must be imported from `@starknet-io/get-starknet-wallet-standard/features`, not from `starknet`. The draft's sample will not compile as written. |
| Four stable action variants and errors 118/119/120/162/163 | **Confirmed** | Exact package inspection of `@starknet-io/types-js@0.10.3` confirms deposit, withdraw, transfer, invoke and those error codes. The Wallet V6 wrappers are in [starknet.js `connectV6.ts` at commit `1e756007...`](https://github.com/starknet-io/starknet.js/blob/1e75600792e97f92e7f270aef0b53fc6572e09ee/src/wallet/connectV6.ts). |
| `shadow_account_invoke` should not be a v1 dependency | **Confirmed** | It appears in `@starknet-io/types-js@0.10.4-beta.2`, is absent again in `0.11.0-beta.1`, and is not part of stable 0.10.3. Treat it as unstable until an official stable Wallet API release and supported wallet exist. |
| Passkeys can cover new users while extensions cover existing users | **Contradicted today** | Starknet supports account abstraction, but passkeys/sessions are account-wallet features, not universal dapp features. Cartridge Controller supports passkeys and sessions, yet its current provider reports no Wallet API versions and does not implement `wallet_strk20*`. See [Starknet accounts](https://docs.starknet.io/learn/protocol/accounts), [Cartridge architecture](https://docs.cartridge.gg/controller/architecture), [Cartridge sessions](https://docs.cartridge.gg/controller/sessions), and [Controller provider source at v0.14.0](https://github.com/cartridge-gg/controller/blob/v0.14.0/packages/controller/src/provider.ts). Use Ready/Xverse for the private path; use Cartridge only for public game actions unless its STRK20 support changes. |
| Targeting Wallet Standard means a future web wallet needs no rewrite | **Conditional** | The interface boundary is sound, but registering a Wallet Standard object proves transport compatibility, not STRK20 capability. Keep the generic boundary, but require `wallet_supportedWalletApi >= 0.10.3` and a live method probe before advertising support. |
| Ready Web Wallet solves extension-free onboarding | **Unknown / not currently verified** | Ready documents an extensionless email/password web wallet, not passkeys, and its public setup uses StarknetKit. The inspected `starknetkit@3.4.3` pins `types-js@0.8.4` and exposes no STRK20 methods. See [Ready Web Wallet](https://docs.ready.co/ready-wallets/web-wallet) and its [setup guide](https://docs.ready.co/web-wallet-sdk/set-up-guide). Obtain a written compatibility statement and run a live probe. |
| Generic STRK20 sponsorship needs no separate library because Start React has paymaster hooks | **Partly correct mechanism, wrong reason** | Start React's generic paymaster hooks are not the private mechanism. However, Shieldup already builds an AVNU `apply_action`, appends and validates the private fee withdrawal, and submits the proof-bearing pool call for unshield/send/swap. Reuse that path or AVNU SDK 4.2's equivalent. The remaining Wallet API spike is output compatibility for `strk20PrepareInvoke`, not invention of Bank sponsorship. See [Shieldup private-paymaster implementation](https://github.com/Calcutatator/shieldup/blob/290f8306571ce45e630c5a08b243d7b5f8c232b4/apps/shield20-app/src/lib/private-paymaster.ts) and [AVNU execute-private-transaction](https://docs.avnu.fi/api/paymaster/execute-private-transaction). |
| “Anonymity, not confidentiality” and “your balance is hidden is not defensible” | **Contradicted** | STRK20 encrypted notes do provide confidentiality for shielded token/amount data, and AVNU explicitly describes shielded balances and swap amounts as non-public. The accurate qualification is that confidentiality is selective: public deposit/withdraw legs, some anonymizer effects, open notes, approved wallet/dapp balance sharing, the auditor, endpoints, and timing can reveal data or correlations. See the [pool cryptographic fields](https://github.com/starkware-libs/starknet-privacy/tree/66e3caae8c0201227a6719696d004e30d90aea65/packages/privacy#cryptographic-primitives) and [AVNU privacy description](https://docs.avnu.fi/updates/privacy). |
| Session keys are unavailable for STRK20 calls | **Confirmed, with nuance** | The pool’s client compilation path requires zero caller and transaction version 3, so SNIP-9 `execute_from_outside` cannot simply replace the Wallet API flow. See [`assert_valid_os_call`](https://github.com/starkware-libs/starknet-privacy/blob/66e3caae8c0201227a6719696d004e30d90aea65/packages/privacy/src/utils.cairo). Sessions remain useful for public game calls when the chosen account supports them. SNIP-9 and SNIP-29 are still Review proposals: [SNIP-9](https://github.com/starknet-io/SNIPs/blob/main/SNIPS/snip-9.md), [SNIP-29](https://github.com/starknet-io/SNIPs/blob/main/SNIPS/snip-29.md). |
| “Official Phaser + Colyseus + React template exists.” | **Contradicted as phrased** | Phaser maintains an official Phaser 4 + React template, and Colyseus maintains a Phaser tutorial, but no single official combined Phaser + React + Colyseus template was found. The stack remains straightforward. See [Phaser React template](https://github.com/phaserjs/template-react), [Colyseus Phaser tutorial](https://github.com/colyseus/tutorial-phaser), and [Phaser 4.2.1 archive](https://phaser.io/download/archive). |

## Package and SDK verification

### Confirmed package state

Registry/package inspection produced this reproducible set:

| Package | Verified version/status | Result |
|---|---:|---|
| `starknet` | `10.7.0` on npm `next`; npm `latest` is `10.0.2` | Pin `10.7.0` exactly or use an audited lockfile. A bare install still misses the current STRK20 surface. |
| `@starknet-io/types-js` | `0.10.3` stable | Correct stable Wallet API type target. Do not mix beta shadow types into v1. |
| `@starknetfoundation/starknet-start-react` | `2.0.1` | Peers with React 19 and `starknet >=10.4`; the three STRK20 hooks exist. |
| `@avnu/avnu-sdk` | `4.2.0` stable | Private-swap functions and STRK20 wallet prover exist; private product surface is still documented as Preview. |
| `phaser` | `4.2.1` stable | Correct current game-engine version. |
| `colyseus.js` | `0.16.22`, legacy client line | Do not start a new build on this package. For a minimal presence server, the clean tested set was `@colyseus/core@0.17.50`, `@colyseus/ws-transport@0.17.13`, and `@colyseus/sdk@0.17.43`; or use an even smaller WebSocket service if rooms/reconnection/schema state are unnecessary. Keep chain/wallet data out of room state. |
| `starkzap` | `3.0.0` | Correctly excluded from the STRK20 path: no `strk20` surface, `starknet ^9.2.1`, old AVNU range. It is a general Starknet SDK, not the Post Office protocol. |
| `starknetkit` | `3.4.3` | Correctly excluded from the STRK20 path: old `types-js@0.8.4`, no STRK20 methods. |

Pin the discovery stack by exact major as well: `@starknet-io/get-starknet-core` and `@starknet-io/get-starknet-modal` `6.0.1`, plus `@starknet-io/get-starknet-wallet-standard` and `@starknet-io/get-starknet-discovery` `6.0.4`, formed a clean tested tree. Their npm `latest` tags can still resolve to older major lines, so do not rely on an unqualified install.

**Confirmed install checks:** an exact six-package probe of the versions named in the draft resolved 132 production packages and reported zero known vulnerabilities. A second probe adding the explicitly pinned discovery packages resolved a larger clean tree. Installing `starknetkit@3.4.3` into the Starknet `10.7.0` tree failed with `ERESOLVE` because StarknetKit peers on `starknet ^8`; its exclusion is therefore not merely stylistic.

**Confirmed security scan:** `npm audit --omit=dev` on the retained exact-version candidate tree reported **0 known vulnerabilities** on 16 August 2026. This is only a registry advisory scan, not a smart-contract or application security review.

The current `colyseus@0.17.10` meta-package pulled optional auth dependencies with one low and one moderate advisory (`elliptic` and `uuid`) in a fresh install. Because v1 only needs presence, the narrower current stack—`@colyseus/core@0.17.50`, `@colyseus/ws-transport@0.17.13`, and `@colyseus/sdk@0.17.43`—installed 27 packages and audited clean. Do not enable Colyseus auth/playground packages unless their functionality and advisory surface are actually needed.

**Contradicted dependency choice in the draft’s implied template:** Vite `6.3.5` produced one high-severity direct advisory bucket in a clean audit. Vite `8.2.1` produced zero. Start from a current Vite release rather than copying an older template lockfile.

### Compile-time API correction

The draft's interface-level import example is not valid in the verified package. This is the tested shape:

```ts
import { WalletAccountV6, walletV6, type STRK20_ACTION } from "starknet";
import type { WalletWithStarknetFeatures } from
  "@starknet-io/get-starknet-wallet-standard/features";

const balances = await walletV6.strk20Balances(wallet, []);
const prepared = await walletV6.strk20PrepareInvoke(wallet, actions, true);
const submitted = await walletV6.strk20InvokeTransaction(wallet, actions);
```

The corresponding `WalletAccountV6` instance methods also exist. Use one integration boundary consistently and put an exact compile probe in CI, because `starknet@10.7.0` internally consumes a beta types build while the proposed direct dependency is stable `types-js@0.10.3`.

### Cairo and starter-kit verification

- Installed the privacy repository's declared toolchain: Scarb `2.17.0` and Starknet Foundry `0.59.0`.
- `scarb fmt --check` passed at the inspected privacy-repository head.
- `snforge test -p vesu_lending_anonymizer` passed all **7 tests** with zero failures. These are mock-vault unit tests, not a mainnet fork, deployment verification, or independent audit.
- The official STRK20 starter kit passed `tsc --noEmit`, but its production dependency audit reported one high-severity `sharp` advisory. Treat it as reference code and update its dependency tree rather than copying its lockfile unchanged.

## STRK20 readiness and contract evidence

### Release state

**Conditional:** the current official repository head inspected was `66e3caae8c0201227a6719696d004e30d90aea65` (12 August 2026), with tag `PRIVACY-0.14.3-RC.5`. Its README compatibility matrix still specifies RC.2 prover/discovery/SDK components and RC.0 contract artifacts. That is a release-candidate stack, not evidence of a finished production support policy. Source: [starkware-libs/starknet-privacy](https://github.com/starkware-libs/starknet-privacy/tree/66e3caae8c0201227a6719696d004e30d90aea65).

The repository has a deployment milestone tag, [`CONTRACT_V2_DEPLOYED_MAINNET_2026-07-08`](https://github.com/starkware-libs/starknet-privacy/tree/CONTRACT_V2_DEPLOYED_MAINNET_2026-07-08), but the repository’s mainnet environment example still contains deployment/service placeholders. A tag proves a deployment event, not service uptime, adoption, TVL, or production SLA.

### Addresses and live reads

**Confirmed:** AVNU SDK `4.2.0` pins the STRK20 mainnet pool as:

```text
0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a
```

The same source pins Sepolia:

```text
0x0254a6b2997ef52e9f830ce1f543f6b29768295e8d17e2267d672c552cfe0d91
```

Source: [AVNU SDK `privacy.services.ts` at package git commit `fa89fbe...`](https://github.com/avnu-labs/avnu-sdk/blob/fa89fbe24433eecef62f6bf7e0a3c818e71ed928/src/privacy.services.ts) and [constants](https://github.com/avnu-labs/avnu-sdk/blob/fa89fbe24433eecef62f6bf7e0a3c818e71ed928/src/constants.ts).

**Confirmed live read:** a Starknet mainnet JSON-RPC `starknet_call` of `get_fee_amount()` at the above pool returned `0x53444835ec580000`, or `6_000_000_000_000_000_000` FRI: **6 STRK** at the verification time. The pool README confirms this is one fee per `apply_actions` call, not one fee per action. Source semantics: [Privacy Pool fees](https://github.com/starkware-libs/starknet-privacy/tree/66e3caae8c0201227a6719696d004e30d90aea65/packages/privacy#fees). Read it at runtime because governance can change it.

The same live read set returned pool version `2.0` and a proof-validity window of **450 blocks**. This places a hard bound on any server-side delay/retry queue; quote-bound AVNU actions should not be delayed after quote acceptance.

**Confirmed:** official repository class hashes are not deployment addresses:

- Privacy Pool class hash `0x52107fadffab71bdcbb6b2ccb68ba3e1b5558d94036538053e159d3076ad633`
- Ekubo anonymizer class hash `0x2a4ac595283d4d64b9952f5ef5c0da1775bfdb7c9d92237524a21dd8d19ebd7`
- Vesu anonymizer class hash `0x3751128dc3ebd36215f982766f14aaca8f78793e4b0f42a73e49372a8e24aae`

Do not paste these into frontend configuration as callable mainnet contracts. Source: [official contract matrix](https://github.com/starkware-libs/starknet-privacy/tree/66e3caae8c0201227a6719696d004e30d90aea65#contracts).

### Audit coverage

**Confirmed:** OpenZeppelin audited only `packages/privacy/src` at commit `c5e2fb5`, with a report dated 29 May 2026. The summary reports 0 critical, 0 high, 2 medium (both resolved), 5 low (1 resolved), and 4 notes (3 resolved). The report explicitly records centralized proving-service availability, an auditor key, and governance upgrades with no delay as trust assumptions. See the [official audit index](https://github.com/starkware-libs/starknet-privacy/tree/66e3caae8c0201227a6719696d004e30d90aea65/docs/audit) and [OpenZeppelin report](https://github.com/starkware-libs/starknet-privacy/blob/66e3caae8c0201227a6719696d004e30d90aea65/docs/audit/Privacy%20V1.pdf).

**Contradicted:** “no audit on the critical path until The Vault” is not a defensible production claim. The audit predates the current repository head/release-candidate tag and excludes the Wallet API, hosted prover, discovery service, paymaster, AVNU integration, Vesu helper, game relayer/backend, and the complete end-to-end composition. At minimum, production needs a delta review, integration threat model, relayer review, and incident/pausing runbook even if no new Cairo contract is deployed.

### Privacy semantics

**Confirmed:** encrypted notes provide confidentiality for shielded balances and transfer data, but the system is not “everything confidential.” Public deposit and withdrawal events expose their public leg; DeFi anonymizers can expose the action and amounts without linking them to a user; open notes are deliberately plaintext. A wallet may disclose explicitly approved balance data to a dapp, and the audit’s trust model includes an auditor able to decrypt viewing-key and withdrawal data. Official contract event, encryption, and action descriptions: [Privacy Pool README](https://github.com/starkware-libs/starknet-privacy/tree/66e3caae8c0201227a6719696d004e30d90aea65/packages/privacy).

**Confirmed:** the pool contract is pausable, upgradeable, charges a governance-set fee per `apply_actions`, and permits at most one external invoke in the final action phase. Batch only operations that fit the protocol’s ordered phases and single-external-call rule.

**Confirmed:** note maturity is a real asynchronous constraint. The official STRK20 build material states that newly created notes need ten blocks before reuse. Therefore “one in-game balance” must expose at least **public wallet**, **shielded spendable**, and **shielded maturing** state even if the visual HUD later rolls these into one presentation.

**Contradicted as a v1 privacy control:** a random-delay queue does not prove anonymity, gives the project another timing observer, and can cause proof or quote expiry. Remove it from the default v1 architecture. Prefer keeping building entry private to the local client, coarse presence states, no per-building presence broadcast, and the relayer/paymaster boundary that already separates the submitting account from the user. If delayed submission is later retained for Bank actions, bound it by the live proof-validity window and have a privacy engineer model and test it; never apply it to an accepted AVNU quote.

**Unknown:** actual pool anonymity set, active-note distribution, supported-token liquidity, exit correlation, wallet viewing-key policy, and auditor/governance operational policy. These must be answered before writing privacy claims. “Nobody can link this move to you” is too absolute without a defined threat model.

## Wallets, passkeys, prompts, and registration

### What works now

**Confirmed:** AVNU’s current privacy documentation says private swaps require Wallet API `>=0.10.3` and work today with current Ready and Xverse. It also says shielded balances are permissioned per token and the wallet asks to share them again after every swap because balances resynchronize. See [AVNU private swap](https://docs.avnu.fi/docs/privacy/private-swap) and [AVNU’s live privacy update](https://docs.avnu.fi/updates/privacy).

This has two direct UX consequences omitted or understated in the draft:

1. `strk20Balances` must not be assumed to be a silent HUD read; balance access is consented and may prompt.
2. “One prompt per shielded transaction” is not a safe promise. A private swap can include transaction confirmation plus a later balance-sharing prompt, and behavior differs by wallet.

**Confirmed:** no stable Wallet API registration method exists. In the wallet-managed route the game must detect error 118 and hand the user to the wallet’s registration UX. However, “the game cannot register a user” is true only for this route; the low-level privacy SDK can register, but adopting it means owning key/note/discovery/proving concerns and is a major architecture change.

**Contradicted:** the game is not blind to recipient registration. The deployed pool exposes `get_public_key(address)`; a zero result means no registered public key. Use this read-only preflight before enabling a transfer, while still handling transaction-time failure because state can change and wallet behavior is authoritative.

### Capability detection

**Conditional:** use Wallet Standard dynamic discovery and avoid wallet-name branches, but do not infer STRK20 support merely from the four base Starknet Wallet Standard features. The acceptance test should be:

1. wallet connects through Wallet Standard;
2. `wallet_supportedWalletApi` reports a compatible version (`>=0.10.3` for the current AVNU route);
3. a real non-destructive balance/simulation probe behaves as expected;
4. registration and permission states are handled;
5. the exact production wallet/network pair completes the end-to-end flow.

**Unknown:** whether `simulate: true` is guaranteed to be silent, and whether it is the correct universal capability probe. Do not make it the only gate; test Ready and Xverse directly. Error 162 remains the ultimate fallback.

### Passkey plan

Use an explicit auth/capability matrix:

| User route | Public game calls | STRK20 Bank/Exchange | v1 decision |
|---|---|---|---|
| Ready/Xverse with Wallet API `>=0.10.3` | Yes | Yes, subject to live tests | Supported privacy route |
| Cartridge Controller passkey/session | Yes, subject to policy | No current STRK20 support | Public game identity/actions only; do not present as the private wallet |
| Ready Web Wallet | Yes in documented flows | Unknown | Pilot only after live STRK20 probe/vendor confirmation |
| Low-level privacy SDK + embedded passkey account | Architecturally possible | Potentially | Out of v1; it transfers privacy infrastructure and key/recovery obligations to the project |

**Required product choice:** either defer passkeys for the financial path, accept a two-wallet/two-identity experience, or fund a separate embedded privacy-wallet workstream with wallet/vendor support. The current “single wallet, passkey for new users” promise is not implementable from the verified public surface.

## Sponsorship and paymasters

Split “gas sponsorship” into three different mechanisms:

| Flow | Authority | Who pays gas | What is verified |
|---|---|---|---|
| AVNU private swap `apply_action` | STRK20 proof | AVNU relayer | AVNU `sponsored_private`; user’s private balance pays a pool fee; API key required |
| Bank prepared invoke | STRK20 proof plus AVNU private `apply_action` | AVNU relayer / configured sponsor | Shieldup already ships this pattern for private unshield/send/swap using low-level SDK call/proof output; Privacy City must confirm Wallet API output parity for deposit/withdraw/transfer |
| Ordinary account call through SNIP-9/SNIP-29 | Account signature/session | Paymaster/sponsor | Only on compatible accounts; SNIPs remain Review; not a STRK20 replacement |

**Confirmed:** AVNU’s private execute endpoint requires `x-paymaster-api-key` for sponsored modes. It supports `apply_action` without a user account signature and `invoke_and_apply_action` when a signed public call is also wrapped. The pool fee reimburses the relayer. The endpoint documents failures for missing fee transfer, too-low pool fee, missing proof, blacklisted call, and gas limits. Source: [Execute Private Transaction](https://docs.avnu.fi/api/paymaster/execute-private-transaction).

**Required backend controls:** keep the API key server-side; authenticate/rate-limit requests; allowlist chain ID, pool, selectors, tokens, amounts, quote age and per-user/day sponsorship budget; re-simulate before submission; log non-sensitive operational data; build global and per-wallet kill switches; and never accept arbitrary calldata from the browser.

**Conditional, narrow seam:** AVNU private `apply_action` sponsorship for unshield and shielded send is already implemented in Shieldup. What remains unverified is whether the current Wallet API's `strk20PrepareInvoke` output can be passed through the same submission adapter unchanged and whether public deposit approval is wallet-orchestrated. Test the three Bank actions directly on mainnet with tiny amounts; do not redesign the sponsorship subsystem first.

## Buildings

### The Bank

**Confirmed:** deposit, withdraw, transfer, and balance are the right stable Wallet API building blocks. Deposit has no recipient, so a project cannot directly deposit public funds into another user’s shielded balance with the deposit action.

**Contradicted:** the draft goes too far when it infers “no gifting a newcomer their first token.” A project-controlled, registered STRK20 wallet with an existing shielded balance could in principle use the transfer action to send a private note to a recipient. Recipient registration/acceptance, abuse controls, pool fee, operational custody, accounting, and wallet behavior still need live verification, so this is not a trivial faucet.

**Confirmed existing product surface:** Shieldup already contains registration/setup, recipient preflight, per-token balances, note maturity, live pool fee, proof/payment progress, retries, shield/unshield/transfer error translation, address normalization and recovery guidance. Port those modules and replace the SDK calls inside `shielded-ops.ts`; do not re-scope Bank as a net-new vertical.

**Conditional:** transfer-to-unregistered error mapping still needs a Ready/Xverse integration test. Error 118 is defined for the caller/wallet, so do not assume it is the recipient error. The app can nevertheless preflight the recipient by calling the pool's public `get_public_key(address)` and checking for zero.

### The Exchange (AVNU)

**Confirmed:** AVNU SDK `4.2.0` includes `executePrivateSwap`, `createStrk20WalletProver`, `buildPrivateSwapFee`, and `submitPrivateSwap`; mainnet private swaps are live in Ready/Xverse. Official AVNU mainnet contracts include Exchange `0x04270219d365d6b017231b52e92b3fb5d7c8378b05e9abc97724537a80e93b0f` and Forwarder `0x0127021a1b5a52d3174c2ab077c2b043c80369250d29428cee956d76ee51584f`. See [AVNU contracts](https://docs.avnu.fi/resources/contracts).

**Confirmed existing product surface:** Shieldup already implements the private quote/build path, dynamic executor handling, open output note, slippage, fee-action validation and paymaster submission. Privacy City can ship Exchange in v1. Prefer AVNU SDK 4.2's supported Wallet API bridge over the bespoke historical REST wrapper, while retaining Shieldup's quote-expiry, fee-cap and error-state logic.

### The Vault (Vesu first; Nostra later)

**Confirmed:** the official Starknet Privacy repository now contains a Vesu lending anonymizer supporting underlying-to-vToken deposit and vToken-to-underlying redeem/withdraw. Vesu V2 represents lending positions as ERC-4626-style VTokens. Sources: [Vesu anonymizer](https://github.com/starkware-libs/starknet-privacy/tree/66e3caae8c0201227a6719696d004e30d90aea65/packages/vesu_lending_anonymizer), [Vesu developer docs](https://docs.vesu.xyz/developers), and [Vesu contract addresses](https://docs.vesu.xyz/developers/contract-addresses).

**Contradicted:** this is not merely “150–200 lines Cairo” on the back of a deployed production primitive. The repository publishes a class hash, not an authoritative mainnet anonymizer address, and the OpenZeppelin pool audit excludes it. Deploying or adapting it introduces protocol-version, token/vault allowlist, rounding, liquidity, share-price, upgrade, and audit obligations.

**Conditional:** scope v1 Vault only as **Vesu supply/redeem**, after exact VToken selection, mainnet deployment verification, adversarial tests, and independent review. Borrow/collateral/liquidation is a separate workstream.

**Conditional/unknown for Nostra:** Nostra documents tokenized lending positions and mainnet deployments, but no Nostra STRK20 anonymizer exists in the Starknet Privacy repository. A stateless non-collateral supply/redeem adapter may be possible; borrowing/collateral creates persistent account-linked position and health-factor concerns and likely needs a stable shadow/subaccount model. Sources: [Nostra introduction](https://docs.nostra.finance/lend-and-borrow/introduction), [tokenized positions](https://docs.nostra.finance/lend-and-borrow/tokenized-assets-and-debt/tokenized-asset-positions), and [mainnet contracts](https://docs.nostra.finance/lend-and-borrow/deployed-contracts/money-market-mainnet).

### The Post Office and player-to-player trading

**Confirmed:** the Post Office does not need Starkzap; STRK20 transfer is the protocol primitive. Treat Starkzap only as reference material for ordinary wallet/session UX.

**Confirmed for v1:** basic private send is already implemented in Shieldup and should ship as the Post Office or as a Bank function. Reuse its recipient setup checks and Wallet API `transfer`. Public avatar-to-address discovery, balance reveal, and bilateral trade are the separate roadmap feature: make every reveal opt-in and never broadcast wallet addresses through Colyseus room state.

**Still separate from send:** the requested “both sides share public balances” does not need a STRK20 disclosure primitive if both users knowingly reveal their public Starknet addresses; public balances can then be read from chain. What needs design is mutual consent, expiry, spam/scam controls and preventing the lobby server from publishing that linkage—not the transfer protocol itself.

## Browser, PWA, multiplayer, and headers

**Confirmed:** Phaser 4 + React + Vite can run the world in a normal browser; Colyseus can provide an authoritative presence server; and a manifest plus service worker can make the shell installable. See the [official Phaser React template](https://github.com/phaserjs/template-react), [Colyseus](https://github.com/colyseus/colyseus), and [web.dev PWA installation guidance](https://web.dev/learn/pwa/installation).

**Contradicted:** Phaser's Tiled JSON parser does not support external tilesets referenced through Tiled's `source` property (`.tsx` files). Export maps with embedded tileset definitions or add a deterministic build-time flattener. “External tilesets from day one” will otherwise fail at load time.

**Conditional:** keep wallet/financial state in React/application services and game state in Phaser; communicate through a typed event boundary. Treat Colyseus client state as public to lobby participants. Use short-lived random lobby IDs with no deterministic derivation from wallet/account identifiers.

**Contradicted:** “never set cross-origin isolation headers because they break cross-origin iframes” is too broad. `COEP: require-corp` can block embedded cross-origin resources that do not opt in, and `COOP: same-origin` can sever popup opener references. The exact effect depends on both documents and the wallet transport. The correct rule is to **test the selected wallets under the exact deployed headers** and avoid cross-origin isolation unless a measured requirement justifies it. The standards provide `same-origin-allow-popups` for trusted popup integrations; iframe behavior also depends on CSP `frame-src`, `frame-ancestors`, cookies, and vendor allowlists. See the [HTML Standard COOP section](https://html.spec.whatwg.org/dev/browsers.html#cross-origin-opener-policies) and [MDN COOP reference](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Opener-Policy).

**Confirmed:** `restrict-properties` is not a current valid COOP token in the HTML Living Standard. Do not design around it.

**Unknown:** installed-PWA popup behavior for Ready and Xverse on every supported desktop/mobile platform. Run an actual installation matrix; do not rely on a generic statement that every `window.open()` stays inside the PWA.

**Required PWA behavior:** cache only immutable game assets and the application shell. Never cache RPC, wallet, quote, paymaster, proof, discovery, account, or balance responses. Add an update-required gate so a stale service worker cannot keep a deprecated financial client live.

## Threat model gaps the build plan must add

For an application handling uncapped real funds, these are launch requirements, not polish:

- strict CSP and third-party script minimization; no ad/analytics SDK in financial rooms;
- supply-chain pinning, lockfile review, provenance/SBOM, Dependabot/Renovate and recurring audits;
- wallet-origin and chain-ID validation; address checksum/normalization and allowlisted token contracts;
- transaction intent screen independent from pixel-art context, showing asset, exact amount, recipient/contract, pool fee, slippage, network, and privacy disclosure;
- backend authentication, abuse throttles, budget limits, idempotency keys and replay protection;
- quote freshness, simulation, min-received, decimal correctness and fee ceilings;
- reorg/reverted/pending/stuck transaction state machine rather than optimistic success;
- privacy-safe observability: avoid addresses, notes, proofs, balances and calldata in logs/errors/analytics;
- wallet/prover/discovery/paymaster status monitoring and degraded-mode UI;
- contract pause/upgrade and frontend kill switches;
- independent smart-contract/integration review, incident-response owner, responsible-disclosure policy and recovery drills;
- legal/compliance review before operating a public front end to a shielded pool;
- terms and prominent threat-model copy that distinguishes confidentiality, unlinkability, public entry/exit, timing leakage, auditor access and governance risk.

**Immediate security action:** the Cairo Coder API key included in the original prompt is now exposed in conversation material. It was not used in this review. Revoke/rotate it, remove it from future prompts and files, and use a server-side secret manager. Do not rely on deleting chat history as revocation.

## Revised delivery scope

### Week 1 — mainnet Wallet API migration spike

- Create a `PrivacyClient` boundary around Shieldup's existing product operations: balances, deposit, withdraw, private transfer, prepare/submit and private swap.
- Implement `WalletApiPrivacyClient` with exact `starknet@10.7.0` pins and Ready/Xverse capability detection.
- Execute tiny mainnet transactions for registration, balance permission, deposit, withdraw, transfer and three-action batching.
- Pass Wallet API `strk20PrepareInvoke` call/proof output through Shieldup's existing AVNU `apply_action` validator/submission flow.
- Determine deposit approval and prompt count; verify recipient `get_public_key` preflight and actual wallet error mapping.
- Keep a temporary `ShieldupSdkPrivacyClient` adapter only if it is useful for parity tests or extensionless migration; it is not the target architecture.

This is the only hard go/no-go. If it succeeds, the existing financial scope remains in v1. If it fails, fix or escalate this seam rather than cutting Exchange and Post Office pre-emptively.

### Weeks 1–3 — world foundation in parallel

- Phaser/React boundary, one street, three functional buildings and one disabled Vault facade.
- Tiled tilesets embedded in exported JSON or flattened deterministically at build time.
- Colyseus presence with randomized ephemeral game IDs and no wallet linkage.
- Installable PWA shell, accessible React transaction overlays, typed React↔Phaser event bridge.
- Port Shieldup's progress tracker, transaction/error state, token/amount handling and recovery affordances into the building UI.

### Weeks 2–4 — Bank + Post Office on mainnet

- Port Shieldup's deposit, balance, withdraw and private-transfer flows to Wallet API actions.
- Retain maturity state, live fee reads, recipient preflight, fee ceilings, pending/reverted states and privacy copy.
- Use mainnet micro-amount fixtures for automated/manual smoke runs. No mandatory Sepolia phase.
- Apply operational sponsor quotas/rate limits without imposing an artificial cap on user-owned balances.

### Weeks 3–5 — Exchange on mainnet

- Replace the historical private-swap REST/prover adapter with AVNU SDK 4.2's Wallet API prover path where it is equivalent.
- Retain Shieldup's quote TTL, slippage, dynamic executor, fee-action validation, unsupported-token and failure handling.
- Put the building behind an operational feature flag so it can be disabled independently during an AVNU incident; this is not a scope deferral.

### Weeks 5–8 — hardening, multiplayer and art pass

- Lobby reconnection, moderation basics, deploy/header/PWA matrix and production RPC failover.
- Mainnet end-to-end regression suite covering all three financial buildings.
- Dependency pruning: do not inherit Shieldup's legacy Starknet/Privy/WalletConnect/vendored-SDK dependency tree or its current 36 audit advisories.
- Building facades, sprites, walking animations, sound and onboarding polish.
- Incident/kill-switch runbook, sponsor-budget alerts and privacy-safe operational monitoring.

### After v1 — Vesu supply/redeem (3–5 weeks plus independent contract review)

- Verify/deploy exact anonymizer, pin Vesu vault/token allowlist, test rounding and failed liquidity cases.
- No borrowing/collateral until a separate position/privacy design and audit.

### Parallel product track

- Wallet API passkeys still require a wallet that implements both the desired authentication and STRK20 methods. Shieldup proves extensionless Privy onboarding, not passkey Wallet API support.
- If extensionless onboarding is mandatory before such a wallet exists, the prior Privy + low-level SDK path can be retained behind the same `PrivacyClient` boundary, but it also retains a prover/discovery dependency and a different trust model.
- Bilateral trading after a separate privacy, identity, consent and abuse specification.
- Nostra only after a specific anonymizer/position model and review.

## Mainnet-first release gates

These gates protect the migration without changing the mainnet-first product decision:

1. exact Ready/Xverse versions pass a published end-to-end test matrix;
2. Shieldup's existing Bank/Exchange/Post Office behavior has parity tests against the Wallet API adapter;
3. Wallet API call/proof output succeeds through the existing AVNU private submission pattern for every sponsored action used;
4. pool address, class/implementation, fee, pause and upgrade controls are verified at deploy time and continuously monitored;
5. token allowlist, fee/slippage ceilings, sponsor rate/budget controls and per-building kill switches are active;
6. independent review covers the composed flow, including frontend action construction and backend relayer;
7. installed PWA, normal browser, popup/iframe and service-worker update behavior pass the supported-browser matrix;
8. privacy claims have a defined threat model and counsel has reviewed the public launch;
9. incident response, user support, status page, monitoring and rollback/degraded-mode drills are complete;
10. the exposed API key has been rotated.

## Remaining unknowns to take to vendors

### STRK20 / Starknet Privacy team

- Canonical mainnet deployment registry: proxy, current implementation/class hash, verifier, auditor, governance, prover and discovery endpoints.
- Supported production wallet/version matrix and registration/deep-link flow.
- `PRIVACY_LEAK` trigger conditions and safe action-bundle constraints.
- Current maturity rule, supported tokens, fee policy and upgrade/pausing notification channel.
- Prover/discovery throughput, availability, limits, retention, privacy policy and incident SLA.
- Anonymity-set/activity metrics that can support honest user claims.
- Whether arbitrary anonymizers are permissionless in the production wallet/prover path.

### Ready and Xverse

- Which extension/mobile/web surfaces expose Wallet API `>=0.10.3`.
- Whether balance, simulation, registration and each action prompt; expected prompt sequence.
- Installed-PWA popup/iframe support, origin allowlists and mobile in-app-browser behavior.
- Recovery and migration of viewing keys/private notes; what happens if the extension is lost.
- Rate limits and concurrency behavior for proof generation and synchronization.

### AVNU

- Private API production status, compatibility guarantees, rate limits, sponsor budgets and support SLA.
- Whether Wallet API `strk20PrepareInvoke` output is contractually supported by the same private `apply_action` endpoint Shieldup already uses for low-level SDK call/proof output.
- Dynamic executor/allowlist policy and change notification.
- Who bears failed/reverted sponsorship cost and how idempotency/retry should be implemented.

### Vesu

- Approved current V2 vault/token addresses and integration/version policy.
- Whether the Starknet Privacy anonymizer has a reviewed canonical mainnet deployment.
- Emergency pause/upgrade/liquidity behavior for deposit and redeem.

## Sources and reproducibility notes

Only official documentation, official source repositories, published npm artifacts, and direct Starknet JSON-RPC reads were used. No Cairo Coder API request was made, and the exposed key was not used.

Key sources:

- [Shieldup source at the reviewed commit](https://github.com/Calcutatator/shieldup/tree/290f8306571ce45e630c5a08b243d7b5f8c232b4)
- [Shieldup mainnet capability handoff](https://github.com/Calcutatator/shieldup/blob/290f8306571ce45e630c5a08b243d7b5f8c232b4/docs/HANDOFF-2026-06.md)
- [Shieldup private operations](https://github.com/Calcutatator/shieldup/blob/290f8306571ce45e630c5a08b243d7b5f8c232b4/apps/shield20-app/src/lib/shielded-ops.ts) and [AVNU private submission](https://github.com/Calcutatator/shieldup/blob/290f8306571ce45e630c5a08b243d7b5f8c232b4/apps/shield20-app/src/lib/private-paymaster.ts)
- [STRK20 machine-readable build documentation](https://strk20-by-example.org/llms-full.txt)
- [Starknet Privacy official repository](https://github.com/starkware-libs/starknet-privacy)
- [Starknet Privacy audit index](https://github.com/starkware-libs/starknet-privacy/tree/main/docs/audit)
- [Starknet.js Wallet V6 source](https://github.com/starknet-io/starknet.js/blob/1e75600792e97f92e7f270aef0b53fc6572e09ee/src/wallet/connectV6.ts)
- [Starknet account abstraction](https://docs.starknet.io/learn/protocol/accounts)
- [AVNU private swap](https://docs.avnu.fi/docs/privacy/private-swap)
- [AVNU private paymaster execution](https://docs.avnu.fi/api/paymaster/execute-private-transaction)
- [AVNU private-product update](https://docs.avnu.fi/updates/privacy)
- [Vesu developer documentation](https://docs.vesu.xyz/developers)
- [Nostra lending documentation](https://docs.nostra.finance/lend-and-borrow/introduction)
- [Starkzap overview](https://docs.starknet.io/build/starkzap/overview)
- [Ready Web Wallet](https://docs.ready.co/ready-wallets/web-wallet) and [setup guide](https://docs.ready.co/web-wallet-sdk/set-up-guide)
- [Cartridge Controller architecture](https://docs.cartridge.gg/controller/architecture)
- [Phaser React template](https://github.com/phaserjs/template-react)
- [Colyseus](https://github.com/colyseus/colyseus)
- [HTML cross-origin opener policies](https://html.spec.whatwg.org/dev/browsers.html#cross-origin-opener-policies)
