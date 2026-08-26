import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import {
  GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client,
} from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';

export const LOCAL_ARCHIVE_VERSION = 'money-noodle-local-archive-v1';
const STATE_FILE = 'archive-state.json';
const LOCK_DIR = '.archive-upload.lock';

/**
 * Orphaned atomic-write temp files are removed only after this age. Atomic writes are
 * `${target}.<pid>.<rand>.tmp` then `rename`; an orphan is a write whose process died between the write and
 * the rename. A `.tmp` is never on a read path and is not evidence, so reclaiming one is not a ledger edit.
 */
export const STALE_TMP_MS = 60_000;
const TMP_SUFFIX = /\.(\d+)\.([a-z0-9]+)\.tmp$/;

/**
 * Removes orphaned `${target}.<pid>.<rand>.tmp` files under a data directory.
 *
 * Reclaims only when the rename target already exists (so a temp can never be the sole copy of a durable
 * file) and only past `STALE_TMP_MS` (so a slow in-progress write is not disturbed). Best-effort durable
 * housekeeping; the owning writer's `rename` remains the only mutation of the real file.
 */
export async function cleanupStaleTmpFiles(dataDirectory: string, now = Date.now()): Promise<number> {
  let removed = 0;
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.')) await visit(absolute);
      } else if (entry.isFile() && TMP_SUFFIX.test(entry.name)) {
        const details = await stat(absolute).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return undefined;
          throw error;
        });
        if (!details || now - details.mtimeMs <= STALE_TMP_MS) continue;
        const target = absolute.replace(TMP_SUFFIX, '');
        const hasTarget = await stat(target).then(() => true).catch(() => false);
        if (!hasTarget) continue;
        await rm(absolute, { force: true });
        removed += 1;
      }
    }
  }
  await visit(dataDirectory);
  return removed;
}

export interface LocalArchiveConfig {
  bucket: string;
  region: string;
  endpoint: string;
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  dataDirectory: string;
}

export interface ArchiveManifestFile {
  path: string;
  sourceBytes: number;
  compressedBytes: number;
  sha256: string;
  objectKey: string;
  modifiedAt: string;
}

export interface LocalArchiveManifest {
  version: typeof LOCAL_ARCHIVE_VERSION;
  createdAt: string;
  hostname: string;
  sourceRoot: string;
  files: ArchiveManifestFile[];
  totals: { files: number; sourceBytes: number; compressedBytes: number; newBlobs: number; reusedBlobs: number };
}

export interface LocalArchiveState {
  version: typeof LOCAL_ARCHIVE_VERSION;
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastManifestKey?: string;
  lastError?: string;
  files?: number;
  sourceBytes?: number;
  uploadedBytes?: number;
  newBlobs?: number;
  reusedBlobs?: number;
}

export interface ArchiveObjectStore { send(command: unknown): Promise<unknown> }

class HashingTransform extends Transform {
  readonly hash = createHash('sha256');
  bytes = 0;
  _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null, data?: Buffer) => void): void {
    this.hash.update(chunk);
    this.bytes += chunk.length;
    callback(null, chunk);
  }
}

class HashingSink extends Writable {
  readonly hash = createHash('sha256');
  bytes = 0;
  _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.hash.update(chunk);
    this.bytes += chunk.length;
    callback();
  }
}

function cleanPrefix(value: string): string {
  return value.replace(/^\/+|\/+$/g, '').replace(/\/{2,}/g, '/');
}

function statePath(dataDirectory: string): string {
  return path.join(dataDirectory, STATE_FILE);
}

async function atomicWrite(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, file);
}

export function localArchiveConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): LocalArchiveConfig | undefined {
  if (env.VERCEL === '1' || env.MONEY_NOODLE_STATELESS === 'true' || env.MONEY_NOODLE_ARCHIVE_ENABLED !== 'true') return undefined;
  const bucket = env.MONEY_NOODLE_ARCHIVE_BUCKET?.trim();
  const accessKeyId = env.MONEY_NOODLE_ARCHIVE_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.MONEY_NOODLE_ARCHIVE_SECRET_ACCESS_KEY?.trim();
  if (!bucket || !accessKeyId || !secretAccessKey) return undefined;
  const region = env.MONEY_NOODLE_ARCHIVE_REGION?.trim() || 'fr-par';
  return {
    bucket,
    region,
    endpoint: env.MONEY_NOODLE_ARCHIVE_ENDPOINT?.trim() || `https://s3.${region}.scw.cloud`,
    prefix: cleanPrefix(env.MONEY_NOODLE_ARCHIVE_PREFIX?.trim() || 'money-noodle/v1'),
    accessKeyId,
    secretAccessKey,
    dataDirectory: path.resolve(cwd, env.MONEY_NOODLE_ARCHIVE_DATA_DIRECTORY?.trim() || 'data'),
  };
}

export function archiveIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const hours = Number(env.MONEY_NOODLE_ARCHIVE_INTERVAL_HOURS ?? 24);
  return Math.min(168, Math.max(1, Number.isFinite(hours) ? hours : 24)) * 60 * 60_000;
}

export function archiveStartupDelayMs(env: NodeJS.ProcessEnv = process.env): number {
  const minutes = Number(env.MONEY_NOODLE_ARCHIVE_STARTUP_DELAY_MINUTES ?? 5);
  return Math.min(60, Math.max(1, Number.isFinite(minutes) ? minutes : 5)) * 60_000;
}

function archiveCandidate(relative: string): boolean {
  const normalized = relative.split(path.sep).join('/');
  const base = path.posix.basename(normalized);
  if (base === STATE_FILE || base.startsWith('.') || normalized.split('/').some((part) => part.startsWith('.'))) return false;
  if (base.includes('.tmp') || base.endsWith('.lock')) return false;
  // Frozen repair/migration evidence keeps the source suffix before its quarantine label, for example
  // `history.jsonl.corrupt-<stamp>` or `history.journal-copy`. It is durable even though the final extension
  // is no longer json/jsonl. Keep this narrow enough that arbitrary binaries under data/ are not uploaded.
  return /\.jsonl?(?:$|\.)/.test(base) || base.endsWith('.journal-copy');
}

export async function listArchiveCandidates(dataDirectory: string): Promise<string[]> {
  const result: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.')) await visit(absolute);
      } else if (entry.isFile()) {
        const relative = path.relative(dataDirectory, absolute);
        if (archiveCandidate(relative)) result.push(relative.split(path.sep).join('/'));
      }
    }
  }
  await visit(dataDirectory);
  return result.sort();
}

function objectBodyStream(body: unknown): Readable {
  if (body instanceof Readable) return body;
  if (body && typeof (body as { getReader?: unknown }).getReader === 'function') {
    return Readable.from(body as AsyncIterable<Uint8Array>);
  }
  if (body instanceof Uint8Array || typeof body === 'string') return Readable.from(body);
  throw new Error('Archive verification received an unreadable object body.');
}

async function compressedSnapshot(source: string, temporary: string): Promise<{ sha256: string; sourceBytes: number; compressedBytes: number }> {
  const hasher = new HashingTransform();
  await pipeline(createReadStream(source), hasher, createGzip({ level: 6 }), createWriteStream(temporary, { mode: 0o600 }));
  const compressed = await stat(temporary);
  return { sha256: hasher.hash.digest('hex'), sourceBytes: hasher.bytes, compressedBytes: compressed.size };
}

async function verifyStoredBlob(store: ArchiveObjectStore, bucket: string, key: string, expected: { sha256: string; sourceBytes: number }): Promise<void> {
  const response = await store.send(new GetObjectCommand({ Bucket: bucket, Key: key })) as { Body?: unknown };
  if (!response.Body) throw new Error(`Archive object ${key} had no body during verification.`);
  const sink = new HashingSink();
  await pipeline(objectBodyStream(response.Body), createGunzip(), sink);
  const actual = sink.hash.digest('hex');
  if (actual !== expected.sha256 || sink.bytes !== expected.sourceBytes) {
    throw new Error(`Archive verification failed for ${key}: expected ${expected.sha256}/${expected.sourceBytes}, received ${actual}/${sink.bytes}.`);
  }
}

async function existingBlobSize(store: ArchiveObjectStore, bucket: string, key: string, expected: { sha256: string; sourceBytes: number }): Promise<number | undefined> {
  try {
    const head = await store.send(new HeadObjectCommand({ Bucket: bucket, Key: key })) as { ContentLength?: number; Metadata?: Record<string, string> };
    if (head.Metadata?.sha256 !== expected.sha256 || Number(head.Metadata?.sourcebytes) !== expected.sourceBytes || !Number.isFinite(head.ContentLength)) {
      throw new Error(`Existing archive object ${key} did not match its content-addressed metadata.`);
    }
    return head.ContentLength;
  } catch (error) {
    const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    const name = (error as { name?: string }).name;
    if (status === 404 || name === 'NotFound' || name === 'NoSuchKey') return undefined;
    throw error;
  }
}

function safeManifestPath(relative: string): boolean {
  if (!relative || relative.includes('\\') || relative.includes('\0') || path.posix.isAbsolute(relative)) return false;
  const normalized = path.posix.normalize(relative);
  return normalized === relative && normalized !== '..' && !normalized.startsWith('../');
}

function validateManifest(config: LocalArchiveConfig, manifest: LocalArchiveManifest): void {
  if (manifest.version !== LOCAL_ARCHIVE_VERSION || manifest.sourceRoot !== 'data' || !Array.isArray(manifest.files)) {
    throw new Error('Archive manifest version or source root is invalid.');
  }
  const seen = new Set<string>();
  for (const file of manifest.files) {
    if (!safeManifestPath(file.path)) throw new Error(`Archive manifest contained unsafe path ${JSON.stringify(file.path)}.`);
    if (seen.has(file.path)) throw new Error(`Archive manifest contained duplicate path ${file.path}.`);
    seen.add(file.path);
    if (!/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error(`Archive manifest contained an invalid checksum for ${file.path}.`);
    if (!Number.isSafeInteger(file.sourceBytes) || file.sourceBytes < 0 || !Number.isSafeInteger(file.compressedBytes) || file.compressedBytes < 0) {
      throw new Error(`Archive manifest contained invalid byte counts for ${file.path}.`);
    }
    const expectedKey = `${config.prefix}/blobs/sha256/${file.sha256.slice(0, 2)}/${file.sha256}.gz`;
    if (file.objectKey !== expectedKey) throw new Error(`Archive manifest object key for ${file.path} was not content-addressed under the configured prefix.`);
  }
  const sourceBytes = manifest.files.reduce((sum, file) => sum + file.sourceBytes, 0);
  const compressedBytes = manifest.files.reduce((sum, file) => sum + file.compressedBytes, 0);
  if (manifest.totals.files !== manifest.files.length || manifest.totals.sourceBytes !== sourceBytes || manifest.totals.compressedBytes !== compressedBytes) {
    throw new Error('Archive manifest totals did not match its file records.');
  }
}

async function putManifest(store: ArchiveObjectStore, config: LocalArchiveConfig, manifest: LocalArchiveManifest): Promise<string> {
  const content = `${JSON.stringify(manifest)}\n`;
  const digest = createHash('sha256').update(content).digest('hex');
  const stamp = manifest.createdAt.replace(/[:.]/g, '-');
  const day = manifest.createdAt.slice(0, 10).replace(/-/g, '/');
  const key = `${config.prefix}/manifests/${day}/${stamp}.json`;
  await store.send(new PutObjectCommand({
    Bucket: config.bucket, Key: key, Body: content, ContentType: 'application/json',
    Metadata: { sha256: digest, manifestversion: LOCAL_ARCHIVE_VERSION },
  }));
  const response = await store.send(new GetObjectCommand({ Bucket: config.bucket, Key: key })) as { Body?: unknown };
  if (!response.Body) throw new Error('Archive manifest could not be read back.');
  const chunks: Buffer[] = [];
  for await (const chunk of objectBodyStream(response.Body)) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const restored = Buffer.concat(chunks).toString('utf8');
  if (createHash('sha256').update(restored).digest('hex') !== digest) throw new Error('Archive manifest checksum verification failed.');
  return key;
}

export async function readLocalArchiveState(dataDirectory: string): Promise<LocalArchiveState | undefined> {
  try {
    return JSON.parse(await readFile(statePath(dataDirectory), 'utf8')) as LocalArchiveState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function acquireLock(dataDirectory: string): Promise<() => Promise<void>> {
  const lock = path.join(dataDirectory, LOCK_DIR);
  try {
    await mkdir(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const details = await stat(lock).catch(() => undefined);
    if (!details || Date.now() - details.mtimeMs < 6 * 60 * 60_000) throw new Error('A local archive upload is already running.');
    await rm(lock, { recursive: true, force: true });
    await mkdir(lock);
  }
  const handle = await open(path.join(lock, 'owner'), 'w', 0o600);
  await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`);
  await handle.close();
  return () => rm(lock, { recursive: true, force: true });
}

export async function archiveLocalData(
  config: LocalArchiveConfig,
  options: {
    store?: ArchiveObjectStore;
    now?: Date;
    hostname?: string;
    onProgress?: (message: string) => void;
    /** Test seam: production has no callback between snapshot completion and the source stability check. */
    afterSnapshot?: (source: string) => void | Promise<void>;
  } = {},
): Promise<{ manifest: LocalArchiveManifest; manifestKey: string }> {
  await mkdir(config.dataDirectory, { recursive: true });
  const release = await acquireLock(config.dataDirectory);
  const now = options.now ?? new Date();
  const attemptAt = now.toISOString();
  const previous = await readLocalArchiveState(config.dataDirectory).catch(() => undefined);
  await atomicWrite(statePath(config.dataDirectory), `${JSON.stringify({ ...previous, version: LOCAL_ARCHIVE_VERSION, lastAttemptAt: attemptAt, lastError: undefined }, null, 2)}\n`);
  const store = options.store ?? new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: false,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    maxAttempts: 2,
    requestHandler: new NodeHttpHandler({ connectionTimeout: 10_000, requestTimeout: 120_000 }),
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  }) as unknown as ArchiveObjectStore;
  const staging = await mkdir(path.join(os.tmpdir(), 'money-noodle-archive'), { recursive: true }).then(() => path.join(os.tmpdir(), 'money-noodle-archive', `${process.pid}-${crypto.randomUUID()}.gz`));
  try {
    const files: ArchiveManifestFile[] = [];
    let newBlobs = 0;
    let reusedBlobs = 0;
    let uploadedBytes = 0;
    const candidates = await listArchiveCandidates(config.dataDirectory);
    options.onProgress?.(`Discovered ${candidates.length} durable files.`);
    for (const [index, relative] of candidates.entries()) {
      options.onProgress?.(`[${index + 1}/${candidates.length}] Compressing ${relative}.`);
      const absolute = path.join(config.dataDirectory, ...relative.split('/'));
      const before = await stat(absolute);
      const measured = await compressedSnapshot(absolute, staging);
      await options.afterSnapshot?.(absolute);
      const after = await stat(absolute);
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
        || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
        throw new Error(`Archive source ${relative} changed while it was being captured.`);
      }
      const key = `${config.prefix}/blobs/sha256/${measured.sha256.slice(0, 2)}/${measured.sha256}.gz`;
      const storedSize = await existingBlobSize(store, config.bucket, key, measured);
      if (storedSize !== undefined) {
        options.onProgress?.(`[${index + 1}/${candidates.length}] Reused verified blob for ${relative}.`);
        reusedBlobs += 1;
      } else {
        options.onProgress?.(`[${index + 1}/${candidates.length}] Uploading ${relative} (${measured.compressedBytes} compressed bytes).`);
        // A bounded Buffer avoids unref'ed streaming request bodies on S3-compatible HTTP agents. This
        // runs in the detached archive process, never in the trading/dashboard process.
        const body = await readFile(staging);
        options.onProgress?.(`[${index + 1}/${candidates.length}] Prepared ${body.length} upload bytes for ${relative}.`);
        await store.send(new PutObjectCommand({
          Bucket: config.bucket, Key: key, Body: body, ContentLength: measured.compressedBytes,
          ContentType: 'application/octet-stream', ContentEncoding: 'gzip',
          Metadata: { sha256: measured.sha256, sourcebytes: String(measured.sourceBytes), sourcepath: relative },
        }));
        options.onProgress?.(`[${index + 1}/${candidates.length}] Upload acknowledged for ${relative}; verifying read-back.`);
        await verifyStoredBlob(store, config.bucket, key, measured);
        options.onProgress?.(`[${index + 1}/${candidates.length}] Read-back verification passed for ${relative}.`);
        uploadedBytes += measured.compressedBytes;
        newBlobs += 1;
      }
      files.push({
        path: relative, ...measured, compressedBytes: storedSize ?? measured.compressedBytes, objectKey: key,
        modifiedAt: before.mtime.toISOString(),
      });
    }
    const manifest: LocalArchiveManifest = {
      version: LOCAL_ARCHIVE_VERSION,
      createdAt: attemptAt,
      hostname: options.hostname ?? os.hostname(),
      sourceRoot: 'data',
      files,
      totals: {
        files: files.length,
        sourceBytes: files.reduce((sum, file) => sum + file.sourceBytes, 0),
        compressedBytes: files.reduce((sum, file) => sum + file.compressedBytes, 0),
        newBlobs,
        reusedBlobs,
      },
    };
    validateManifest(config, manifest);
    const manifestKey = await putManifest(store, config, manifest);
    const state: LocalArchiveState = {
      version: LOCAL_ARCHIVE_VERSION,
      lastAttemptAt: attemptAt,
      lastSuccessAt: new Date().toISOString(),
      lastManifestKey: manifestKey,
      files: manifest.totals.files,
      sourceBytes: manifest.totals.sourceBytes,
      uploadedBytes,
      newBlobs,
      reusedBlobs,
    };
    await atomicWrite(statePath(config.dataDirectory), `${JSON.stringify(state, null, 2)}\n`);
    return { manifest, manifestKey };
  } catch (error) {
    const failed: LocalArchiveState = {
      ...(await readLocalArchiveState(config.dataDirectory).catch(() => undefined)),
      version: LOCAL_ARCHIVE_VERSION,
      lastAttemptAt: attemptAt,
      lastError: error instanceof Error ? error.message : 'Unknown archive failure',
    };
    await atomicWrite(statePath(config.dataDirectory), `${JSON.stringify(failed, null, 2)}\n`).catch(() => undefined);
    throw error;
  } finally {
    await rm(staging, { force: true }).catch(() => undefined);
    await release();
  }
}

export interface LocalArchiveRestoreResult {
  manifestKey: string;
  manifestCreatedAt: string;
  manifestSha256: string;
  destination: string;
  files: number;
  sourceBytes: number;
  compressedBytes: number;
}

async function readManifest(
  store: ArchiveObjectStore,
  config: LocalArchiveConfig,
  manifestKey: string,
): Promise<{ manifest: LocalArchiveManifest; sha256: string }> {
  if (!manifestKey.startsWith(`${config.prefix}/manifests/`) || !manifestKey.endsWith('.json')) {
    throw new Error('Archive restore manifest key is outside the configured manifest prefix.');
  }
  const head = await store.send(new HeadObjectCommand({ Bucket: config.bucket, Key: manifestKey })) as {
    Metadata?: Record<string, string>;
  };
  if (head.Metadata?.manifestversion !== LOCAL_ARCHIVE_VERSION || !/^[a-f0-9]{64}$/.test(head.Metadata.sha256 ?? '')) {
    throw new Error('Archive restore manifest metadata is missing or invalid.');
  }
  const response = await store.send(new GetObjectCommand({ Bucket: config.bucket, Key: manifestKey })) as { Body?: unknown };
  if (!response.Body) throw new Error('Archive restore manifest had no body.');
  const chunks: Buffer[] = [];
  for await (const chunk of objectBodyStream(response.Body)) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const raw = Buffer.concat(chunks);
  const digest = createHash('sha256').update(raw).digest('hex');
  if (digest !== head.Metadata.sha256) throw new Error('Archive restore manifest checksum did not match its stored metadata.');
  const manifest = JSON.parse(raw.toString('utf8')) as LocalArchiveManifest;
  validateManifest(config, manifest);
  return { manifest, sha256: digest };
}

/**
 * Restores one complete archive manifest into a new directory. It never overlays active data: bytes are
 * written under a sibling staging directory and the destination appears only after every object verifies.
 */
export async function restoreLocalArchive(
  config: LocalArchiveConfig,
  manifestKey: string,
  destination: string,
  options: { store?: ArchiveObjectStore; onProgress?: (message: string) => void } = {},
): Promise<LocalArchiveRestoreResult> {
  const resolvedDestination = path.resolve(destination);
  const relativeToActiveData = path.relative(config.dataDirectory, resolvedDestination);
  if (!relativeToActiveData || (!relativeToActiveData.startsWith('..') && !path.isAbsolute(relativeToActiveData))) {
    throw new Error('Refusing to restore into or below the active data directory.');
  }
  const existing = await stat(resolvedDestination).then(() => true).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  if (existing) throw new Error(`Archive restore destination already exists: ${resolvedDestination}`);
  const parent = path.dirname(resolvedDestination);
  await mkdir(parent, { recursive: true });
  const staging = path.join(parent, `.${path.basename(resolvedDestination)}.${process.pid}.${crypto.randomUUID()}.restore-tmp`);
  const store = options.store ?? new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    forcePathStyle: false,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    maxAttempts: 2,
    requestHandler: new NodeHttpHandler({ connectionTimeout: 10_000, requestTimeout: 120_000 }),
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  }) as unknown as ArchiveObjectStore;
  try {
    const { manifest, sha256: manifestSha256 } = await readManifest(store, config, manifestKey);
    await mkdir(staging, { recursive: false, mode: 0o700 });
    for (const [index, file] of manifest.files.entries()) {
      options.onProgress?.(`[${index + 1}/${manifest.files.length}] Restoring ${file.path}.`);
      const output = path.join(staging, ...file.path.split('/'));
      await mkdir(path.dirname(output), { recursive: true, mode: 0o700 });
      const temporary = `${output}.${process.pid}.${crypto.randomUUID()}.tmp`;
      const response = await store.send(new GetObjectCommand({ Bucket: config.bucket, Key: file.objectKey })) as { Body?: unknown };
      if (!response.Body) throw new Error(`Archive object ${file.objectKey} had no body during restore.`);
      const hasher = new HashingTransform();
      await pipeline(objectBodyStream(response.Body), createGunzip(), hasher, createWriteStream(temporary, { flags: 'wx', mode: 0o600 }));
      const actual = hasher.hash.digest('hex');
      if (actual !== file.sha256 || hasher.bytes !== file.sourceBytes) {
        throw new Error(`Archive restore verification failed for ${file.path}: expected ${file.sha256}/${file.sourceBytes}, received ${actual}/${hasher.bytes}.`);
      }
      const handle = await open(temporary, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, output);
    }
    await rename(staging, resolvedDestination);
    return {
      manifestKey,
      manifestCreatedAt: manifest.createdAt,
      manifestSha256,
      destination: resolvedDestination,
      files: manifest.totals.files,
      sourceBytes: manifest.totals.sourceBytes,
      compressedBytes: manifest.totals.compressedBytes,
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}
