# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
FROM node:22.22.3-alpine3.22@sha256:cd7807368cf24826297cbad5dca1a44972ccfd770647db52a8c7589eb4599ac8 AS build

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

FROM node:22.22.3-alpine3.22@sha256:cd7807368cf24826297cbad5dca1a44972ccfd770647db52a8c7589eb4599ac8 AS runtime

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

# Provenance the artifact carries itself. The attestation is the authority, but
# an image that cannot say which repository, commit, workflow and run produced
# it forces every later question about "what is this digest" back onto an
# external lookup. These are declared last so they cost no layer cache, and they
# default to `unknown` so a local build needs no arguments (ADR-0005, "Artifact
# trust").
ARG SOURCE_REPOSITORY=unknown
ARG SOURCE_COMMIT=unknown
ARG SOURCE_REF=unknown
ARG BUILD_WORKFLOW=unknown
ARG BUILD_RUN=unknown
ARG ARTIFACT_VERSION=unknown
LABEL org.opencontainers.image.title="web" \
  org.opencontainers.image.source="https://github.com/${SOURCE_REPOSITORY}" \
  org.opencontainers.image.revision="${SOURCE_COMMIT}" \
  org.opencontainers.image.version="${ARTIFACT_VERSION}" \
  money.noodle.source.ref="${SOURCE_REF}" \
  money.noodle.build.workflow="${BUILD_WORKFLOW}" \
  money.noodle.build.run="${BUILD_RUN}"

# The image declares how to prove itself healthy, so the release pipeline and a
# reviewer run the same check. `node` is the only interpreter guaranteed to
# survive the runtime stage's tool removal above.
HEALTHCHECK --interval=5s --timeout=3s --start-period=20s --retries=12 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/ready').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

USER nextjs
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
