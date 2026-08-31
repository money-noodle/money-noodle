# Money Noodle

Money Noodle is an [MIT-licensed](LICENSE) architecture-first rebuild of a multi-tenant platform for financial learning, games, analysis, simulation, and—only after a separate authority design—funded trading. Whimsy may shape the experience; code, infrastructure, and risk language stay precise.

The platform currently has **no real-money authority**.

## Current reality

[`docs/current-status.md`](docs/current-status.md) owns the current repository, host-control, validation, and deployment truth. Nothing in the architecture documents or local command output should be read as newer deployment evidence.

## Current projects

| Path | Purpose |
| --- | --- |
| [`apps/web`](apps/web) | Next.js presentation application |
| [`services/platform-api`](services/platform-api) | Stateless, interface-neutral Fastify API |
| [`packages/platform-api-client`](packages/platform-api-client) | Generated TypeScript client for the API-owned OpenAPI contract |
| [`infra`](infra) | Unapplied OpenTofu and delivery configuration for the intended Google Cloud composition |

Start with the [architecture overview](docs/architecture/overview.md) and [documentation map](docs/README.md). Report security concerns through [SECURITY.md](SECURITY.md), and read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a change. Agent sessions must also follow [AGENTS.md](AGENTS.md).

## Local validation

Use Node.js 22.22.0 and pnpm 11.24.0:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm audit --audit-level high
```

When Docker is available, also run:

```sh
pnpm container
```

These are local checks, not deployed validation.
