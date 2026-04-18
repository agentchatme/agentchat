FROM node:20-slim AS base
RUN corepack enable && corepack prepare pnpm@10 --activate

FROM base AS build
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY packages/config/ packages/config/
COPY packages/shared/ packages/shared/
COPY packages/sdk-typescript/ packages/sdk-typescript/
COPY apps/chatfather/ apps/chatfather/
RUN pnpm install --frozen-lockfile
# Turbo builds deps in order: shared → sdk-typescript → chatfather
RUN pnpm turbo build --filter=@agentchat/chatfather
# Create a standalone deployable bundle with all deps resolved (no symlinks).
# --legacy keeps workspace-linked deps resolvable from the flat node_modules
# layout — matches the api-server pattern in apps/api-server/Dockerfile.
RUN pnpm --filter @agentchat/chatfather deploy --prod --legacy /app/deployed

FROM base AS production
WORKDIR /app
COPY --from=build /app/deployed/node_modules ./node_modules
COPY --from=build /app/deployed/package.json ./
COPY --from=build /app/deployed/dist ./dist
# Copy workspace package dist outputs (referenced by compiled JS). pnpm deploy
# handles the package.json files but the dist/ directories inside each
# workspace dep need to be copied over for `node` to resolve them at runtime.
COPY --from=build /app/packages/shared/dist ./node_modules/@agentchat/shared/dist
COPY --from=build /app/packages/shared/package.json ./node_modules/@agentchat/shared/
COPY --from=build /app/packages/sdk-typescript/dist ./node_modules/agentchat/dist
COPY --from=build /app/packages/sdk-typescript/package.json ./node_modules/agentchat/
EXPOSE 8080
CMD ["node", "dist/index.js"]
