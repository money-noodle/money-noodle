# Money Noodle web

## Boundary

`apps/web` is the independently deployable Next.js presentation application. It renders state and submits intent only through generated API clients. It must not import platform API implementation, databases, jobs, provider SDKs, secrets, simulation authority, or funded authority.

## Contracts and dependencies

- Runtime: Node.js 22.22.0, Next.js 16, React 19.
- Platform transport: `@money-noodle/platform-api-client` only.
- Deployment unit: `money-noodle/web` OCI image.
- Configuration: `PORT` and `HOSTNAME`; the platform API origin is introduced with the first API-backed slice.
- Data/schema ownership: none.
- Health: provider-level process/readiness checks are defined during deployment composition; the public platform status is not implemented by this scaffold.

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

The current page is a non-authoritative scaffold and deliberately reports no platform status.
