#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createClient } from '@hey-api/openapi-ts';

import configPromise from '../packages/platform-api-client/openapi-ts.config.mjs';

async function files(root, directory = root) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const child = path.join(directory, entry.name);
      return entry.isDirectory() ? files(root, child) : [path.relative(root, child)];
    }),
  );
  return nested.flat().sort();
}

async function digest(root) {
  const hash = createHash('sha256');
  const names = await files(root);
  for (const name of names) {
    hash.update(name);
    hash.update('\0');
    hash.update(await readFile(path.join(root, name)));
    hash.update('\0');
  }
  return { hash: hash.digest('hex'), names };
}

const config = await configPromise;
const expectedDirectory = config.output;
if (typeof expectedDirectory !== 'string') {
  throw new TypeError('The platform API client output must remain a single directory path.');
}

const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'money-noodle-client-'));
const generatedDirectory = path.join(temporaryRoot, 'generated');

try {
  await createClient({ ...config, output: generatedDirectory });
  const [expected, actual] = await Promise.all([
    digest(expectedDirectory),
    digest(generatedDirectory),
  ]);

  if (expected.hash !== actual.hash) {
    console.error('Generated platform API client is stale or nondeterministic.');
    console.error(`Expected files: ${expected.names.join(', ')}`);
    console.error(`Actual files: ${actual.names.join(', ')}`);
    console.error('Run: pnpm nx run platform-api-client:generate');
    process.exitCode = 1;
  } else {
    console.log(`Verified ${expected.names.length} deterministic generated client files.`);
  }
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
