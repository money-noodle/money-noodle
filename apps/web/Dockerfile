# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
FROM node:26.3.0-alpine3.22@sha256:c7932b9e5e337b0e733d6e16abc1b0e104759e8b05e59ed56586cce967d26dfe AS build

ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@11.24.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc nx.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY services/platform-api/package.json services/platform-api/package.json
COPY packages/platform-api-client/package.json packages/platform-api-client/package.json
RUN pnpm install --frozen-lockfile

COPY apps/web apps/web
COPY packages/platform-api-client packages/platform-api-client
RUN pnpm nx run web:build

FROM node:26.3.0-alpine3.22@sha256:c7932b9e5e337b0e733d6e16abc1b0e104759e8b05e59ed56586cce967d26dfe AS runtime

ENV HOSTNAME=0.0.0.0
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app

RUN apk add --no-cache --upgrade \
    'libcrypto3=3.5.8-r0' \
    'libssl3=3.5.8-r0' \
    'musl=1.2.5-r12' \
    'musl-utils=1.2.5-r12' \
    'zlib=1.3.2-r0' \
  && rm -rf /usr/local/lib/node_modules /opt/yarn-v1.22.22 \
  && rm -f \
    /usr/local/bin/corepack \
    /usr/local/bin/npm \
    /usr/local/bin/npx \
    /usr/local/bin/pnpm \
    /usr/local/bin/pnpx \
    /usr/local/bin/yarn \
    /usr/local/bin/yarnpkg \
  && addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

COPY --from=build --chown=nextjs:nodejs /workspace/apps/web/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /workspace/apps/web/.next/static ./apps/web/.next/static

USER nextjs
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
