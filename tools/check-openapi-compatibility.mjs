#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const contractPath = 'services/platform-api/openapi/platform-api.v1.yaml';
const baseRef = process.env.OPENAPI_BASE_REF ?? process.env.NX_BASE ?? 'origin/v2';
const baseline = `${baseRef}:${contractPath}`;
const probe = spawnSync('git', ['cat-file', '-e', baseline], { encoding: 'utf8' });

if (probe.status !== 0) {
  console.log(
    `No OpenAPI baseline exists at ${baseRef}; treating this as the initial v1 contract.`,
  );
  process.exit(0);
}

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const command = path.join(
  repositoryRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'openapi-changes.cmd' : 'openapi-changes',
);
const report = spawnSync(
  command,
  ['report', '--reproducible', '--no-logo', baseline, contractPath],
  {
    encoding: 'utf8',
  },
);
if (report.error) throw report.error;
if (report.status !== 0) {
  console.error(report.stderr || report.stdout);
  process.exit(report.status ?? 1);
}

const result = JSON.parse(report.stdout);
const changes = Array.isArray(result.changes) ? result.changes : [];
const breaking = changes.filter((change) => change.breaking === true);

if (changes.length > 0) {
  spawnSync(command, ['summary', '--no-logo', '--no-color', baseline, contractPath], {
    stdio: 'inherit',
  });
}

if (breaking.length > 0) {
  console.error(`Rejected ${breaking.length} breaking OpenAPI change(s) against ${baseRef}.`);
  process.exitCode = 1;
} else {
  console.log(
    `Verified OpenAPI compatibility against ${baseRef}; ${changes.length} non-breaking change(s).`,
  );
}
