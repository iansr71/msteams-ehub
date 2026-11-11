# One image for every service: the answer API, the Teams bot and the indexer jobs differ only in
# the command they run (set by the Container App or job, docs/infrastructure.md).
#
# Build in Azure, so nothing needs Docker locally:
#   az acr build --registry <acr> --image ehub:<tag> --build-arg NODE_IMAGE=<pinned image> .
#
# Pin NODE_IMAGE by digest for production builds (node:22-bookworm-slim@sha256:...), so a rebuild
# of the same commit uses the same base.

ARG NODE_IMAGE=node:22-bookworm-slim

# --- Production dependencies only -------------------------------------------------------------
FROM ${NODE_IMAGE} AS prod-deps
ENV CI=true
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/moodle-client/package.json packages/moodle-client/
COPY apps/indexer/package.json apps/indexer/
COPY apps/api/package.json apps/api/
COPY apps/teams-app/package.json apps/teams-app/
RUN pnpm install --frozen-lockfile --prod

# --- Build ------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS build
ENV CI=true
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build

# --- Runtime ----------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    API_HOST=0.0.0.0 \
    PORT=3000 \
    TEAMS_BOT_PORT=3978
WORKDIR /app

# Dependencies first (they change less often), then compiled output only: no TypeScript source,
# tests, fixtures or .env files reach the image.
COPY --from=prod-deps --chown=root:root /app ./
COPY --from=build --chown=root:root /app/packages/shared/dist packages/shared/dist
COPY --from=build --chown=root:root /app/packages/moodle-client/dist packages/moodle-client/dist
COPY --from=build --chown=root:root /app/apps/indexer/dist apps/indexer/dist
COPY --from=build --chown=root:root /app/apps/api/dist apps/api/dist
COPY --from=build --chown=root:root /app/apps/api/admin-ui apps/api/admin-ui
COPY --from=build --chown=root:root /app/apps/teams-app/dist apps/teams-app/dist

# State lives on the mounted share (/mnt/state), never in the image. The code is owned by root
# and read-only to the service user.
RUN mkdir -p /mnt/state && chown node:node /mnt/state
USER node

EXPOSE 3000 3978
# Commands: API `node apps/api/dist/cli.js serve`; bot `node apps/teams-app/dist/main.js`;
# jobs `node apps/indexer/dist/cli.js sync:incremental` (and the other sync commands) or
# `node apps/api/dist/authorizationCli.js sync`.
CMD ["node", "apps/api/dist/cli.js", "serve"]
