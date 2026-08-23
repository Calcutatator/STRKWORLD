# STRK20 Privacy Integration Plan — STRKWORLD

Generated 2026-08-21 by the `strk20-privacy-integration` skill. Package and wallet behavior must be re-verified at each phase boundary.

## 1. Project snapshot

- Stack: React 19 + Vite Web shell, TypeScript monorepo, `starknet@10.4.0`, `@starknet-io/get-starknet-discovery@6.0.3`, `@starknet-io/get-starknet-wallet-standard@6.0.3`, `@starknet-io/types-js@0.10.3`, `@avnu/avnu-sdk@4.2.0`, Vitest, a no-logging Node Backend, and no project-owned Cairo contract.
- Relevant code:
  - `apps/web/src/main.tsx` is the production composition gap: it currently mounts `App` without real `PrivacyOperations`, so production refuses the demo seam.
  - `apps/web/src/App.tsx` already accepts real `PrivacyOperations` and a Bridge account/service composition.
  - `packages/privacy/src/wallet-api/discovery.ts` already provides dynamic Wallet Standard discovery and wallet-bound supported-version reads.
  - `packages/privacy/src/wallet-api/operations.ts` already implements capability, private balances, shield, unshield, transfer, and swap preparation through `WalletAccountV6`.
  - `packages/privacy/src/wallet-api/backend-client.ts` already implements same-origin pool reads, relay-fee authorization, private submission, and swap-plan reads.
  - Bank, Post Office, and Exchange have complete offline room/panel/state-machine implementations. Bridge is a public funding edge but its production fee-aware `PublicShieldPlanner` remains intentionally absent. Vault is locked and outside v1.
- Privacy goal: players connect their own wallet; STRK20 keeps private balances and private transfers inside the wallet/pool boundary. STRKWORLD never receives viewing keys, notes, nullifiers, or proving infrastructure. The Bridge remains explicitly public.
- Environment: Starknet mainnet (`SN_MAIN`) from day one. Live work starts with non-funded discovery/capability/read checks, then an explicitly approved smallest private transfer using disposable accounts and existing mature private STRK.

## 2. Chosen route: Privacy Wallet API through starknet.js

STRKWORLD is a normal dapp relying on the player's wallet, so it will use dynamic Wallet Standard discovery and `WalletAccountV6`. The wallet owns connection, private state, proof generation, and transaction signing; the browser app receives only the frozen `PrivacyOperations` seam it already understands. The Backend remains a privacy-safe pool-read, fee-authorization, and bounded-submission proxy; it never receives viewing keys or private note state.

**The rule this follows:** STRKWORLD never touches viewing keys — the user's wallet acts on its behalf through starknet.js.

## 3. What this delivers — hidden vs visible

| Private | Public |
|---|---|
| Private pool balance and note ownership; sender/recipient linkage for private transfers; private transfer amount and token inside the pool action; the player's wallet/account link to relayed private transactions. | Shield and unshield deposits/withdrawals, their amounts, tokens, and timing; the fact and timing of pool interaction; the relayer transaction; public Bridge funding; public application/executor activity and exposed amounts for protocol-specific DeFi routes. |

The Bank's private transfer can hide who paid whom, but a Bridge deposit and any later public shield remain public funding activity. The Exchange can hide the player's wallet link while its selected assets, amounts, and AVNU executor activity may remain public.

## 4. Prerequisites and versions

- Retain the tested direct pins for Phase 1: `starknet@10.4.0`, discovery and wallet-standard `6.0.3`, types-js `0.10.3`, AVNU `4.2.0`.
- Freshness check on 2026-08-21 found newer `next` tags for discovery (`6.0.4`) and wallet-standard (`6.0.5`). They are not silently adopted; a separate upgrade must compile-probe and regression-test them.
- Test wallet: Ready. Record the actually installed extension version before live testing; the current Ready `5.33.8` behavior is source-derived, not yet observed in this browser.
- Browser config: `VITE_STARKNET_CHAIN_ID=SN_MAIN`, canonical `VITE_STRK20_POOL_ADDRESS`, same-origin `VITE_BACKEND_BASE_URL=/api`, and a domain-allowlisted public browser RPC URL only where needed. No secret may use a `VITE_` variable.
- Backend config and secrets remain server-only: mainnet RPC, pool address, fee token, fee-authorization secret, paymaster key/credits, queue/rate/budget limits, and per-route admission.

## 5. Phase 1 — real wallet session in the game, no money movement

Status: headless implementation complete 2026-08-23 under D-054; awaiting the
manual Ready discovery/connection/capability gate below. No funded route is
enabled.

1. Record a decision approving a privacy-owned `WalletSession` port. Web may import that port, but it must not import wallet libraries or implement wallet capability/business logic.
2. Add `packages/privacy/src/wallet-api/session.ts` and tests. The session owns:
   - dynamic `createWalletDiscovery()`;
   - an explicit discovered-wallet choice (never silently pick the first wallet and never branch on wallet name/id);
   - `WalletAccountV6.connect` on `SN_MAIN`;
   - account, network, disconnect, wallet-removal, and stale-connect generations;
   - a stable `PrivacyOperations` facade that constructs a fresh wallet-backed implementation per connected-account generation;
   - wrappers that reject/discard prepared work before an old account can sign after a switch or disconnect.
3. Add a production Web composition/provider that subscribes to the session snapshot and injects its stable operations into `App`. Supply the same connected-account authority to Bridge as reactive `account` plus stable `readAccount`, while keeping `planner: null` so new Bridge-to-Bank instructions remain locked.
4. Add an explicit wallet picker and Connect/Recheck/Disconnect states to the existing Shell flow. Unsupported Wallet API versions, rejection, wrong network, disconnect, empty/malformed accounts, and no discovered wallet all fail closed with no financial room admitted.
5. Start with a deliberately deny-all financial policy: `maxIntents: 0`, `maxRelayFee: 0n`, `enabledRoutes: []`, and empty per-route token lists. This is not a fee guess; it makes every preparation impossible while allowing real discovery, connection, Wallet API version capability, pool config, and deliberate balance/recipient reads.
6. Keep the existing production demo refusal. A failed production session must show a real connection/configuration failure, never practice balances.

Manual gate after Phase 1 at `http://localhost:5173/`:

- Ready appears only through dynamic discovery and requires an explicit click.
- Approving connection yields the selected mainnet account; rejection remains disconnected.
- Wallet API capability reports a parsed version at least `0.10.3` without using a balance read as feature detection.
- Switching away from `SN_MAIN`, changing account, disconnecting, or removing the wallet immediately retires the financial session and old prepared work.
- Bank/Post Office/Exchange can reach truthful connect/capability surfaces, but every transaction preparation remains disabled.
- No wallet-specific name branch, proof, submission request, transaction hash, or funds movement occurs.

## 6. Phase 2 — real mainnet reads and one transfer-only policy

Status: blocked on Phase 1 acceptance and an explicit relay-fee ceiling.

1. Read the live pool config through same-origin `/api/v1/rpc/pool-config`; record the current fee token/amount, note maturity, and proof-validity window. Do not reuse an older observed fee as a constant.
2. Deliberately request one-token private balances from Ready and record the actual consent prompt, count, order, and latency. Capability detection remains separate. A wallet error `118` is an onboarding/registration stop, not permission for STRKWORLD to register the account.
3. Approve and freeze the first production `WalletRoutePolicy`:
   - `maxIntents`: 16, matching the existing Menu batch limit;
   - enabled route: `transfer` only;
   - allowed operation/fee token: canonical STRK only;
   - `shield`, `unshield`, and `swap`: disabled;
   - `maxRelayFee`: **not selected yet**. It must be an explicit user-approved global ceiling informed by a live read, not an invented test value.
4. Use disposable mainnet sender A and registered recipient B. If A lacks an existing mature shielded STRK balance sufficient for amount + live pool fee + relay fee, stop. Do not use the still-locked Bridge planner to manufacture funding.
5. Exercise preparation without submission first. A rejected Ready preparation must map to the existing user-rejected state and send zero requests to `/v1/private/submissions`. If an approved preparation creates a proof artifact, discard it locally and do not log or persist its raw contents.

Manual gate after Phase 2:

- The displayed fee token, pool fee, relay fee, total ceiling, maturity, and proof-validity window come from current mainnet reads.
- The Bank review matches the exact transfer intent and fee ceiling.
- No private submission request was dispatched and no transaction hash exists.
- No raw account, proof, actions, fee authorization, or secret is copied into chat, screenshots, logs, or Git.

## 7. Phase 3 — smallest approved funded mainnet interaction

Status: blocked on Phase 2 acceptance and per-transaction user approval.

1. Perform one pool-native private transfer from disposable registered A to registered B. Do not start with shield, unshield, swap, Bridge, a batch, or Vault.
2. Immediately before wallet handoff, present for explicit approval: selected wallet/account label, `SN_MAIN`, STRK token, registered recipient label, tiny exact amount, current pool fee, current relay fee, total fee ceiling, transfer route, authorization expiry, and proof-validity window.
3. On approval, the existing Bank confirmation calls wallet preparation with `simulate=false`, then the same-origin Backend submission. Record only redacted operational evidence and the first validated transaction hash; retain the receipt above panel state.
4. After confirmation/maturity/discovery delay, deliberately refresh the one-token private balance. Stop on any uncertainty gate rather than retrying.

If submission dispatch occurs but a validated hash does not reach the browser, the result is `submission-uncertain`: no automatic retry, no “nothing was sent” claim, and no next financial action until the existing refreshed-balance acknowledgement gate is completed.

## 8. Later feature integration

- Enable `shield` and `unshield` only after separate route/token/fee policy approval and live non-funded verification.
- Keep private `swap` disabled until the dynamic AVNU executor versus browser allowlist/registry authority is resolved and recorded. Do not infer executor admission from a valid quote alone.
- Keep Bridge `PublicShieldPlanner` null until a funded, source-verified, fee-aware implementation is accepted. Bridge remains explicitly public.
- Vault remains locked until its app-specific anonymizer contract is designed, reviewed, audited, deployed, and approved; this plan does not generate Cairo.

## 9. Testing

- Unit and integration: discovery, explicit selection, connection single-flight, capability versions, wrong-chain/account/disconnect ownership, stale-event rejection, old prepared-batch invalidation, policy immutability, production demo refusal, account-to-Bridge consistency, and route denial.
- Headless gates: package/Web/full tests, workspace typecheck, production build, invariants, D-005 header scan, and diff hygiene.
- Browser acceptance is user-run at `http://localhost:5173/`; automation is not substituted for the actual wallet prompts.
- Mainnet ladder: connect/capability first, deliberate reads second, preparation without submission third, and one explicitly approved funded transfer last.

## 10. Compliance and security notes

- Deposit screening is enforced onchain by the protocol; it applies on every route.
- Selective disclosure can support a legitimate regulatory request, but it is not automatic compliance or regulator endorsement. STRKWORLD owns its legal/compliance decisions.
- The lobby receives no address, balance, transaction hash, building name, or financial action.
- No private key, viewing key, note, nullifier, raw proof, raw action array, fee authorization, RPC key, or paymaster key may enter the repo, browser logs, lobby, screenshots, or chat.
- Transaction submission remains decoupled from avatar movement and building entry.

## 11. Open items to re-verify at build time

- Actual installed Ready extension version and live prompt behavior.
- Discovery/wallet-standard `next` tag drift and whether an upgrade is warranted after Phase 1.
- Current mainnet pool fee/config, recipient registration, private balance maturity, relay quote, and proof-validity window.
- User-approved global `maxRelayFee` for transfer-only Phase 2.
- Dynamic AVNU executor admission authority before any swap route is enabled.
- A production `PublicShieldPlanner` before Bridge-to-Bank public shielding can unlock.

## 12. Links

- Wallet API overview: https://strk20-by-example.org/starknet-wallet-api/overview
- starknet.js Wallet API route: https://strk20-by-example.org/starknet-wallet-api/starknet-js
- Current WalletAccountV6 guide: https://starknet-js.com/docs/next/guides/account/walletAccount/#with-get-starknet-v6
- STRK20 concepts: https://strk20-by-example.org/concepts
