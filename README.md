# Money Noodle

Money Noodle is an architecture-first rebuild of a multi-tenant platform for financial learning, games, analysis, simulation, and—only after a separate authority design—funded trading. Whimsy may shape the experience; code, infrastructure, and risk language stay precise.

The platform currently has **no real-money authority**.

## Current reality

- The GitHub Free `money-noodle` organization owns this public source repository under the [MIT license](LICENSE), with protected `main` as its sole integration branch.
- GitHub Actions are enabled with host-enforced full-SHA action pinning; private vulnerability reporting, secret scanning, and push protection are enabled. Strict `main` protection requires `affected projects and repository gates`, `secret scan`, `container platform-api`, and `container web`; the initial hosted baseline passed every job.
- No Google Cloud project resource, workload-identity federation, provider credential, repository provider/apply variable, or Money Noodle deployment has been configured. Production effects remain mechanically blocked, and the protected environment prevents self-review and requires a distinct eligible approving actor. Nothing here is remotely deployed yet.
- Google Cloud Run is the intended first runtime, but the committed OpenTofu composition remains unapplied.

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
