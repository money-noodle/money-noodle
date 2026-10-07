// The v1 archive contract: content-addressed gzip blobs under
// `blobs/sha256/<first two hex>/<sha256>.gz` and one JSON manifest per run that
// lists every captured file with its sha256, byte counts and object key.
// Validation ported from the v1 archive's local-data-archive module, sanitized:
// the manifest's own prefix is read back rather than configured, and no
// endpoint, bucket or region appears anywhere in this family.

import { SHA256_HEX } from './sha256.js';

export const ARCHIVE_MANIFEST_VERSION = 'money-noodle-local-archive-v1';

export interface ArchiveManifestFile {
  path: string;
  sourceBytes: number;
  compressedBytes: number;
  sha256: string;
  objectKey: string;
  modifiedAt: string;
}

export interface ArchiveManifest {
  version: typeof ARCHIVE_MANIFEST_VERSION;
  createdAt: string;
  hostname: string;
  sourceRoot: string;
  files: ArchiveManifestFile[];
  totals: {
    files: number;
    sourceBytes: number;
    compressedBytes: number;
    newBlobs: number;
    reusedBlobs: number;
  };
}

export class ArchiveManifestError extends Error {
  override readonly name = 'ArchiveManifestError';
}

function safeManifestPath(relative: string): boolean {
  if (!relative || relative.includes('\\') || relative.includes('\0') || relative.startsWith('/')) {
    return false;
  }
  const parts = relative.split('/');
  return parts.every((part) => part !== '' && part !== '.' && part !== '..');
}

export function blobObjectKey(prefix: string, sha256: string): string {
  const head = prefix ? `${prefix}/` : '';
  return `${head}blobs/sha256/${sha256.slice(0, 2)}/${sha256}.gz`;
}

/** The archive prefix a manifest was written under, read from its first object key. */
export function manifestPrefix(manifest: Pick<ArchiveManifest, 'files'>): string {
  const first = manifest.files[0];
  if (!first) return '';
  const marker = first.objectKey.indexOf('blobs/sha256/');
  return marker <= 0 ? '' : first.objectKey.slice(0, marker - 1);
}

export function parseArchiveManifest(raw: string): ArchiveManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ArchiveManifestError('Archive manifest is not valid JSON.');
  }
  const manifest = parsed as Partial<ArchiveManifest>;
  if (
    manifest.version !== ARCHIVE_MANIFEST_VERSION ||
    manifest.sourceRoot !== 'data' ||
    !Array.isArray(manifest.files) ||
    typeof manifest.createdAt !== 'string' ||
    !manifest.totals
  ) {
    throw new ArchiveManifestError('Archive manifest version or source root is invalid.');
  }
  const prefix = manifestPrefix(manifest as ArchiveManifest);
  const seen = new Set<string>();
  for (const file of manifest.files) {
    if (!safeManifestPath(file.path)) {
      throw new ArchiveManifestError(
        `Archive manifest contained unsafe path ${JSON.stringify(file.path)}.`,
      );
    }
    if (seen.has(file.path)) {
      throw new ArchiveManifestError(`Archive manifest contained duplicate path ${file.path}.`);
    }
    seen.add(file.path);
    if (!SHA256_HEX.test(file.sha256)) {
      throw new ArchiveManifestError(
        `Archive manifest contained an invalid checksum for ${file.path}.`,
      );
    }
    if (
      !Number.isSafeInteger(file.sourceBytes) ||
      file.sourceBytes < 0 ||
      !Number.isSafeInteger(file.compressedBytes) ||
      file.compressedBytes < 0
    ) {
      throw new ArchiveManifestError(
        `Archive manifest contained invalid byte counts for ${file.path}.`,
      );
    }
    if (file.objectKey !== blobObjectKey(prefix, file.sha256)) {
      throw new ArchiveManifestError(
        `Archive manifest object key for ${file.path} was not content-addressed under the manifest's prefix.`,
      );
    }
  }
  const sourceBytes = manifest.files.reduce((sum, file) => sum + file.sourceBytes, 0);
  const compressedBytes = manifest.files.reduce((sum, file) => sum + file.compressedBytes, 0);
  if (
    manifest.totals.files !== manifest.files.length ||
    manifest.totals.sourceBytes !== sourceBytes ||
    manifest.totals.compressedBytes !== compressedBytes
  ) {
    throw new ArchiveManifestError('Archive manifest totals did not match its file records.');
  }
  return manifest as ArchiveManifest;
}

/**
 * Whether a data-directory file is one the v1 archive would have captured. Ported
 * from the v1 archive's candidate filter so the workstation comparison asks the
 * same question the writer asked: hidden files, locks, temps and the archive's
 * own state file are excluded by design and are never "missing".
 */
export function isArchiveCandidate(relativePath: string): boolean {
  const normalized = relativePath.split('\\').join('/');
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  if (base === 'archive-state.json' || normalized.split('/').some((part) => part.startsWith('.'))) {
    return false;
  }
  if (base.includes('.tmp') || base.endsWith('.lock')) return false;
  return /\.jsonl?(?:$|\.)/.test(base) || base.endsWith('.journal-copy');
}
