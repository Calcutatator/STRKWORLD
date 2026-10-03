# One-Machine Fly composition image. Build from the repository root:
#   docker build -f deploy/fly/Dockerfile -t strkworld-fly .

ARG NODE_IMAGE=node:22.12-alpine

FROM ${NODE_IMAGE} AS build
WORKDIR /repo

COPY package.json package-lock.json tsconfig.json ./
COPY apps/backend/package.json apps/backend/
COPY apps/web/package.json apps/web/
COPY packages/bridge/package.json packages/bridge/
COPY packages/lobby/package.json packages/lobby/
COPY packages/privacy/package.json packages/privacy/
COPY packages/shared/package.json packages/shared/
COPY packages/world/package.json packages/world/
RUN npm ci

ARG VITE_LOBBY_URL
RUN test -n "$VITE_LOBBY_URL"

# The other public browser build values. Vite reads them from the build
# environment, and builders that pass service variables as build arguments
# (Railway does, for declared ARGs) set them here. Every one ends up in the
# public bundle, so none may be a secret; unset keeps the production parser's
# deny-all default for that route.
ARG VITE_WALLET_MODE
ARG VITE_STARKNET_CHAIN_ID
ARG VITE_STARKNET_RPC_URL
ARG VITE_BACKEND_BASE_URL
ARG VITE_STRK20_SHIELD_ENABLED
ARG VITE_STRK20_SHIELD_MAX_INTENTS
ARG VITE_STRK20_SHIELD_ALLOWED_TOKENS
ARG VITE_STRK20_TRANSFER_ENABLED
ARG VITE_STRK20_TRANSFER_MAX_INTENTS
ARG VITE_STRK20_TRANSFER_MAX_RELAY_FEE
ARG VITE_STRK20_TRANSFER_ALLOWED_TOKENS
ARG VITE_STRK20_UNSHIELD_ENABLED
ARG VITE_STRK20_UNSHIELD_MAX_INTENTS
ARG VITE_STRK20_UNSHIELD_MAX_RELAY_FEE
ARG VITE_STRK20_UNSHIELD_ALLOWED_TOKENS
ARG VITE_STRK20_STAKE_ENABLED
ARG VITE_STRK20_STAKE_MAX_RELAY_FEE
ARG VITE_STRK20_STAKE_ALLOWED_TOKENS
# D-077: the Vault's switch and its STRK-only list. Unset, the Vault stays locked.
ARG VITE_STRK20_VAULT_ENABLED
ARG VITE_STRK20_VAULT_ALLOWED_TOKENS
# D-083: the Borrow counter's switch. Unset, its counter stays locked.
ARG VITE_STRK20_BORROW_ENABLED
# D-085: Endur unstaking through a shadow account. Unset, unstaking stays shut.
ARG VITE_STRK20_UNSTAKE_ENABLED
# D-084: the private swap's switch, its list, its slippage and the degen
# floor's switch. Unset, the Exchange and the degen floor stay locked.
ARG VITE_STRK20_SWAP_ENABLED
ARG VITE_STRK20_SWAP_ALLOWED_TOKENS
ARG VITE_STRK20_SWAP_SLIPPAGE_BPS
ARG VITE_STRK20_SWAP_DEGEN_ENABLED
# D-126: the degen floor's own, wider slippage and oracle limits. Unset, that
# floor uses 800 bps (8%) and 1200 bps (12%); the Exchange keeps 3% and 3%.
ARG VITE_STRK20_SWAP_DEGEN_SLIPPAGE_BPS
ARG VITE_STRK20_SWAP_DEGEN_ORACLE_BPS
# D-116: the private leaderboard's ReceiptLedger contract address. Unset, no
# action carries a receipt and the leaderboard stand stays shut.
ARG VITE_STRK20_LEADERBOARD_LEDGER
# Leaderboard phase 1: the web side's switch. Only `true`, with the ledger set,
# adds receipts, ticks and the placement stand.
ARG VITE_STRK20_LEADERBOARD_ENABLED
# D-069: test deployments only. Unset, as on every launch, the debug logger is
# not compiled into the bundle at all.
ARG VITE_DEBUG_LOGS
# Temporary testing switch: true skips D-072's pool-balance entry check.
ARG VITE_ENTRY_GATE_BYPASS

COPY apps apps
COPY packages packages
COPY deploy/fly deploy/fly
RUN VITE_LOBBY_URL="$VITE_LOBBY_URL" node deploy/fly/check-static.mjs --validate-only "$VITE_LOBBY_URL" \
 && VITE_LOBBY_URL="$VITE_LOBBY_URL" npm run build --workspace=@strkworld/web \
 && node deploy/fly/check-static.mjs apps/web/dist "$VITE_LOBBY_URL" \
 && npx tsc -p deploy/fly/tsconfig.build.json
RUN printf '%s' "$VITE_LOBBY_URL" > /repo/.fly-built-lobby-url

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
RUN npm ci --omit=dev --include-workspace-root

FROM ${NODE_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

# Workspace imports used by the compiled server resolve through this runtime
# dependency tree; no source or secret is copied into the final image.
COPY --from=runtime-deps --chown=node:node /repo/node_modules ./node_modules
COPY --from=build --chown=node:node /repo/.fly-build ./build
COPY --from=build --chown=node:node /repo/apps/web/dist ./web-dist
# Build-owned public metadata. Runtime environment injection cannot replace
# this file, so startup can verify which lobby origin the browser actually has.
COPY --from=build /repo/.fly-built-lobby-url ./build-metadata/lobby-url
# npm workspaces install @strkworld/shared as a symlink to the source tree,
# which is absent from this minimal runtime image. Replace that link with the
# compiled, self-contained package so Node can resolve the production lobby's
# workspace import in the final image.
RUN rm -f node_modules/@strkworld/shared
COPY --from=build --chown=node:node /repo/.fly-build/packages/shared ./node_modules/@strkworld/shared
RUN printf '{"type":"module","main":"./src/index.js","exports":{".":"./src/index.js"}}\n' > node_modules/@strkworld/shared/package.json
RUN printf '{"type":"module"}\n' > package.json

USER node
EXPOSE 8080
CMD ["node", "--disable-proto=throw", "build/deploy/fly/src/main.js"]
