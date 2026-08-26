FROM oven/bun:1.3.8 AS build

WORKDIR /app

COPY package.json bun.lock turbo.json tsconfig.base.json ./
COPY apps/computer/package.json apps/computer/package.json
COPY apps/desktop/package.json apps/desktop/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/codex-client/package.json packages/codex-client/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/messaging/package.json packages/messaging/package.json

RUN bun install --frozen-lockfile --production --filter @openbot/server --filter @openbot/worker --filter @openbot/db
COPY apps/server ./apps/server
COPY apps/worker ./apps/worker
COPY packages/contracts ./packages/contracts
COPY packages/db ./packages/db
COPY packages/messaging ./packages/messaging
RUN bun --filter @openbot/db db:generate
RUN bun --filter @openbot/server build && bun --filter @openbot/worker build

FROM build AS migrate
CMD ["bun", "--filter", "@openbot/db", "db:deploy"]

FROM oven/bun:1.3.8-slim AS server
WORKDIR /app
COPY --from=build /app/apps/server/dist/main.js ./main.js
USER bun
EXPOSE 8787
CMD ["bun", "main.js"]

FROM node:22-bookworm-slim AS worker
WORKDIR /app
COPY --from=build /app/apps/worker/dist/main.js ./main.js
USER node
CMD ["node", "main.js"]
