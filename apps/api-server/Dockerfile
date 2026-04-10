FROM node:20-slim AS base
RUN corepack enable && corepack prepare pnpm@10 --activate

FROM base AS build
WORKDIR /app
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/config/ packages/config/
COPY packages/shared/ packages/shared/
COPY packages/db/ packages/db/
COPY apps/api-server/ apps/api-server/
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @agentchat/api-server build

FROM base AS production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/packages/db/package.json ./packages/db/
COPY --from=build /app/apps/api-server/dist ./apps/api-server/dist
COPY --from=build /app/apps/api-server/package.json ./apps/api-server/
EXPOSE 3000
CMD ["node", "apps/api-server/dist/index.js"]
