#!/usr/bin/env node
// Entrypoint of the `restore` job (ADR-0013 §1). Every location is an input:
// the staged archive root, the workstation copy, the evidence output directory.
// The engine_writer connection string arrives by reference from Secret Manager
// as ENGINE_RESTORE_WRITER_DATABASE_URL and never appears here.

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createFilesystemArchiveSource,
  readDataDirectory,
} from '../adapters/archive/filesystem-archive.js';
import { createPostgresEngineStore } from '../adapters/engine-store/postgres-engine-store.js';
import { runRestoreJob } from '../application/restore.js';
import { evidenceFileName } from '../domain/evidence.js';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<number> {
  const archiveRoot = argument('archive');
  const workstationRoot = argument('workstation');
  const evidenceDirectory = argument('evidence-dir');
  const allowWorkstationAbsent = process.argv.includes('--allow-workstation-absent');
  const connectionString = process.env.ENGINE_RESTORE_WRITER_DATABASE_URL;
  if (!archiveRoot || !evidenceDirectory) {
    console.error(
      'usage: restore --archive <staged archive root> --evidence-dir <docs/validation> [--workstation <data directory copy>] [--allow-workstation-absent]',
    );
    return 2;
  }
  if (!connectionString) {
    console.error(
      'ENGINE_RESTORE_WRITER_DATABASE_URL is not set; the job connects only as engine_writer by reference.',
    );
    return 2;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const template = await readFile(
    join(here, '..', '..', 'templates', 'v1-archive-restore-evidence.md'),
    'utf8',
  );
  const now = new Date();
  const evidencePath = resolve(evidenceDirectory, evidenceFileName(now.toISOString()));
  await mkdir(dirname(evidencePath), { recursive: true });
  const store = createPostgresEngineStore(connectionString);
  try {
    const result = await runRestoreJob({
      archive: createFilesystemArchiveSource(resolve(archiveRoot)),
      workstation: workstationRoot ? await readDataDirectory(resolve(workstationRoot)) : undefined,
      store,
      evidenceTemplate: template,
      writeEvidence: (markdown) => writeFile(evidencePath, markdown, 'utf8'),
      runId: process.env.CLOUD_RUN_EXECUTION ?? randomUUID(),
      now: () => now,
      allowWorkstationAbsent,
    });
    console.log(
      JSON.stringify(
        {
          outcome: result.outcome,
          reason: result.reason,
          finding: result.verifyFirst.finding,
          manifestKey: result.manifestKey,
          manifestDigest: result.manifestDigest,
          evidence: evidencePath,
        },
        null,
        2,
      ),
    );
    return result.outcome === 'loaded' ? 0 : 1;
  } finally {
    await store.close();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);
