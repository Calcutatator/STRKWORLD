# STRKWORLD backend container.
#
# Build from the REPOSITORY ROOT — the build needs the workspace lockfile:
#   docker build -f deploy/backend/Dockerfile -t strkworld-backend .
#
# ---------------------------------------------------------------------------
# D-005 — cross-origin isolation headers
# ---------------------------------------------------------------------------
# This service must never send `Cross-Origin-Opener-Policy: same-origin` or
# `Cross-Origin-Embedder-Policy: require-corp`, and neither must whatever
# proxy, CDN or platform edge sits in front of it. They break the postMessage
# popups and cross-origin iframes that web wallets use to talk to the page,
# and the standards fix (`COOP: restrict-properties`) ships in no browser. We
# do no in-browser proving, so we never need them. The failure is silent: the
# app still builds and serves, and wallet connect just stops working.
# See docs/DECISIONS.md D-005. Enforced by scripts/check-headers.mjs; when a
# host is chosen, add its header config to that script's CONFIG_ROOTS.
#
# ---------------------------------------------------------------------------
# D-014 — logging policy
# ---------------------------------------------------------------------------
# Aggregate counters only. Nothing in this image logs per-request IPs, calls,
# proofs, timings, recipients or transaction hashes, and the application code
# emits no log line at all (verified: the only match for `console.`/`process.
# stdout` under apps/backend/src is the comment at apps/backend/src/http.ts:12
# saying the edge deliberately has no access logger).
#
# Two things are therefore on the DEPLOYMENT, not the code:
#   1. The platform's own access log. A default access log that records IP,
#      path or latency violates D-014 even though this container is silent.
#      It must be disabled for these routes before the service takes traffic.
#   2. `NODE_OPTIONS`, `NODE_DEBUG` and any APM/tracing agent are left unset
#      on purpose. An injected agent is a per-request observer.
# The container therefore writes to stdout only at startup and on fatal error.
# Anything appearing on stdout during steady-state traffic is a defect.

# Node 22.12 is the repository floor (D-025): AVNU SDK 4.2.0 requires Node 22,
# and Vite supports Node 22 from 22.12. Overridable so the tag can be pinned to
# a digest at release time — see docs/OPS.md.
ARG NODE_IMAGE=node:22.12-alpine

# --------------------------------------------------------------- build stage
FROM ${NODE_IMAGE} AS build
WORKDIR /repo

# Manifests first so the dependency layer caches independently of source.
COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/
COPY apps/web/package.json apps/web/
COPY packages/bridge/package.json packages/bridge/
COPY packages/lobby/package.json packages/lobby/
COPY packages/privacy/package.json packages/privacy/
COPY packages/shared/package.json packages/shared/
COPY packages/world/package.json packages/world/

# ci, not install — reproducible from the committed lockfile.
RUN npm ci

COPY tsconfig.json ./
COPY apps/backend/tsconfig.json apps/backend/
COPY apps/backend/src apps/backend/src
COPY deploy/backend/tsconfig.build.json deploy/backend/

# The backend package has no build script and the repo tsconfig sets `noEmit`
# (it is consumed as TypeScript source). Emit JavaScript for the runtime here
# rather than adding a build script to another lane's package.
RUN npx tsc -p deploy/backend/tsconfig.build.json \
 && printf '{"type":"module"}' > .docker-build/package.json

# ------------------------------------------------------------ runtime deps
FROM ${NODE_IMAGE} AS runtime-deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY apps/backend/package.json apps/backend/
COPY apps/web/package.json apps/web/
COPY packages/bridge/package.json packages/bridge/
COPY packages/lobby/package.json packages/lobby/
COPY packages/privacy/package.json packages/privacy/
COPY packages/shared/package.json packages/shared/
COPY packages/world/package.json packages/world/
RUN npm ci --omit=dev --workspace=@strkworld/backend --include-workspace-root

# ------------------------------------------------------------- final stage
FROM ${NODE_IMAGE} AS runtime

# `node` (uid/gid 1000) ships with the official image. Never run as root: this
# process holds the paymaster key and the fee-authorization HMAC secret.
WORKDIR /app

ENV NODE_ENV=production
# Non-secret default. The platform overrides it; the app must bind 0.0.0.0.
ENV PORT=8080

# NO SECRET MAY APPEAR IN THIS FILE OR IN ANY BUILD ARG. Build args and ENV
# lines are baked into the image and readable via `docker history`. Every
# secret — AVNU_PAYMASTER_API_KEY, STARKNET_RPC_URL, FEE_AUTHORIZATION_SECRET —
# is injected at run time from the platform's secret store. See
# .env.production.example and docs/OPS.md.

COPY --from=runtime-deps --chown=node:node /repo/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/.docker-build ./
COPY --chown=node:node deploy/backend/launch.mjs ./launch.mjs

USER node
EXPOSE 8080

# HEALTHCHECK: TCP connect only, deliberately.
#
# This is a LIVENESS check ("is the listener accepting connections"), not a
# readiness or dependency check, for two reasons that are privacy constraints
# rather than preferences:
#   - The backend exposes no health route. Its six paths are all POST
#     operations (apps/backend/src/api.ts:105-110). Adding one belongs to the
#     Backend lane; see docs/OPS.md "Open items for the Backend lane".
#   - Probing a real route would be worse than useless. Every request consumes
#     the D-026 global aggregate rate window shared with real players, and a
#     probe every 30s is a per-request event the platform would log — exactly
#     what D-014 forbids.
# A TCP connect consumes no rate budget, carries no request material, and
# produces no log line.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "const net=require('node:net');const s=net.connect(Number(process.env.PORT),'127.0.0.1');s.on('connect',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1));s.setTimeout(2500,()=>process.exit(1));"

# launch.mjs verifies the compiled composition root exists and starts it. It
# holds no configuration and no business logic — see the file for why it
# exists and what the Backend lane still owes.
CMD ["node", "--disable-proto=throw", "launch.mjs"]
