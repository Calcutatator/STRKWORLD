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

COPY apps apps
COPY packages packages
COPY deploy/fly deploy/fly
RUN VITE_LOBBY_URL="$VITE_LOBBY_URL" node deploy/fly/check-static.mjs --validate-only "$VITE_LOBBY_URL" \
 && VITE_LOBBY_URL="$VITE_LOBBY_URL" npm run build --workspace=@strkworld/web \
 && node deploy/fly/check-static.mjs apps/web/dist "$VITE_LOBBY_URL" \
 && npx tsc -p deploy/fly/tsconfig.build.json

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
RUN printf '{"type":"module"}\n' > package.json

USER node
EXPOSE 8080
CMD ["node", "--disable-proto=throw", "build/deploy/fly/src/main.js"]
