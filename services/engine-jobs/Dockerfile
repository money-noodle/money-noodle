# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e
FROM node:22.22.3-alpine3.22@sha256:cd7807368cf24826297cbad5dca1a44972ccfd770647db52a8c7589eb4599ac8 AS build

WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@11.24.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc nx.json tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY services/platform-api/package.json services/platform-api/package.json
COPY services/engine-jobs/package.json services/engine-jobs/package.json
COPY packages/platform-api-client/package.json packages/platform-api-client/package.json
RUN pnpm install --frozen-lockfile

COPY services/engine-jobs services/engine-jobs
RUN pnpm nx run engine-jobs:build \
  && pnpm --filter @money-noodle/engine-jobs deploy --prod /runtime

# One image, one entrypoint per job (ADR-0013 §1). The Cloud Run Job for each
# capability pins this image by digest and names its entrypoint in `args`; no
# default command runs anything, so an image started without arguments does no
# work.
FROM node:22.22.3-alpine3.22@sha256:cd7807368cf24826297cbad5dca1a44972ccfd770647db52a8c7589eb4599ac8 AS runtime

ENV NODE_ENV=production
WORKDIR /app

# Same pinned package floor as the two service images: the base tag has not
# been rebuilt since May and its OpenSSL 3.5.6 carries CVE-2026-14456 and
# CVE-2026-45447 (fixed in 3.5.7/3.5.8); the publish scan refuses the image
# without this (Delivery run 37693299189).
RUN apk add --no-cache --upgrade \
    'libcrypto3=3.5.9-r0' \
    'libssl3=3.5.9-r0' \
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
  && adduser --system --uid 1001 jobs

COPY --from=build --chown=jobs:nodejs /runtime/package.json ./package.json
COPY --from=build --chown=jobs:nodejs /runtime/node_modules ./node_modules
COPY --from=build --chown=jobs:nodejs /workspace/services/engine-jobs/dist ./dist
COPY --from=build --chown=jobs:nodejs /workspace/services/engine-jobs/templates ./templates

ARG SOURCE_REPOSITORY=unknown
ARG SOURCE_COMMIT=unknown
ARG SOURCE_REF=unknown
ARG BUILD_WORKFLOW=unknown
ARG BUILD_RUN=unknown
ARG ARTIFACT_VERSION=unknown
LABEL org.opencontainers.image.title="engine-jobs" \
  org.opencontainers.image.source="https://github.com/${SOURCE_REPOSITORY}" \
  org.opencontainers.image.revision="${SOURCE_COMMIT}" \
  org.opencontainers.image.version="${ARTIFACT_VERSION}" \
  money.noodle.source.ref="${SOURCE_REF}" \
  money.noodle.build.workflow="${BUILD_WORKFLOW}" \
  money.noodle.build.run="${BUILD_RUN}"

USER jobs
ENTRYPOINT ["node"]
CMD ["-e", "console.error('engine-jobs: name an entrypoint, for example dist/restore/main.js'); process.exit(2)"]
