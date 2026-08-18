# Operations runbook

**Status: skeleton. Host-agnostic by necessity — no hosting provider, domain or
secret store has been chosen.** Everything here that does not depend on that
choice is real and verified. Everything that does is marked `[HOST]` and is
listed in [DECISIONS-NEEDED](#decisions-needed) at the bottom. Nothing in this
document recommends a vendor.

Three deployables:

| | What | Built by | Runs as |
|---|---|---|---|
| **web** | `apps/web` — the static shell | `npm run build --workspace=@strkworld/web` | static files on a CDN/static host `[HOST]` |
| **backend** | `apps/backend` — paymaster custody, RPC proxy, submission queue | `deploy/backend/Dockerfile` | a container `[HOST]` |
| **lobby** | `packages/lobby` — privacy-minimal Colyseus presence | production packaging not built yet | a single Node process behind `wss://` `[HOST]` |

The web and backend must share an origin. See [The same-origin
constraint](#the-same-origin-constraint) — it is an input to the hosting
decision, not a detail to settle afterwards. The lobby is a separate WebSocket
service with an explicit browser-origin allowlist; it does not receive cookies
or financial data.

---

## Build outputs

Verified on this branch with Node 25.9.0 / npm 11.12.1.

| Command | Output | Notes |
|---|---|---|
| `npm run build` | delegates to workspaces via `--if-present` | only `@strkworld/web` has a build script |
| `npm run build --workspace=@strkworld/web` | `apps/web/dist/` | `dist/index.html` + `dist/assets/index-<hash>.js` |
| `npx tsc -p deploy/backend/tsconfig.build.json` | `.docker-build/apps/backend/src/*.js` | container-only; gitignored |

`apps/web/dist/` is what the static host serves. Content-hashed asset
filenames mean assets can be cached immutably and `index.html` must not be.

**`apps/backend` produces no build output in-tree.** It has no build script and
the repo `tsconfig.json` sets `noEmit`; `apps/backend/package.json:6` points
`main` at `./src/index.ts`, i.e. the package is consumed as TypeScript source.
The container compiles its own JavaScript via
`deploy/backend/tsconfig.build.json` rather than adding a build script to
another lane's package.

**`packages/lobby` is implemented but not production-packaged.** Its local
`dev`/`start` script runs the TypeScript entry with `tsx`; that is sufficient
for verified local presence, not a production deployment artifact. Choose its
host and add a minimal Node build/container only after the domain fixes the
`wss://` endpoint and allowed web origin. Run exactly one Colyseus server per
process because its matchmaker is process-global.

---

## Deploy

### web

1. `npm ci` — reproducible from the committed lockfile.
2. `npm run verify` — typecheck, test, build.
3. `node scripts/check-headers.mjs` — the D-005 gate. Must pass.
4. Build with the production `VITE_*` values set in the build environment.
   Vite bakes them in; changing one requires a rebuild, not a restart.
5. Publish `apps/web/dist/` `[HOST]`.
6. Cache policy: `index.html` — `no-cache`; `assets/*` — immutable, long max-age.
7. **Re-run the header check against the deployed origin.** `check-headers.mjs`
   exercises this repo's serving config, not the host's. See
   [D-005 in production](#d-005-in-production).

### backend

```
docker build -f deploy/backend/Dockerfile -t strkworld-backend .   # from repo root
```

The build context is the repository root because the build needs the workspace
lockfile. `.dockerignore` excludes `.env*` (re-including only the two
`.example` templates) along with `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`
and `.npmrc` — a secret that enters a build context survives in image layers
and in `docker history`.

Both ignore lists are deliberately `.env*` rather than an explicit list. An
explicit list of `.env`, `.env.local` and `.env.*.local` missed
**`.env.production`**, which is precisely the filename `.env.production.example`
invites someone to create. Verified with `git check-ignore`: `.env.production`
and `.env.production.local` are ignored, and both `.example` templates are not.
The Dockerfile additionally `COPY`s explicit paths rather than `.`, so a stray
env file could not enter the image even if the ignore list were wrong.

Image properties, all verifiable by reading `deploy/backend/Dockerfile`:

- Base `node:22.12-alpine` (`ARG NODE_IMAGE`, overridable). Node 22.12 is the
  repository floor (D-025) because AVNU SDK 4.2.0 requires Node 22 and Vite
  supports Node 22 from 22.12.
- Multi-stage: `build` (compiles TS) → `runtime-deps` (`npm ci --omit=dev`) →
  `runtime` (neither toolchain nor dev dependencies present).
- Runs as `USER node` (uid 1000). Never root: this process holds the paymaster
  key and the fee-authorization HMAC secret.
- No secret in any `ENV` or `ARG`. Only `NODE_ENV` and `PORT` are baked.
- `HEALTHCHECK` is a TCP connect — see [Healthcheck](#healthcheck).

The image now starts the strict composition root in
`apps/backend/src/server.ts`: it parses the variables in
`.env.production.example`, constructs `BackendApi` and its production ports,
and binds a logging-free `node:http` listener on `0.0.0.0:$PORT`.
`deploy/backend/launch.mjs` exits 78 only when the compiled entry is absent.

Deploy steps once a host exists `[HOST]`: push image to a registry, inject
secrets from the secret store as environment variables (never as build args),
run at least two instances *only if* the aggregate-store caveat below is
resolved, and route the web origin's `/api` prefix to it.

---

## Healthcheck

`HEALTHCHECK` opens a TCP connection to `$PORT` and closes it. Liveness only.

This is deliberate on privacy grounds, not laziness:

- **There is no health route.** The API exposes exactly six paths, all POST
  operations (`apps/backend/src/api.ts:105-110`); anything else is rejected.
  Adding one is the Backend lane's call, not the deployment lane's.
- **Probing a real route would be actively harmful.** Every request takes a
  slot in the *global* aggregate rate window shared with real players
  (`apps/backend/src/api.ts:93-96`, D-026), and a probe every 30 seconds is a
  per-request event the platform would record — the thing D-014 forbids.

A TCP connect consumes no rate budget, carries no request material, and
produces no log line. If deeper health signal is needed later, the right shape
is a route that reports `AggregateMetrics.snapshot()`
(`apps/backend/src/metrics.ts:16`) and is exempted from the rate limiter and
from platform access logging — a Backend-lane change with a D-014 review.

---

## Rollback

**web.** Redeploy the previous `dist/` (or the previous immutable
deployment `[HOST]`). Assets are content-hashed, so a rollback that restores
the old `index.html` restores a consistent bundle. Verify the rolled-back
origin still sends no isolation headers before declaring the rollback good.

**backend.** Redeploy the previous image digest. Two constraints:

- `FEE_AUTHORIZATION_SECRET` must be unchanged across the rollback, or every
  in-flight fee authorization fails verification
  (`apps/backend/src/authorization.ts:79`) and players see failures rather than
  a clean rollback.
- Rolling back does not undo an on-chain submission. Nothing here is
  transactional with the chain.

**Fastest safe action is usually not a rollback.** Flip a kill switch first —
it is an environment change with no build, and it fails closed.

---

## Kill switches

Three levels, all configuration, all fail-closed. None has a public fallback:
an unavailable private route means a **locked building**, never a public
transaction (D-018). That is the design, not a degradation.

| Level | Control | Effect |
|---|---|---|
| Global | `BackendConfig.globalEnabled = false` | every private route returns `503 SERVICE_DISABLED` (`apps/backend/src/api.ts:97-100`). The city stays up; financial doors lock. |
| Per route | `routes.<transfer\|unshield\|swap>.enabled = false` | that building alone locks. `RoutePolicy.enabled`, `apps/backend/src/types.ts:17`. |
| Sponsorship | `sponsorshipBudget.maxFeeAmount` → `0` | sponsorship stops without taking the game down (D-006). Rejections increment `budgetExhausted` only. |

Also available as ceilings rather than switches: `routes.<r>.maxRelayFee`
(reject anything above a fee ceiling) and `routes.<r>.allowedTokens`.

**How to flip one `[HOST]`:** update the corresponding environment value in
the host's secret/config store and restart or redeploy the backend process.
`apps/backend/src/environment.ts` parses the value before the listener binds;
an invalid setting fails startup rather than silently widening a route.

**Kill-switch drill:** flip → restart → confirm the affected route
returns 503 → confirm the unaffected routes still work → confirm the city and
lobby are unaffected → confirm the client shows a locked building rather than
an error toast.

---

## Logging and monitoring

**Policy: aggregate counters only. No per-request record of IP, call, proof,
timing, recipient or transaction hash** (D-014).

The code complies today, and this is verifiable rather than asserted:

- Zero logging calls under `apps/backend/src`. The only match for
  `console.` / `process.stdout` / `process.stderr` / `logger` in the whole
  directory is the comment at `apps/backend/src/http.ts:12` stating that the
  edge deliberately has no access logger, client identifier, CORS reflection or
  request persistence.
- No request-logging middleware is enabled, because there is no middleware
  chain at all. `createBackendFetchHandler()` (`apps/backend/src/http.ts:15`)
  is a single closure that passes only `{method, path, body, signal}` into the
  core (`apps/backend/src/http.ts:48-53`) — the signal carries cancellation,
  not identity.
- `AggregateMetrics` (`apps/backend/src/metrics.ts:1-26`) holds six integer
  counters and nothing else: `requests`, `successes`, `failures`,
  `rateLimited`, `budgetExhausted`, `queueRejected`. There is no map, no key,
  no request field.
- The container writes to stdout at startup and on fatal error only
  (`deploy/backend/launch.mjs`). **Anything on stdout during steady-state
  traffic is a defect** — treat it as an incident, not noise.

**The remaining risk is the platform, not the code.** A default access log that
records IP, path or latency violates D-014 even though this container is
silent. Before the service takes traffic `[HOST]`:

- Disable the platform/CDN/proxy access log for the backend routes, or
  confirm it records neither client IP nor path.
- Set no `NODE_OPTIONS`, `NODE_DEBUG`, APM key or tracing endpoint. An
  auto-injected agent is a per-request observer.
- Confirm the platform does not retain request bodies for debugging.
- Confirm error/crash reporting does not capture request context.

**Alerting** should watch `budgetExhausted` and `rateLimited` — counters only,
never the triggering request (D-026).

---

## Secret rotation

Three secrets. All are injected at run time from the secret store `[HOST]`;
none is in git, a Dockerfile or a build arg. Placeholders and custody notes are
in `.env.production.example`.

**General shape: mint the new one, deploy, verify, revoke the old one.**
Revoke-then-mint is an outage.

### RPC key (`STARKNET_RPC_URL`)

Server-side; the key is embedded in the URL, so the whole URL is the secret.
Not domain-allowlistable — a server request sends no `Origin` — so restrict by
IP or provider-side key scoping.

1. Mint a second key with the provider.
2. Update the secret, redeploy, confirm `/v1/rpc/pool-config` still answers.
3. Revoke the first key.

Compromise: revoke immediately and accept the outage. A leaked read key lets a
third party see nothing of ours, but it is our bill and our rate limit.

### AVNU paymaster key (`AVNU_PAYMASTER_API_KEY`)

**Highest-value secret in the deployment — it spends our money.** It is the
reason the backend exists: it cannot ship to a browser (D-013, D-014).

1. Set `sponsorshipBudget.maxFeeAmount` to `0` first — stops the bleed without
   taking the game down.
2. Request a replacement key from AVNU. Lead time is unknown; find out before
   you need it.
3. Update the secret, redeploy, restore the budget, confirm a sponsored action.
4. Revoke the old key with AVNU.

Compromise: budget to zero first, then rotate. Do not wait for the new key.

### Fee authorization secret (`FEE_AUTHORIZATION_SECRET`)

Generated by us (`openssl rand -base64 48`; minimum 32 characters or the
constructor throws — `apps/backend/src/authorization.ts:49`). It signs the
stateless authorization binding route, fee token, amount and block window;
forging it forges a sponsorship grant.

Rotating invalidates every in-flight authorization, so players mid-action see a
failure. The authorization is block-window-bound and short-lived, so the
blast radius is small but non-zero. Prefer a low-traffic window; a
dual-secret overlap (verify against old and new, issue with new) would remove
the gap and does not exist today — `HmacAuthorizationCodec` takes a single
secret (`apps/backend/src/authorization.ts:48`, guard at `:49`).

Compromise: rotate immediately and accept the failed in-flight actions.

### Also rotate on rotation day

`VITE_STARKNET_RPC_URL` is **published by design** — Vite compiles it into the
bundle served to every player. It is not a secret and rotating it is not an
incident response; keep it domain-allowlisted and scoped to reads that are
already public and unlinkable.

---

## D-005 in production

`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` must never be sent by the static
host, the backend, the CDN, or any proxy between them. They break the
postMessage popups and cross-origin iframes web wallets use; the standards fix
ships in no browser; and we do no in-browser proving, so we never need them.
The failure mode is silent — the app builds and serves, and wallet connect
stops working (D-005).

Enforced by `scripts/check-headers.mjs`, wired into CI as the `headers` job:

1. **Static** — no non-comment line in any non-markdown file may introduce
   one. Verified to catch a `vite.config.ts` `preview.headers` entry and a
   `<meta http-equiv>` in `index.html`.
2. **Live** — builds `apps/web` for production, serves the real artifact with
   `vite preview`, and asserts every response (HTML and every emitted asset)
   carries neither header. This exercises the project's own serving config for
   real, not a mock.

**What it does not prove.** `vite preview` is not the production host. Two
follow-ups once a provider is chosen:

- Add the host's header config files to `CONFIG_ROOTS` in
  `scripts/check-headers.mjs` (the list already names the usual candidates).
- Re-run the header assertions against the deployed origin as a post-deploy
  gate. A CDN or WAF can add headers no repository file mentions.

`scripts/check-invariants.sh:29` is the cheaper sibling check: it greps
`packages` and `apps` for the same header names, comments included.

---

## The same-origin constraint

**The backend must be served from the same origin as the web app.** This is not
a preference.

The backend edge emits no CORS headers and reflects no `Origin`
(`apps/backend/src/http.ts:12-13`) — deliberately, since reflecting an origin
is a client-identifying behaviour. `BackendPrivacyClient`
(`packages/privacy/src/wallet-api/backend-client.ts:13`) takes a base URL and
`fetch`es it from the browser. A cross-origin base URL such as
`https://api.example.com` is blocked by the browser and every private action
fails.

So the hosting choice must produce one origin serving both: a path prefix
(`/api`) on the web origin, backed by a reverse proxy or platform rewrite to
the container. Choosing a static host and a container host that cannot be
combined behind one origin is a rework, not an inconvenience. Any such proxy
must also be checked for access logging (D-014) and for isolation headers
(D-005).

---

## Remaining Backend operations work

The production composition root, strict configuration loader and logging-free
HTTP listener are present. These deployment/observability items remain open:

1. **No health endpoint.** See [Healthcheck](#healthcheck). TCP-only liveness is
   intentional until a deeper signal can pass D-014 review.
2. **No metrics exposure.** `AggregateMetrics.snapshot()`
   (`apps/backend/src/metrics.ts:16`) exists and is on no route, so the
   D-026 alert on `budgetExhausted` has nothing to read.
3. **Multi-instance caveat (already noted in D-026).** `AggregateRateLimiter`
   and `AggregateBudget` (`apps/backend/src/metrics.ts:61`, `:37`) are
   process-local. Two instances means two budgets. Run a single
   admission-control instance, or supply the atomic adapters
   `BackendApiOptions.rateLimiter` / `.sponsorshipBudget`. A shared aggregate
   store must hold counters only — never a per-request key.

The listener has no health, CORS or access-log path. Do not add one as a host
convenience: it is a Backend-lane change with a privacy review.

---

## Not verified on this branch

Stated plainly so nobody reads more assurance into this document than it earns:

- **`docker build` has not been run.** Docker is unavailable in the environment
  this branch was authored in. The TypeScript emit step the image depends on
  *was* run and verified (`npx tsc -p deploy/backend/tsconfig.build.json`
  compiles cleanly, and the emitted ESM loads under Node with all 17 exports
  intact). The Dockerfile itself needs one `docker build` on a machine that has
  Docker before it is trusted.
- **No end-to-end deploy has happened**, because no host exists.
- **`apps/web/index.html`** was added by this lane because a production build
  needs an entry module and there was none. It is scaffolding; the Shell lane
  owns the real markup.

---

## DECISIONS-NEEDED

The project lead must choose the following. Each blocks work that is otherwise
ready. Trade-off notes are neutral and name no vendor.

1. **Hosting provider for the backend container.**
   The image is host-agnostic and runs anywhere that takes a container.
   Trade-offs: a platform that scales to zero adds cold-start latency to a
   request already bounded by proof validity and quote expiry; a
   platform-managed edge is one more place access logging and headers must be
   audited (D-005, D-014); running more than one instance requires resolving
   the D-026 aggregate-store caveat first, so "just autoscale" is not free.

2. **Static hosting for `apps/web`.**
   Output is `apps/web/dist/` — plain static files, no server runtime.
   Trade-offs: any static host works; the deciding factor is whether it can be
   combined with the backend behind one origin (item 4) and whether its default
   headers can be fully controlled.

3. **Domain.**
   Needed before the browser RPC key can be domain-allowlisted (item 7), before
   `VITE_LOBBY_URL` can be set, and before any TLS or origin decision.

4. **How the web origin and the backend are combined into ONE origin.**
   Forced by the same-origin constraint above — the backend sends no CORS
   headers, on purpose. Options are a platform rewrite/proxy from the static
   host to the container, or a reverse proxy in front of both. This is an input
   to items 1 and 2, not a follow-up: picking a static host and a container
   host that cannot be unified behind one origin means redoing both. Whatever
   sits in the middle must also be audited for access logging and for
   isolation headers.

5. **Secret-custody mechanism.**
   Three secrets need somewhere to live: `AVNU_PAYMASTER_API_KEY`,
   `STARKNET_RPC_URL` and `FEE_AUTHORIZATION_SECRET`. Requirements, not
   preferences: run-time injection as environment variables (never build args
   or image layers), rotation without a rebuild, and no secret reachable from
   the static build environment — the web build must never be able to read the
   paymaster key. Trade-off: platform-native secret storage is fewer moving
   parts and ties custody to the hosting choice; a dedicated secret manager is
   portable across hosting changes and adds an integration.

6. **AVNU paymaster API key procurement.**
   Who requests it from AVNU, under what account, and what the lead time is.
   Also needed: whether a second key can exist concurrently — the rotation
   runbook above assumes mint-then-revoke, and if AVNU issues only one key at a
   time then every rotation is an outage and the runbook changes. This is the
   secret that spends our money, so it should be the first one whose rotation
   path is confirmed rather than assumed.

7. **Domain-allowlisted RPC key(s).**
   Two distinct keys are needed and they are not interchangeable:
   - **Browser** (`VITE_STARKNET_RPC_URL`) — compiled into the public bundle
     and shipped to every player, so a domain allowlist is the only control
     that exists. Requires item 3.
   - **Server** (`STARKNET_RPC_URL`) — not domain-allowlistable, because a
     server request sends no `Origin`. Restrict by IP or provider-side key
     scoping instead.
   The provider must therefore support both a domain allowlist *and* a
   server-side restriction, and the plan should state which reads stay in the
   browser. D-014's position is that anything linking player IP to intended
   recipient or timing goes through the backend proxy.

Related open item, not a decision: the implemented standalone lobby server has
no production host yet. `packages/lobby` exposes the privacy-minimal Colyseus
server and the web composition consumes `VITE_LOBBY_URL`; local development is
verified on `ws://localhost:2567`. Production still needs a TLS-capable host,
an explicit browser-origin allowlist, proxy access-log review and a `wss://`
endpoint built into the web bundle after the domain is chosen.
