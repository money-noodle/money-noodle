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
