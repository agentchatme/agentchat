FROM node:20-slim AS base
RUN corepack enable && corepack prepare pnpm@10 --activate

FROM base AS build
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json ./
COPY packages/config/ packages/config/
COPY packages/shared/ packages/shared/
COPY packages/db/ packages/db/
COPY apps/api-server/ apps/api-server/
RUN pnpm install --frozen-lockfile
# Turbo builds deps in order: shared → db → api-server
RUN pnpm turbo build --filter=@agentchat/api-server
# Create a standalone deployable bundle with all deps resolved (no symlinks)
RUN pnpm --filter @agentchat/api-server deploy --prod --legacy /app/deployed

FROM base AS production
WORKDIR /app
# Copy the standalone bundle (flat node_modules, no symlinks)
COPY --from=build /app/deployed/node_modules ./node_modules
COPY --from=build /app/deployed/package.json ./
COPY --from=build /app/deployed/dist ./dist
# Copy workspace package dist outputs (referenced by compiled JS)
COPY --from=build /app/packages/shared/dist ./node_modules/@agentchat/shared/dist
COPY --from=build /app/packages/shared/package.json ./node_modules/@agentchat/shared/
COPY --from=build /app/packages/db/dist ./node_modules/@agentchat/db/dist
COPY --from=build /app/packages/db/package.json ./node_modules/@agentchat/db/
EXPOSE 3000
CMD ["node", "dist/index.js"]
