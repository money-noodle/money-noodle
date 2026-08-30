# Money Noodle web

## Boundary

`apps/web` is the independently deployable Next.js presentation application. It renders state and submits intent only through generated API clients. It must not import platform API implementation, databases, jobs, provider SDKs, secrets, simulation authority, or funded authority.

## Contracts and dependencies

- Runtime: Node.js 22.22.0, Next.js 16, React 19.
- Platform transport: `@money-noodle/platform-api-client` only.
- Deployment unit: `money-noodle/web` OCI image.
- Configuration: `PORT`, `HOSTNAME`, required production `PLATFORM_API_ORIGIN`, and safe `ARTIFACT_VERSION`; these are non-secret typed values.
- Data/schema ownership: none.
- Health: `/health/live` reports process/artifact identity; `/health/ready` additionally requires valid production API-origin configuration.
- Public presentation: the server-side generated client performs one 1.5-second, no-retry, no-store status read. Transport, timeout, malformed, and incompatible responses render `Status unknown` without stale or healthy fallback.

## Commands

Run from the repository root:

```bash
pnpm nx run web:lint
pnpm nx run web:typecheck
pnpm nx run web:test
pnpm nx run web:build
pnpm nx run web:container
pnpm nx run web:dev
```

The availability card presents only the API-provided state, source time, and artifact version. Text communicates every state independently of color. Existing `noodle.money` DNS and provider deployment remain outside this project.
