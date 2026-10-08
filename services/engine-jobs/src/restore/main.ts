#!/usr/bin/env node
// Entrypoint of the `restore` job (ADR-0013 §1), and of its `stage-list`
// companion. Every location is an input: the staged archive root, the workstation
// copy, the evidence output directory, the manifest to list from. The
// engine_writer connection string arrives by reference from Secret Manager as
// ENGINE_RESTORE_WRITER_DATABASE_URL and never appears here.
//
// Two subcommands, one image, one entrypoint:
//
//   restore [--archive … --evidence-dir …]   the one-time load
//   restore stage-list --manifest <file>      what to upload before it
//
// `stage-list` needs no database, no network and no staged archive: it reads one
// manifest file and prints the archive object keys the load scope will fetch, so
// the operator uploads that set and nothing else. Paths go to stdout, one per
// line, for a copy loop; the human summary goes to stderr.

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
import { parseArchiveManifest } from '../domain/archive-manifest.js';
import { evidenceFileName } from '../domain/evidence.js';
import {
  DEFAULT_LOAD_SCOPE,
  isLoadScope,
  LOAD_SCOPE_NAMES,
  type LoadScope,
} from '../domain/load-scope.js';
import { planStaging, stageListLines, stageListSummary } from '../domain/stage-list.js';

function argument(name: string): string | undefined {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index >= 0) return process.argv[index + 1];
  // `--name=value` as well, because an Nx target forwards arguments in that form.
  const inline = process.argv.find((value) => value.startsWith(`${flag}=`));
  return inline === undefined ? undefined : inline.slice(flag.length + 1);
}

function scopeArgument(): LoadScope | undefined {
  const value = argument('scope');
  if (value === undefined) return DEFAULT_LOAD_SCOPE;
  if (isLoadScope(value)) return value;
  console.error(`--scope must be one of: ${LOAD_SCOPE_NAMES.join(', ')}`);
  return undefined;
}

async function stageList(): Promise<number> {
  const manifestPath = argument('manifest');
  const scope = scopeArgument();
  if (!manifestPath || scope === undefined) {
    console.error(
      'usage: restore stage-list --manifest <manifest json> [--manifest-key <archive key>] [--scope <name>]',
    );
    return 2;
  }
  const manifest = parseArchiveManifest(await readFile(resolve(manifestPath), 'utf8'));
  const plan = planStaging(manifest, scope);
  for (const line of stageListLines(plan, argument('manifest-key') ?? manifestPath)) {
    console.log(line);
  }
  console.error(stageListSummary(plan));
  return 0;
}

async function restore(): Promise<number> {
  const archiveRoot = argument('archive');
  const workstationRoot = argument('workstation');
  const evidenceDirectory = argument('evidence-dir');
  const scope = scopeArgument();
  const allowWorkstationAbsent = process.argv.includes('--allow-workstation-absent');
  const allowUnmapped = process.argv.includes('--allow-unmapped');
  const connectionString = process.env.ENGINE_RESTORE_WRITER_DATABASE_URL;
  if (!archiveRoot || !evidenceDirectory || scope === undefined) {
    console.error(
      'usage: restore --archive <staged archive root> --evidence-dir <docs/validation> [--workstation <data directory copy>] [--scope <name>] [--allow-workstation-absent] [--allow-unmapped]',
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
      allowUnmapped,
      scope,
    });
    console.log(
      JSON.stringify(
        {
          outcome: result.outcome,
          reason: result.reason,
          finding: result.verifyFirst.finding,
          scope,
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

const main = (): Promise<number> => (process.argv.includes('stage-list') ? stageList() : restore());

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);
