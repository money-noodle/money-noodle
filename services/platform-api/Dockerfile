# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
FROM node:22.22.0-alpine3.22@sha256:7aa86fa052f6e4b101557ccb56717cb4311be1334381f526fe013418fe157384 AS build

WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@11.24.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc nx.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY services/platform-api/package.json services/platform-api/package.json
COPY packages/platform-api-client/package.json packages/platform-api-client/package.json
RUN pnpm install --frozen-lockfile

COPY services/platform-api services/platform-api
RUN pnpm nx run platform-api:build \
  && pnpm --filter @money-noodle/platform-api deploy --prod /runtime

FROM node:22.22.0-alpine3.22@sha256:7aa86fa052f6e4b101557ccb56717cb4311be1334381f526fe013418fe157384 AS runtime

ENV NODE_ENV=production
ENV PORT=3001
WORKDIR /app

RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 api

COPY --from=build --chown=api:nodejs /runtime/package.json ./package.json
COPY --from=build --chown=api:nodejs /runtime/node_modules ./node_modules
COPY --from=build --chown=api:nodejs /workspace/dist/services/platform-api ./dist

USER api
EXPOSE 3001
CMD ["node", "dist/main.js"]
