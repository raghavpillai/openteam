FROM oven/bun:1.3.8@sha256:371d30538b69303ced927bb5915697ac7e2fa8cb409ee332c66009de64de5aa3 AS build

WORKDIR /app

COPY package.json bun.lock turbo.json tsconfig.base.json ./
COPY apps/computer/package.json apps/computer/package.json
COPY apps/cli/package.json apps/cli/package.json
COPY apps/desktop/package.json apps/desktop/package.json
COPY apps/landing/package.json apps/landing/package.json
COPY apps/mobile/package.json apps/mobile/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/client-core/package.json packages/client-core/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/design-tokens/package.json packages/design-tokens/package.json
COPY packages/messaging/package.json packages/messaging/package.json
COPY packages/product-core/package.json packages/product-core/package.json
COPY patches ./patches
COPY vendor/sheetjs/xlsx-0.20.3.tgz vendor/sheetjs/xlsx-0.20.3.tgz

RUN bun install --frozen-lockfile --production --filter @openteam/server --filter @openteam/worker --filter @openteam/db
COPY apps/server ./apps/server
COPY apps/worker ./apps/worker
COPY packages/contracts ./packages/contracts
COPY packages/db ./packages/db
COPY packages/messaging ./packages/messaging
RUN bun --filter @openteam/db db:generate
RUN bun --filter @openteam/server build && bun --filter @openteam/worker build

FROM build AS migrate
CMD ["bun", "--filter", "@openteam/db", "db:deploy"]

FROM oven/bun:1.3.8-slim@sha256:68fc2eac7f5dcfc2f69a81d1db02786ab08772eda2e4404eae785c038f8d2e41 AS server
WORKDIR /app
COPY --from=build /app/apps/server/dist/main.js ./main.js
ENV NODE_ENV=production
ENV HOME=/tmp
ENV XDG_CACHE_HOME=/tmp/.cache
USER 1000:1000
EXPOSE 8787
CMD ["bun", "main.js"]

FROM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS worker
WORKDIR /app
COPY --from=build /app/apps/worker/dist/main.js ./main.js
ENV NODE_ENV=production
USER 1000:1000
CMD ["node", "main.js"]
