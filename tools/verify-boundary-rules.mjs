#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';

const probes = [
  {
    path: 'services/platform-api/src/domain/.boundary-probe.ts',
    source: "import Fastify from 'fastify';\nvoid Fastify;\n",
  },
  {
    path: 'apps/web/src/.boundary-probe.ts',
    source: "import '@money-noodle/platform-api';\n",
  },
  // The 2026-09-15 accepted ADR-0007 amendment is narrow: a provider
  // authentication library is permitted only in the telemetry authentication
  // adapter. These probes prove the narrowness holds in both directions —
  // outside that one file the import is refused, and inner layers stay free of
  // telemetry as well.
  {
    path: 'services/platform-api/src/adapters/http/.boundary-probe.ts',
    source: "import { Compute } from 'google-auth-library';\nvoid Compute;\n",
  },
  {
    path: 'apps/web/src/adapters/platform-api/.boundary-probe.ts',
    source: "import { Compute } from 'google-auth-library';\nvoid Compute;\n",
  },
  {
    path: 'services/platform-api/src/application/.boundary-probe.ts',
    source: "import { trace } from '@opentelemetry/api';\nvoid trace;\n",
  },
  {
    path: 'services/platform-api/src/domain/.telemetry-boundary-probe.ts',
    source:
      "import { createTelemetry } from '../adapters/telemetry/create-telemetry.js';\nvoid createTelemetry;\n",
  },
  {
    path: 'apps/web/src/presentation/.boundary-probe.ts',
    source: "import { trace } from '@opentelemetry/api';\nvoid trace;\n",
  },
  // ADR-0012 admits a read-only projection port in the API only, behind one
  // PostgreSQL adapter. These probes prove the narrowness in every direction that
  // matters: the driver is refused outside `adapters/projection`, inner layers
  // cannot reach the adapter directory at all, and the web cannot become a
  // database client either directly or by importing a projection module.
  {
    path: 'services/platform-api/src/adapters/http/.database-boundary-probe.ts',
    source: "import postgres from 'postgres';\nvoid postgres;\n",
  },
  {
    path: 'services/platform-api/src/application/.database-boundary-probe.ts',
    source: "import postgres from 'postgres';\nvoid postgres;\n",
  },
  {
    path: 'services/platform-api/src/domain/.database-boundary-probe.ts',
    source: "import postgres from 'postgres';\nvoid postgres;\n",
  },
  {
    path: 'services/platform-api/src/application/.projection-adapter-boundary-probe.ts',
    source:
      "import { createPostgresPaperProjection } from '../adapters/projection/postgres-paper-projection.js';\nvoid createPostgresPaperProjection;\n",
  },
  {
    path: 'apps/web/src/.database-boundary-probe.ts',
    source: "import postgres from 'postgres';\nvoid postgres;\n",
  },
  {
    path: 'apps/web/src/presentation/.database-boundary-probe.ts',
    source: "import postgres from 'postgres';\nvoid postgres;\n",
  },
  {
    path: 'apps/web/src/.projection-module-boundary-probe.ts',
    source:
      "import type { PaperBudgetRow } from '../../../services/platform-api/src/domain/paper-projection.js';\nexport type Probe = PaperBudgetRow;\n",
  },
  // ADR-0013 puts every cadence in the `services/engine-jobs` family, each job
  // under its own workload identity, and keeps the engine store behind one
  // read-only adapter in the API. None of those modules exists yet, which is the
  // point of probing by import specifier rather than by resolution: the rules
  // pass against this tree and bite the moment the M4 children land.
  {
    path: 'apps/web/src/.engine-jobs-boundary-probe.ts',
    source: "import '@money-noodle/engine-jobs';\n",
  },
  {
    path: 'apps/web/src/app/.engine-store-boundary-probe.ts',
    source:
      "import { createEngineStore } from '../adapters/engine-store/postgres-engine-store.js';\nvoid createEngineStore;\n",
  },
  {
    path: 'apps/web/src/.scheduler-boundary-probe.ts',
    source: "import cron from 'node-cron';\nvoid cron;\n",
  },
  {
    path: 'services/platform-api/src/adapters/http/.scheduler-boundary-probe.ts',
    source: "import cron from 'node-cron';\nvoid cron;\n",
  },
  {
    path: 'services/platform-api/src/adapters/http/.engine-jobs-boundary-probe.ts',
    source: "import '@money-noodle/engine-jobs';\n",
  },
  {
    path: 'services/platform-api/src/application/.engine-store-adapter-boundary-probe.ts',
    source:
      "import { createEngineStore } from '../adapters/engine-store/postgres-engine-store.js';\nvoid createEngineStore;\n",
  },
];

try {
  for (const probe of probes) writeFileSync(probe.path, probe.source);

  for (const probe of probes) {
    const result = spawnSync(
      process.platform === 'win32' ? 'eslint.cmd' : 'eslint',
      [probe.path, '--no-cache'],
      { encoding: 'utf8' },
    );
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.status === 0 || !output.includes('no-restricted-imports')) {
      console.error(`Boundary probe was not rejected as expected: ${probe.path}`);
      console.error(output);
      process.exitCode = 1;
    }
  }

  if (process.exitCode === undefined) {
    console.log(`Verified ${probes.length} forbidden dependency probes fail lint.`);
  }
} finally {
  for (const probe of probes) rmSync(probe.path, { force: true });
}
