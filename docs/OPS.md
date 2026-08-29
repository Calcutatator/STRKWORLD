# Operations runbook

**Status: Fly.io topology selected; provider account, domain and secret store
are not configured.** The target is one public Fly app/Machine with a small
edge/composition process serving the web build and routing same-origin `/api`
and the lobby WebSocket (D-045). Everything that depends on account,
credentials or domain remains marked `[HOST]` and listed in
[DECISIONS-NEEDED](#decisions-needed).

Three deployables:

| | What | Built by | Runs as |
|---|---|---|---|
| **web** | `apps/web` — the static shell | `deploy/fly/Dockerfile` (Vite workspace build) | static files served by the Fly edge/composition process `[HOST]` |
| **backend** | `apps/backend` — paymaster custody, RPC proxy, submission queue | `deploy/fly/Dockerfile` (standalone `deploy/backend/Dockerfile` remains available) | one private child in the Fly Machine `[HOST]` |
| **lobby** | `packages/lobby` — privacy-minimal Colyseus presence | `deploy/fly/Dockerfile` + `deploy/fly/tsconfig.build.json` | one private Node child behind the same app's `wss://` route `[HOST]` |

The web and backend must share an origin. D-045 selects a single Fly app with
an edge/composition process routing `/api` and `wss` while preserving this
constraint. The lobby remains privacy-minimal, has an explicit browser-origin
allowlist, and does not receive cookies or financial data.

---

## Build outputs

Verified on this branch with Node 25.9.0 / npm 11.12.1.

| Command | Output | Notes |
|---|---|---|
| `npm run build` | delegates to workspaces via `--if-present` | only `@strkworld/web` has a build script |
| `npm run build --workspace=@strkworld/web` | `apps/web/dist/` | `dist/index.html` + `dist/assets/index-<hash>.js` |
| `npx tsc -p deploy/backend/tsconfig.build.json` | `.docker-build/apps/backend/src/*.js` | backend image only; container-only; gitignored |
| `npx tsc -p deploy/fly/tsconfig.build.json` | `.fly-build/{deploy/fly,apps/backend,packages/{lobby,shared}}/**/*.js` | Fly composition image; container-only; gitignored |

`apps/web/dist/` is what the static host serves. Content-hashed asset
filenames mean assets can be cached immutably and `index.html` must not be.

**`apps/backend` produces no build output in-tree.** It has no build script and
the repo `tsconfig.json` sets `noEmit`; `apps/backend/package.json:6` points
`main` at `./src/index.ts`, i.e. the package is consumed as TypeScript source.
The container compiles its own JavaScript via
`deploy/backend/tsconfig.build.json` rather than adding a build script to
another lane's package.

**`packages/lobby` is production-composed but not host-verified.** The Fly
Dockerfile emits the lobby and shared workspace packages as JavaScript and
starts the lobby as a private child of the edge. The edge forwards only an
explicit safe matchmaking header set, strips credentials, and requires the
configured `FLY_PUBLIC_ORIGIN` on every WebSocket upgrade. Docker, Fly TLS,
access-log behavior and a live `wss://` session remain host gates. Run exactly
one Colyseus server per process because its matchmaker is process-global.

---

## Deploy

### Supply-chain gates

Every remote GitHub Action in `.github/workflows/*.yml` is pinned to a full
lowercase 40-character commit SHA. The readable release comment beside each pin
is for humans; the SHA is the authority. Remote references must use slash-
separated ASCII letters, digits, `_`, `.`, or `-` for the owner, repository and
optional action subdirectories. `node scripts/check-supply-chain.mjs` runs in
the Invariants job and fails any tag, branch, abbreviated SHA or malformed
remote `uses:` reference while allowing repository-local `./` actions.
`docker://` steps are outside this repository policy and fail even when the
image uses a digest.

It parses workflow YAML structurally at GitHub's action-reference positions —
`jobs.<id>.uses` and `jobs.<id>.steps[*].uses` — so flow mappings, quoted or
escaped keys, explicit keys and aliases cannot bypass validation. Comments,
command text and literal `uses` inputs under `env` or `with` remain inert.
Invalid YAML, YAML `<<` merge keys in the workflow root, jobs collection, job
maps or step maps, and non-string action references fail closed. GitHub
currently rejects those merge keys; the explicit denial also prevents a future
syntax change from silently bypassing this scanner. The Invariants job installs
the committed tooling lockfile with lifecycle scripts disabled before running
the exact dev-only `yaml@2.9.0` parser.

The Verify job also runs `npm audit --omit=dev --audit-level=high` immediately
after `npm ci`. That is a recurring registry-advisory gate over production
dependencies only. It is not an application security review, an SBOM,
provenance evidence or a claim that development-only tooling has no advisory.
Those broader launch controls remain separate work.

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
`deploy/backend/launch.mjs` exits 78 only when the compiled entry is absent,
is not a regular file, or its exact target becomes missing, a directory or
unreadable during entry admission. Backend and nested-dependency failures remain
ordinary startup crashes. The package-local `launch-loader.mjs` witnesses only
resolver/loader failures before module evaluation, so a Backend-thrown error
with identical public fields cannot be reclassified as deployment configuration.

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

`HmacAuthorizationCodec` takes exactly one secret
(`apps/backend/src/authorization.ts:48`, guard at `:49`). Rotation therefore
requires a coordinated secret replacement and backend restart or redeploy;
there is no overlap window. Every unconsumed authorization issued under the
old secret then fails verification. The authorization is block-window-bound
and short-lived, so the blast radius is small but non-zero. Saved Bridge
evidence and an already accepted transaction hash are not HMAC fee
authorizations and are unaffected. A dual-secret rollout (verify against old
and new, issue with new) would require a new reviewed implementation and
decision; do not infer that support from this runbook. Prefer a low-traffic
window.

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

## Deployment evidence and remaining gaps

Stated plainly so nobody reads more assurance into this document than it earns:

- **Both production images now build and boot-smoke in hosted GitHub CI.** At
  commit `375bad4`, run
  [32282522737](https://github.com/Calcutatator/STRKWORLD/actions/runs/32282522737),
  deployment job
  [96164346536](https://github.com/Calcutatator/STRKWORLD/actions/runs/32282522737/job/96164346536),
  completed in 1m12s with both deploy typechecks, both image builds and both
  image smokes green. Each smoke uses `--network none`, inert syntactically
  valid configuration with the Backend and financial routes disabled, no
  port/volume/env-file/log export, and verifies image user `node` plus PID-1
  effective UID 1000. Fly's in-container probe requires `/` = 200 and
  `/health` plus `/metrics` = 404 before a bounded clean stop. The standalone
  Backend uses only an in-container TCP connect, makes no API request and now
  closes its `RunningBackendServer` once before bounded exit `0`.
- **This is image-lifecycle evidence, not service or funded-route evidence.**
  Network quarantine means the smokes make no real RPC, AVNU or API call and
  use no secret. They do not verify TLS, platform access-log policy, real
  provider credentials/controls, staging, deployment, wallet behavior,
  paymaster acceptance or funded mainnet execution. The earlier run
  [32279807295](https://github.com/Calcutatator/STRKWORLD/actions/runs/32279807295)
  remains the historical failing signal test superseded by D-050 and the
  successful hosted run above.
- **No end-to-end deploy has happened**, because no host exists.
- **`apps/web/index.html`** was added by this lane because a production build
  needs an entry module and there was none. It is scaffolding; the Shell lane
  owns the real markup.

---

## DECISIONS-NEEDED

The project lead must supply or approve the following operational inputs. Each
blocks work that is otherwise ready. D-045 selects one public Fly app/Machine,
but it still contains three logical components — web serving, backend API and
lobby presence — whose composition and lifecycle must be implemented and
verified. Trade-off notes are neutral and name no vendor.

1. **Fly account, domain and deployment configuration.**
   D-045 selects the topology but does not create an account, purchase a
   domain, upload secrets or deploy. Those operational actions remain gated on
   explicit values and permissions.

2. **Domain.**
   Needed before the browser RPC key can be domain-allowlisted (item 6), before
   `VITE_LOBBY_URL` can be set, and before any TLS or origin decision.

3. **Fly edge/composition host verification.**
   The selected topology is implemented in `deploy/fly`; its image serves
   `apps/web/dist/` and routes `/api`, credential-free matchmaking HTTP, and
   origin-gated lobby WebSockets through one origin. Staging must verify Fly
   access logging, TLS, `FLY_PUBLIC_ORIGIN`, exactly-one-Machine overlap and
   isolation headers before traffic.

4. **Secret-custody mechanism.**
   Three secrets need somewhere to live: `AVNU_PAYMASTER_API_KEY`,
   `STARKNET_RPC_URL` and `FEE_AUTHORIZATION_SECRET`. Requirements, not
   preferences: run-time injection as environment variables (never build args
   or image layers), rotation without a rebuild, and no secret reachable from
   the static build environment — the web build must never be able to read the
   paymaster key. Trade-off: platform-native secret storage is fewer moving
   parts and ties custody to the hosting choice; a dedicated secret manager is
   portable across hosting changes and adds an integration.

5. **AVNU paymaster API key procurement.**
   Who requests it from AVNU, under what account, and what the lead time is.
   Also needed: whether a second key can exist concurrently — the rotation
   runbook above assumes mint-then-revoke, and if AVNU issues only one key at a
   time then every rotation is an outage and the runbook changes. This is the
   secret that spends our money, so it should be the first one whose rotation
   path is confirmed rather than assumed.

6. **Alchemy RPC account, keys and domain/IP controls.**
   D-046 selects Alchemy provisionally, but no account or key exists yet. Use
   separate browser/public and server/private applications or keys.
   Two distinct keys are needed and they are not interchangeable:
   - **Browser** (`VITE_STARKNET_RPC_URL`) — compiled into the public bundle
     and shipped to every player, so a domain allowlist is the only control
     that exists. Requires item 2 and the item 3 edge/composition host
     verification.
   - **Server** (`STARKNET_RPC_URL`) — not domain-allowlistable, because a
     server request sends no `Origin`. Restrict by IP or provider-side key
     scoping instead.
   Alchemy documents domain and IPv4 allowlists, but the selected plan and
   deployment-edge source-IP behavior must be verified before production.
   Confirm quotas, method/version support, 429 behavior, retention and
   rotation. `scripts/check-drift.sh` remains a read-only protocol canary and
   defaults to an open Lava endpoint only when no explicit RPC URL is injected;
   it is not Alchemy assurance. D-014's position is that anything linking player IP to intended
   recipient or timing goes through the backend proxy.

Related open item, not a decision: no production host or live deploy exists
yet. `packages/lobby` exposes the privacy-minimal Colyseus server and the Fly
composition consumes `VITE_LOBBY_URL`; local development is verified on
`ws://localhost:2567`. Production still needs a TLS-capable Fly app, the
runtime `FLY_PUBLIC_ORIGIN`/`LOBBY_ALLOWED_ORIGINS` values, proxy access-log
review and a live `wss://` session after the domain is chosen.
