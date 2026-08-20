# Fly one-Machine deployment

This image is the D-045 composition root: one public process owns `PORT`, serves
`apps/web/dist`, proxies `/api` to a private backend child, and forwards the
Colyseus matchmaking HTTP and WebSocket upgrades to a private lobby child.
Child readiness is a constant IPC message sent only after each real listen
promise resolves. A child exit terminates the Machine through the launcher;
there is no public health or metrics route.

Startup resolves the configured static root and requires `index.html` to be a
regular file whose canonical path stays inside that root before either private
child is spawned. It repeats the same package-owned containment check after
private readiness and the public bind, immediately before handing the
composition to its caller. A missing file, directory, or escaping symlink fails
with the generic `Fly static shell is unavailable.` error; anything already
started is closed before startup rejects.

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
  FLY_PUBLIC_ORIGIN=https://<real-domain> \
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
3. `curl -i -X POST https://<domain>/api/v1/rpc/pool-config -H 'Content-Type: application/json' --data '{"v":1}'` reaches the backend with `/api` stripped, the exact JSON body and content metadata preserved, and no `Access-Control-Allow-Origin` header.
4. `curl -i -X OPTIONS https://<domain>/matchmake/joinOrCreate/street -H 'Origin: https://<real-domain>'` receives the allowlisted credentialed lobby CORS response; a different origin receives no allow-origin or credentials grant.
5. Attempt a WebSocket upgrade with the configured origin, a missing origin and a different origin; only the configured origin may reach the lobby child. Confirm matchmaking HTTP and WebSocket upstreams receive no Cookie, Authorization, Proxy-Authorization or other unlisted credential header.
6. Connect two browser sessions to `wss://<domain>/...` and verify mutual avatars. The user owns rendered acceptance; do not put wallet, address, balance, proof or transaction material in this smoke script.
7. Inspect Fly configuration and logs for exactly one active Machine and no platform access logging that retains client IP, path, timing, request bodies or financial material. Confirm no COOP/COEP headers.

`VITE_LOBBY_URL` is a public build value, not a secret. The Docker build fails
closed unless it is a real `wss://` endpoint and verifies that the
compiled web artifact contains it without an application-configured localhost
endpoint. The pinned Colyseus SDK's exact unreachable `ws://127.0.0.1:2567`
development fallback is allowed by the check and is not used by the shell.
The final image retains that public value in the build-owned fixed file
`/app/build-metadata/lobby-url`; startup reads that file independently of the
runtime environment and fails closed unless it is the exact `wss://` equivalent of
`FLY_PUBLIC_ORIGIN`, including any explicit port. This prevents a valid but
different lobby endpoint from being compiled into the browser while the
Machine starts under another origin, and a runtime environment override cannot
substitute a different authority. Runtime also fails closed unless
`FLY_PUBLIC_ORIGIN` is present in the trimmed `LOBBY_ALLOWED_ORIGINS` list. The
production edge contract is D-047's
fixed opaque key set `avatar-1` through `avatar-16`: keys 1–8 are the eight
cosy/default characters and keys 9–16 are their paired fighting variants.
That pairing remains cosmetic; no stance or action field enters lobby traffic.
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
