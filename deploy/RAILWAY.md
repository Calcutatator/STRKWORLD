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
| `AVNU_PAYMASTER_API_KEY` | Optional (D-068). The relay is gasless without it: the player's shielded STRK repays each relay's gas. Set one only if AVNU asks for it. |

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
| `VITE_STRK20_SHIELD_ENABLED` / `_MAX_INTENTS` / `_ALLOWED_TOKENS` | `true` / `1` / STRK (D-056) |
| `VITE_STRK20_UNSHIELD_ENABLED` / `_MAX_INTENTS` / `_MAX_RELAY_FEE` / `_ALLOWED_TOKENS` | `true` / `1` / `10000000000000000000` / STRK (D-062) |
| `VITE_STRK20_TRANSFER_ENABLED` / `_MAX_INTENTS` / `_MAX_RELAY_FEE` / `_ALLOWED_TOKENS` | `true` / `1` / `10000000000000000000` / STRK |

Leave `VITE_STRK20_STAKE_*` unset. With shield enabled, the Bridge's D-061
reserve planner is on too.

## After it deploys

1. Open the domain: the connect screen should appear (production gates the
   street behind a supported wallet, D-055).
2. `curl -i https://<domain>/health` returns 404 (there is no public health
   route); `/` returns the shell with no COOP/COEP headers.
3. Two browsers see each other's avatars on the street.
4. With a funded wallet, do one small shield first, then read the balance at
   the Bank, then one small unshield. Those two receipts are D-056's and
   D-062's live evidence.
