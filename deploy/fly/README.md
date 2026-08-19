# Fly one-Machine deployment

This image is the D-045 composition root: one public process owns `PORT`, serves
`apps/web/dist`, proxies `/api` to a private backend child, and forwards the
Colyseus matchmaking HTTP and WebSocket upgrades to a private lobby child.
Child readiness is a constant IPC message sent only after each real listen
promise resolves. A child exit terminates the Machine through the launcher;
there is no public health or metrics route.

The repository does not create a Fly app, domain, secret or Machine. Before a
real deployment, supply the account and domain deliberately, then keep exactly
one Machine while the process-local aggregate controls remain in use:

```sh
fly auth login
fly apps create <chosen-app-name>
fly secrets set -a <chosen-app-name> \
  STRK20_POOL_ADDRESS=... \
  STRK20_FEE_TOKEN=... \
  STRK20_NOTE_MATURITY_BLOCKS=... \
  STARKNET_RPC_URL=... \
  AVNU_PAYMASTER_API_KEY=... \
  FEE_AUTHORIZATION_SECRET=... \
  LOBBY_ALLOWED_ORIGINS=https://<real-domain> \
  ...backend route and budget values...
fly deploy -a <chosen-app-name> -c deploy/fly/fly.toml \
  --build-arg VITE_LOBBY_URL=wss://<real-domain>
fly scale count 1 -a <chosen-app-name>
```

The app name is deliberately supplied on each command. Fly documents `-a` as
the application-name override for [`fly deploy`](https://fly.io/docs/flyctl/deploy/)
and the app configuration reference at
[`configuration`](https://fly.io/docs/reference/configuration/). Fly documents
[`--build-arg`](https://fly.io/docs/flyctl/deploy/) as a build-time variable
flag; it is public here because the lobby endpoint is compiled into the browser
bundle, never a secret.

Manual smoke checks after a staging deployment:

1. `curl -i https://<domain>/` returns the shell; `curl -i https://<domain>/health` and `/metrics` return 404.
2. A hashed `/assets/*` response is immutable; `/` and a client-side route are `no-cache`.
3. `curl -i -X POST https://<domain>/api/v1/rpc/pool-config` reaches the backend with `/api` stripped and no `Access-Control-Allow-Origin` header.
4. `curl -i -X OPTIONS https://<domain>/matchmake/joinOrCreate/street -H 'Origin: https://<real-domain>'` receives the allowlisted credentialed lobby CORS response; a different origin receives no allow-origin or credentials grant.
5. Connect two browser sessions to `wss://<domain>/...` and verify mutual avatars. The user owns rendered acceptance; do not put wallet, address, balance, proof or transaction material in this smoke script.
6. Inspect Fly configuration and logs for exactly one active Machine and no platform access logging that retains client IP, path, timing, request bodies or financial material. Confirm no COOP/COEP headers.

`VITE_LOBBY_URL` is a public build value, not a secret. The Docker build fails
closed unless it is a real `wss://` endpoint and verifies that the
compiled web artifact contains it without an application-configured localhost
endpoint. The pinned Colyseus SDK's exact unreachable `ws://127.0.0.1:2567`
development fallback is allowed by the check and is not used by the shell.
The committed config uses Fly's documented
[`[deploy] strategy = "immediate"`](https://fly.io/docs/reference/configuration/)
strategy. Fly replaces all Machines immediately without waiting for health
checks, so this intentionally accepts deployment downtime; Fly describes that
tradeoff in its [`deploy` guide](https://fly.io/docs/launch/deploy/). Stage it
first and verify the event has zero old/new Machine overlap and exactly one
active Machine before launch; the provider's actual behavior is the gate.

Operational limitations remain explicit: Fly account/domain/access-log controls,
runtime secret rotation, TLS, quotas and funded Wallet API validation are host
gates, not proven by this repository or by a local build. Do not add a second
Machine until D-026 aggregate adapters replace process-local controls.
