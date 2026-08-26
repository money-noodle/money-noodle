import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  STALE_TMP_MS, archiveIntervalMs, archiveLocalData, cleanupStaleTmpFiles, listArchiveCandidates,
  localArchiveConfig, readLocalArchiveState, restoreLocalArchive,
  type ArchiveObjectStore, type LocalArchiveConfig,
} from './local-data-archive';

async function bytes(body: unknown): Promise<Buffer> {
  if (typeof body === 'string' || body instanceof Uint8Array) return Buffer.from(body);
  const chunks: Buffer[] = [];
  for await (const chunk of body as Readable) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

class MemoryStore implements ArchiveObjectStore {
  objects = new Map<string, { body: Buffer; metadata?: Record<string, string> }>();
  async send(command: unknown): Promise<unknown> {
    if (command instanceof PutObjectCommand) {
      const key = command.input.Key!;
      this.objects.set(key, { body: await bytes(command.input.Body), metadata: command.input.Metadata });
      return {};
    }
    if (command instanceof HeadObjectCommand) {
      const object = this.objects.get(command.input.Key!);
      if (!object) throw Object.assign(new Error('not found'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
      return { ContentLength: object.body.length, Metadata: object.metadata };
    }
    if (command instanceof GetObjectCommand) {
      const object = this.objects.get(command.input.Key!);
      if (!object) throw new Error('not found');
      return { Body: Readable.from(object.body) };
    }
    throw new Error(`Unexpected command ${(command as { constructor?: { name?: string } }).constructor?.name}`);
  }
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<LocalArchiveConfig> {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), 'money-noodle-archive-test-'));
  roots.push(dataDirectory);
  return {
    bucket: 'archive', region: 'fr-par', endpoint: 'https://example.test', prefix: 'money-noodle/v1',
    accessKeyId: 'access', secretAccessKey: 'secret', dataDirectory,
  };
}

describe('local durable-data archive', () => {
  it('is explicitly enabled, credentialed, bounded, and disabled on Vercel', () => {
    const enabled: NodeJS.ProcessEnv = {
      ...process.env,
      MONEY_NOODLE_ARCHIVE_ENABLED: 'true', MONEY_NOODLE_ARCHIVE_BUCKET: 'bucket',
      MONEY_NOODLE_ARCHIVE_ACCESS_KEY_ID: 'access', MONEY_NOODLE_ARCHIVE_SECRET_ACCESS_KEY: 'secret',
      MONEY_NOODLE_ARCHIVE_INTERVAL_HOURS: '0',
    };
    expect(localArchiveConfig(enabled, '/tmp/project')).toMatchObject({ bucket: 'bucket', region: 'fr-par', dataDirectory: '/tmp/project/data' });
    expect(archiveIntervalMs(enabled)).toBe(60 * 60_000);
    expect(localArchiveConfig({ ...enabled, VERCEL: '1' }, '/tmp/project')).toBeUndefined();
    expect(localArchiveConfig({ ...enabled, MONEY_NOODLE_ARCHIVE_SECRET_ACCESS_KEY: '' }, '/tmp/project')).toBeUndefined();
  });

  it('selects durable JSON recursively but excludes state, temporary files, and hidden paths', async () => {
    const config = await fixture();
    await mkdir(path.join(config.dataDirectory, 'forecast-history-shards'));
    await mkdir(path.join(config.dataDirectory, '.private'));
    await writeFile(path.join(config.dataDirectory, 'paper-orders.json'), '{}');
    await writeFile(path.join(config.dataDirectory, 'forecast-history.journal.jsonl'), '{}\n');
    await writeFile(path.join(config.dataDirectory, 'archive-state.json'), '{}');
    await writeFile(path.join(config.dataDirectory, 'paper-orders.json.1.tmp'), '{}');
    await writeFile(path.join(config.dataDirectory, '.private', 'secret.json'), '{}');
    await writeFile(path.join(config.dataDirectory, 'forecast-history-shards', '2026-08-14.json'), '[]');
    await writeFile(path.join(config.dataDirectory, 'forecast-history.journal.jsonl.corrupt-2026-08-22'), '{}\n');
    await writeFile(path.join(config.dataDirectory, 'forecast-history-shards.corrupt.journal-copy'), '{}\n');
    await writeFile(path.join(config.dataDirectory, 'binary-evidence.bin'), 'not selected');
    expect(await listArchiveCandidates(config.dataDirectory)).toEqual([
      'forecast-history-shards.corrupt.journal-copy',
      'forecast-history-shards/2026-08-14.json',
      'forecast-history.journal.jsonl',
      'forecast-history.journal.jsonl.corrupt-2026-08-22',
      'paper-orders.json',
    ]);
  });

  it('uploads content-addressed gzip blobs, reads every new blob back, and reuses unchanged data', async () => {
    const config = await fixture();
    const store = new MemoryStore();
    await writeFile(path.join(config.dataDirectory, 'paper-orders.json'), `${JSON.stringify({ orders: ['x'.repeat(100_000)] })}\n`);

    const first = await archiveLocalData(config, { store, now: new Date('2026-08-14T12:00:00Z'), hostname: 'test-host' });
    expect(first.manifest.totals).toMatchObject({ files: 1, newBlobs: 1, reusedBlobs: 0 });
    expect(first.manifest.files[0].objectKey).toMatch(/^money-noodle\/v1\/blobs\/sha256\/[a-f0-9]{2}\/[a-f0-9]{64}\.gz$/);
    expect(first.manifestKey).toContain('/manifests/2026/08/14/');

    const second = await archiveLocalData(config, { store, now: new Date('2026-08-15T12:00:00Z'), hostname: 'test-host' });
    expect(second.manifest.totals).toMatchObject({ files: 1, newBlobs: 0, reusedBlobs: 1 });
    const state = await readLocalArchiveState(config.dataDirectory);
    expect(state).toMatchObject({ lastManifestKey: second.manifestKey, newBlobs: 0, reusedBlobs: 1 });
    expect(state?.lastError).toBeUndefined();
    expect(JSON.parse(await readFile(path.join(config.dataDirectory, 'archive-state.json'), 'utf8'))).toMatchObject({ version: 'money-noodle-local-archive-v1' });
  });

  it('fails rather than publishing a snapshot when its source changes during capture', async () => {
    const config = await fixture();
    const store = new MemoryStore();
    const source = path.join(config.dataDirectory, 'events.journal.jsonl');
    await writeFile(source, '{"event":1}\n');
    await expect(archiveLocalData(config, {
      store,
      afterSnapshot: async (captured) => { if (captured === source) await writeFile(source, '{"event":1}\n{"event":2}\n'); },
    })).rejects.toThrow('changed while it was being captured');
    expect([...store.objects.keys()].some((key) => key.includes('/manifests/'))).toBe(false);
  });

  it('restores a complete manifest byte-exactly into a newly published directory', async () => {
    const config = await fixture();
    const store = new MemoryStore();
    await mkdir(path.join(config.dataDirectory, 'nested'));
    await writeFile(path.join(config.dataDirectory, 'paper-orders.json'), '{"orders":[]}\n');
    await writeFile(path.join(config.dataDirectory, 'nested', 'events.jsonl'), '{"id":1}\n{"id":2}\n');
    const archived = await archiveLocalData(config, { store, now: new Date('2026-08-24T04:52:43.821Z') });
    const destination = `${config.dataDirectory}-restored`;
    roots.push(destination);

    const restored = await restoreLocalArchive(config, archived.manifestKey, destination, { store });

    expect(restored).toMatchObject({ files: 2, sourceBytes: archived.manifest.totals.sourceBytes, destination });
    expect(await readFile(path.join(destination, 'paper-orders.json'), 'utf8')).toBe('{"orders":[]}\n');
    expect(await readFile(path.join(destination, 'nested', 'events.jsonl'), 'utf8')).toBe('{"id":1}\n{"id":2}\n');
    expect((await stat(path.join(destination, 'paper-orders.json'))).mode & 0o777).toBe(0o600);
  });

  it('refuses to restore into the active data tree', async () => {
    const config = await fixture();
    const store = new MemoryStore();
    await writeFile(path.join(config.dataDirectory, 'paper-orders.json'), '{}\n');
    const archived = await archiveLocalData(config, { store });
    await expect(restoreLocalArchive(config, archived.manifestKey, path.join(config.dataDirectory, 'restore'), { store }))
      .rejects.toThrow('active data directory');
  });

  it('rejects an unsafe manifest before publishing any restore directory', async () => {
    const config = await fixture();
    const store = new MemoryStore();
    await writeFile(path.join(config.dataDirectory, 'paper-orders.json'), '{}\n');
    const archived = await archiveLocalData(config, { store });
    const storedManifest = store.objects.get(archived.manifestKey)!;
    const manifest = JSON.parse(storedManifest.body.toString('utf8'));
    manifest.files[0].path = '../outside.json';
    storedManifest.body = Buffer.from(`${JSON.stringify(manifest)}\n`);
    storedManifest.metadata!.sha256 = createHash('sha256').update(storedManifest.body).digest('hex');
    const destination = `${config.dataDirectory}-unsafe`;
    roots.push(destination);

    await expect(restoreLocalArchive(config, archived.manifestKey, destination, { store })).rejects.toThrow('unsafe path');
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects corrupt remote bytes and leaves no partial restore destination', async () => {
    const config = await fixture();
    const store = new MemoryStore();
    await writeFile(path.join(config.dataDirectory, 'paper-orders.json'), '{"orders":[1]}\n');
    const archived = await archiveLocalData(config, { store });
    store.objects.get(archived.manifest.files[0].objectKey)!.body = Buffer.from('not gzip');
    const destination = `${config.dataDirectory}-corrupt`;
    roots.push(destination);

    await expect(restoreLocalArchive(config, archived.manifestKey, destination, { store })).rejects.toThrow();
    await expect(stat(destination)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

// Pure housekeeping over a pinned clock: the claim is that an orphaned atomic-write temp is reclaimed only
// when it is old enough and its rename target (the real file) already exists, so a temp can never be the
// sole copy of a durable file and a slow in-progress write is never disturbed.
describe('cleanupStaleTmpFiles', () => {
  const now = 1_000_000_000_000;
  const oldSeconds = Math.floor((now - STALE_TMP_MS - 5_000) / 1000); // well past the stale threshold
  const freshSeconds = Math.floor((now - 500) / 1000); // younger than the stale threshold

  it('reclaims an old orphaned temp whose rename target exists', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'money-noodle-cleanup-'));
    roots.push(dir);
    await writeFile(path.join(dir, 'ledger.json'), '{}');
    const orphan = path.join(dir, 'ledger.json.111.aaaa.tmp');
    await writeFile(orphan, '{}');
    await utimes(orphan, oldSeconds, oldSeconds);
    expect(await cleanupStaleTmpFiles(dir, now)).toBe(1);
    expect(await readdir(dir)).toEqual(['ledger.json']);
  });

  it('leaves a fresh temp alone even when its target exists', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'money-noodle-cleanup-'));
    roots.push(dir);
    await writeFile(path.join(dir, 'data.json'), '{}');
    const recent = path.join(dir, 'data.json.222.bbbb.tmp');
    await writeFile(recent, '{}');
    await utimes(recent, freshSeconds, freshSeconds);
    expect(await cleanupStaleTmpFiles(dir, now)).toBe(0);
    expect((await readdir(dir)).sort()).toEqual(['data.json', path.basename(recent)]);
  });

  it('never reclaims a temp whose rename target is missing (it may be the only copy)', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'money-noodle-cleanup-'));
    roots.push(dir);
    const only = path.join(dir, 'new.json.333.cccc.tmp');
    await writeFile(only, '{}');
    await utimes(only, oldSeconds, oldSeconds);
    expect(await cleanupStaleTmpFiles(dir, now)).toBe(0);
    expect(await readdir(dir)).toEqual([path.basename(only)]);
  });

  it('leaves non-pattern and nested-dot entries untouched', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'money-noodle-cleanup-'));
    roots.push(dir);
    await writeFile(path.join(dir, 'plain.tmp'), '{}');
    await utimes(path.join(dir, 'plain.tmp'), oldSeconds, oldSeconds);
    await mkdir(path.join(dir, '.hidden'));
    const hidden = path.join(dir, '.hidden', 'a.json.444.dddd.tmp');
    await writeFile(hidden, '{}');
    await utimes(hidden, oldSeconds, oldSeconds);
    expect(await cleanupStaleTmpFiles(dir, now)).toBe(0);
    expect(await readdir(dir)).toEqual(['.hidden', 'plain.tmp']);
  });

  it('treats an absent optional root as already clean', async () => {
    const dir = path.join(os.tmpdir(), `money-noodle-missing-${process.pid}-${Date.now()}`);
    expect(await cleanupStaleTmpFiles(dir, now)).toBe(0);
  });
});
