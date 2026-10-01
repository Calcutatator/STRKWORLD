# Railway test deployment

A private test site for playing with real wallets. It runs the same
one-container composition as `deploy/fly` (D-045): one public process serves
the shell, proxies `/api` to the relay and forwards the lobby. `railway.json`
at the repo root points Railway at `deploy/fly/Dockerfile` and keeps exactly
one instance with no deploy overlap, because the relay's rate limits and
sponsorship budget and the lobby's rooms live in process memory.

This is a test deployment, not a launch. Railway's HTTP logs can retain client
IPs and paths, which the Fly plan forbids; accept that only for private
testing.

## One-time setup

```sh
railway init                      # new project, e.g. "strkworld"
railway add --service strkworld   # empty service, deployed from this repo
railway domain                    # generates <service>.up.railway.app
```

Then set the variables below, and deploy with `railway up` from the repo root
(or connect the GitHub repo so pushes to `main` deploy).

A CLI upload does not apply `railway.json`: Railway falls back to its automatic
Node builder, which finds no start command. Set
`RAILWAY_DOCKERFILE_PATH=deploy/fly/Dockerfile` on the service so every build
uses the Dockerfile.

Also set `NODE_OPTIONS=--dns-result-order=ipv4first`. Without it the relay's
outbound RPC calls failed from Railway's containers (Node tried an address the
container could not reach), so every pool read returned `UPSTREAM_FAILURE`.

## Variables

Railway variable references keep the three origin values in step with the
generated domain.

### Secrets: set these yourself, in the Railway dashboard

| Variable | Value |
|---|---|
| `FEE_AUTHORIZATION_SECRET` | Required: 32+ random characters, for example the output of `openssl rand -hex 32`. |
| `VITE_ENTRY_GATE_BYPASS` | Temporary, testing only. `true` lets a connected wallet into the city without the D-072 pool-balance check. Build arg; unset it before launch. |
| `AVNU_PAYMASTER_API_KEY` | Optional, and unused by every player flow this build enables (D-082). Since D-082 the wallet proves and submits unshield, send and stake itself, as it does shield and the Vault, so none of them reaches the relay. Only the quote-bound swap still goes through the relay, and the browser never enables swap today; with swap enabled and no key, a swap answers `503 RELAY_NOT_CONFIGURED` (D-070). Get one at https://portal.avnu.fi: connect a deployed wallet and create a key. It is an access credential, not a budget: in private mode each transaction repays avnu itself, so Portal credits (which fund gasfree sponsorship) are not what these relays spend. |

### Runtime (public configuration)

| Variable | Value |
|---|---|
| `FLY_PUBLIC_ORIGIN` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` |
| `LOBBY_ALLOWED_ORIGINS` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` |
| `STRK20_POOL_ADDRESS` | `0x040337b1af3c663e86e333bab5a4b28da8d4652a15a69beee2b677776ffe812a` |
| `STRK20_FEE_TOKEN` | `0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d` (STRK) |
| `STRK20_NOTE_MATURITY_BLOCKS` | `10` |
| `STARKNET_CHAIN_ID` | `SN_MAIN` |
| `STARKNET_RPC_URL` | `https://api.cartridge.gg/x/starknet/mainnet` (public, no key), or your own RPC |
| `PLAZA_POOL_VALUE_URL` | Optional (D-080). Defaults to strkprice.com's public pool-value proxy, `https://strkprice-pool-api-production.up.railway.app/api/pool` — no key, backend-only (its CORS admits only strkprice origins). Set only to point the plaza's USD figure at a different aggregate; it must be https. |
| `BACKEND_MAX_REQUEST_BYTES` / `_MAX_CALLDATA_ITEMS` / `_MAX_PROOF_BYTES` | `2500000` / `256` / `2000000` |
| `BACKEND_REQUEST_TIMEOUT_MS` | `20000` |
| `BACKEND_GLOBAL_ENABLED` | `true` |
| `BACKEND_RATE_LIMIT_MAX_REQUESTS` / `_WINDOW_MS` | `120` / `60000` |
| `BACKEND_SPONSORSHIP_MAX_FEE_AMOUNT` / `_WINDOW_MS` | `50000000000000000000` (50 STRK) / `3600000` |
| `BACKEND_QUEUE_MAX_IN_FLIGHT` / `_MAX_QUEUED` | `4` / `64` |
| `BACKEND_ROUTE_TRANSFER_ENABLED` / `_MAX_RELAY_FEE` / `_MAX_QUEUE_DELAY_MS` / `_ALLOWED_TOKENS` | `true` / `10000000000000000000` (10 STRK) / `0` / STRK |
| `BACKEND_ROUTE_UNSHIELD_…` | the same four, with the same values |
| `BACKEND_ROUTE_SWAP_ENABLED` / `_MAX_RELAY_FEE` / `_MAX_QUEUE_DELAY_MS` / `_ALLOWED_TOKENS` / `_MAX_SLIPPAGE_BPS` | `false` / `10000000000000000000` / `0` / STRK / `50` (the browser never enables swap today) |

Leave `BACKEND_ROUTE_STAKE_*` and `BACKEND_DEGEN_*` unset: both stay off (D-063,
D-067).

### Browser build (public, compiled into the bundle)

| Variable | Value |
|---|---|
| `VITE_LOBBY_URL` | `wss://${{RAILWAY_PUBLIC_DOMAIN}}` |
| `VITE_STARKNET_CHAIN_ID` | `SN_MAIN` |
| `VITE_STARKNET_RPC_URL` | `https://api.cartridge.gg/x/starknet/mainnet`, or an RPC key allowlisted to the domain |
| `VITE_BACKEND_BASE_URL` | `/api` |
| `VITE_STRK20_SHIELD_ENABLED` / `_MAX_INTENTS` / `_ALLOWED_TOKENS` | `true` / `1` / STRK, ETH, USDC, USDT and WBTC, comma separated (D-072; the list is in `.env.production.example`) |
| `VITE_STRK20_UNSHIELD_ENABLED` / `_MAX_INTENTS` / `_MAX_RELAY_FEE` / `_ALLOWED_TOKENS` | `true` / `1` / `10000000000000000000` / STRK (D-062) |
| `VITE_STRK20_TRANSFER_ENABLED` / `_MAX_INTENTS` / `_MAX_RELAY_FEE` / `_ALLOWED_TOKENS` | `true` / `1` / `10000000000000000000` / STRK |

Leave `VITE_STRK20_STAKE_*` unset. With shield enabled, the Bridge's D-061
reserve planner is on too. Leave `VITE_STRK20_VAULT_*` unset too, except for
the Vault probe below: unset, the Vault is the locked facade. Leave
`VITE_STRK20_BORROW_ENABLED` unset except for the Borrow counter probe below.

## After it deploys

1. Open the domain: the connect screen should appear (production gates the
   street behind a supported wallet, D-055). After connecting, the entry gate
   (D-072) asks to share the private balance once per tab session; an account
   with nothing in the pool deposits there through the shield route, so a
   deployment with shield switched off shows new players a locked deposit
   card.
2. `curl -i https://<domain>/health` returns 404 (there is no public health
   route); `/` returns the shell with no COOP/COEP headers.
3. Two browsers see each other's avatars on the street.
4. With a funded wallet, do one small shield first, then read the balance at
   the Bank, then one small unshield. Those two receipts are D-056's and
   D-062's live evidence. The wallet submits the unshield itself (D-082), so
   it needs no avnu key. A `railway logs` line starting
   `[relay] AVNU_PAYMASTER_API_KEY is not set` names the backend's own relay
   endpoints, which the browser now calls only for a swap.

## The Vault probe (D-077, D-079, D-081)

The Vault lends to Vesu from the player's STRK20 shadow account, in every
market D-081 pins: twenty-three tokens, nine through Vesu's Prime pool and
fourteen through five curated pools (nine through Re7 xBTC, strkBTC among
them). Eleven are lent out and offered for supply (STRK, ETH, USDC, USDT, USDC.e, WBTC, strkBTC, tBTC, SolvBTC, wstETH, LBTC). The
other twelve are collateral only: Vesu lends none of them out, so supplying
them would earn nothing, and the counter does not offer them for supply until
borrowing ships; a position already in one still shows and redeems. Its first
live use, in STRK, showed that Ready runs shadow accounts end to end. The next
one, in a token other than STRK, answers which token Ready takes the pool fee
in; one in strkBTC is the first through a curated pool.

1. Set both browser variables and redeploy. They are compiled into the
   bundle, so it takes a rebuild; the Dockerfile declares both as build
   arguments. Nothing changes on the backend: the Vault is submitted by the
   wallet, needs no avnu key and has no `BACKEND_ROUTE_*` block, and its
   three public reads (the stand-in address, the positions and Vesu's
   supply APY, which the backend fetches from `api.vesu.xyz`, one request
   per pinned pool) follow `BACKEND_GLOBAL_ENABLED`.

   | Variable | Value |
   |---|---|
   | `VITE_STRK20_VAULT_ENABLED` | `true` |
   | `VITE_STRK20_VAULT_ALLOWED_TOKENS` | `0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d,0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7,0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb,0x068f5c6a61780768455de69077e07e89787839bf8166decfbf92b645209c0fb8,0x053c91253bc9682c04929ca02ed00b3e423f6710d2ee7e0d5ebb06f3ecf368a8,0x02411565ef1a14decfbe83d2e987cced918cd752508a3d9c55deb67148d14d17,0x04be8945e61dc3e19ebadd1579a6bd53b262f51ba89e6f8b0c4bc9a7e3c633fc,0x03fe2b97c1fd336e750087d68b9b867997fd64a2661ff3ca5a7c771641e8e7ac,0x0787150e306e6eae6e3f79dea881770e8bbff2c1b8eb490f969669ee945b3135,0x04daa17763b286d1e59b97c283c0b8c949994c361e426a28f743c67bdfe9a32f,0x0593e034dda23eea82d2ba9a30960ed42cf4a01502cc2351dc9b9881f9931a68,0x023a312ece4a275e38c9fc169e3be7b5613a0cb55fe1bece4422b09a88434573,0x02cab84694e1be6af2ce65b1ae28a76009e8ec99ec4bc17047386abf20cbb688,0x04e4fb1a9ca7e84bae609b9dc0078ad7719e49187ae7e425bb47d131710eddac,0x028d709c875c0ceac3dce7065bec5328186dc89fe254527084d1689910954b0a,0x0057912720381af14b0e5c87aa4718ed5e527eab60b3801ebf702ab09139e38b,0x06a567e68c805323525fe1649adb80b03cddf92c23d2629a6779f54192dffc13,0x047751b3532fabca89b0f2e35ca1cb45e5a7b11d5e3d3663dfa1f4406b45fd88,0x043a35c1425a0125ef8c171f1a75c6f31ef8648edcc8324b55ce1917db3f9b91,0x036834a40984312f7f7de8d31e3f6305b325389eaeea5b1c0664b2fb936461a4,0x07dd3c80de9fcc5545f0cb83678826819c79619ed7992cc06ff81fc67cd2efe0,0x0580f3dc564a7b82f21d40d404b3842d490ae7205e6ac07b1b7af2b4a5183dc9,0x075afe6402ad5a5c20dd25e10ec3b3986acaa647b77e4ae24b0cbc9a54a27a87` (every pinned market, in order: STRK, ETH, USDC, USDT, USDC.e, sUSN, mRe7YIELD, WBTC, strkBTC, tBTC, SolvBTC, uniBTC, YBTC.B, mRe7BTC, xSTRK, wstETH, xWBTC, xstrkBTC, xtBTC, LBTC, xLBTC, xsBTC, EKUBO) |

   Any subset of those twenty-three, in any order, also works; anything else
   keeps the whole Vault locked.

2. Turn on the debug logs below as well, and open the site with `?debug=1`.
3. With a funded account on a wallet that reports Wallet API 0.10.4, keep at
   least the pool fee (6 STRK) in the shielded balance, in STRK, as well as
   the amount to lend. At the Vault's counter: Show my positions, choose a
   token, supply a small amount, read the positions again, then redeem
   everything. Each move pays the pool fee from the shielded balance. For a
   token other than STRK, note which token the wallet's prompt takes the fee
   in. Reviewing a supply first reads that token's shielded balance (the
   wallet may ask), and with none of it there the counter says so and asks
   nothing more; a supply of strkBTC is the first through a curated pool.
4. Read the `vault.*` lines: `vault.capability`, `vault.commitment` (ok or
   the wallet's code), `vault.address` (resolved and deployed, never the
   address), `vault.position`, `vault.prepare`, `vault.confirm` stages,
   `vault.submit` (ok or the code) and `vault.receipt`. They carry no amount,
   address, balance, token or hash. If a non-STRK supply is refused with
   119 while that token's balance covers it, check the STRK balance: the
   wallet may be taking the fee in STRK.

To lock it again, unset both variables and redeploy.

## The Borrow counter probe (D-083)

The BORROW counter stands beside SUPPLY / REDEEM in the Vault's room. It
borrows on Vesu's Prime pool from a second STRK20 shadow account (dapp name
`strkworld-borrow`, nonce 0), never the Vault's, in every pair Vesu offers
among STRK, ETH, USDC, USDT and WBTC (pinned in
`packages/privacy/src/borrow.ts`; a pair whose max LTV or debt cap reads
zero is left out). Each action, opening or adding to a loan, adding
collateral, repaying (part, or everything with a small buffer whose unused
part returns to the pool) and withdrawing collateral, is one private
transaction the wallet proves and submits. **No live borrow through a
shadow account has been made yet**: the first one is this probe.

1. The Vault's door must be open (the Vault probe above). Set one more
   browser variable and redeploy; it is compiled into the bundle, and the
   Dockerfile declares it as a build argument. Nothing changes on the
   backend: the counter's two public reads (Vesu's pool, the loans on the
   stand-in address) follow `BACKEND_GLOBAL_ENABLED`, and nothing is relayed.

   | Variable | Value |
   |---|---|
   | `VITE_STRK20_BORROW_ENABLED` | `true` |

   There is no token list: the five tokens are pinned. Any value other than
   `true` keeps the counter locked.

2. Turn on the debug logs below, and open the site with `?debug=1`.
3. With a funded account on a wallet that reports Wallet API 0.10.4, keep the
   pool fee (6 STRK) in the shielded balance as well as the collateral, and a
   little of the borrowed token for repaying everything (the debt plus 0.1 %
   and two base units). At the BORROW counter: borrow a small amount above
   Vesu's $10 minimum against comfortably more collateral, Show my loans,
   repay everything, then withdraw all the collateral. Vesu's oracle prices
   each loan; the counter refuses, before the wallet is asked, anything Vesu
   would revert, and says which rule.
4. Read the `vault.*` lines as for the Vault: `vault.prepare kind=borrow`,
   `kind=repay all=true` and so on, then the commitment, address, position,
   submit and receipt stages. They carry no amount, address, balance, token
   or hash. A `vault.submit ok=false` on the first borrow is the answer the
   probe exists for: report it with its code rather than retrying.

To lock it again, unset the variable and redeploy.

## Debug logs

For a test session whose failures should reach the developer without copy and
paste (D-069). **Never enable it for a launch.**

1. On the test service, set both flags and redeploy. The browser flag is
   compiled into the bundle, so it takes a rebuild, not just a restart.

   | Variable | Value |
   |---|---|
   | `BACKEND_DEBUG_LOGS_ENABLED` | `true`. Opens `POST /api/v1/debug/logs`. Unset or empty, that path answers 404 like any unknown route; any value other than `true` or `false` stops the relay from starting. |
   | `VITE_DEBUG_LOGS` | `true`. Compiles the browser logger in. Unset, the bundle does not contain it. |

2. Open the site with `?debug=1`, for example
   `https://strkworld-production.up.railway.app/?debug=1`. A badge in the
   bottom-left corner reads "Debug logs on · sending to the server". It stays
   on for that tab's browser session, reloads included, until you press its
   **Turn off** button or open `?debug=0`. Without `?debug=1` nothing is
   captured or sent, even from a debug build. If the badge says the server is
   not accepting them, `BACKEND_DEBUG_LOGS_ENABLED` is not set.

3. Read the logs:

   ```sh
   railway logs --service strkworld | grep '\[debug\]'
   ```

   Each line is `[debug] <session> <ISO time> <level> <event> <detail>`:

   ```
   [debug] 3f0c5a6e-8d1b-4c2a-9e7f-1b2c3d4e5f60 2026-09-28T16:04:12.345Z error privacy.operation kind=not-registered code=118 NOT_REGISTERED message="This wallet is not registered with the privacy pool." cause="An error occurred (NOT_REGISTERED)"
   ```

   The session id is random for each tab's browser session; hover over the
   badge to see it, and add it to the `grep` to follow one tester. Lines whose
   session is `server` are the relay's own: `debug.dropped` counts entries
   dropped above the limit of 600 a minute, across all sessions.

The browser sends window errors and unhandled rejections; `console.error` and
`console.warn`; every privacy and wallet failure, with its PrivacyError kind,
wallet error code and message; connect-flow states; wallet-session phases,
with the connected account; buildings entered and exited, stations activated
and panels opened and closed; the Bank's mode switches, refused adds (reason
code), prepares (intent kinds and count) and confirm stages, never an amount,
balance, recipient or token (D-070); the Vault's and the Borrow counter's
probe steps, by yes/no, kind, stage name and wallet code only (D-077, D-083);
and failed `/api` calls, as path,
status and error code only. It never sends wallet signatures, calldata or proof data, and
long hex and base64 runs are redacted. It batches every 3 seconds and sends
what is left by `sendBeacon` when the page closes.

The relay writes no IP, header or request timing for these requests, but
Railway's own HTTP log records them as it records every request here. The
composition forwards only the relay's `[debug]` lines, and its one `[relay]`
startup line (D-070), to stdout; the rest of its output is still discarded.

To switch it off, unset both variables and redeploy. Both stay unset on any
service real players use: they are not in `.env.production.example`.
