// Verifies every sha256 the job loads against the blobs and materialises the
// restored tree in memory. Ported from the v1 archive's restore path, sanitized:
// the same checks (decompressed digest and byte count against the manifest), no
// paths, no provider.
//
// Only the loaded set is fetched (maintainer decision 2026-10-08). An entry the
// scope leaves in the archive is neither downloaded nor digested — it was never
// staged, so a missing blob for it is not a failure — and is reported by
// `load-scope.ts`'s table with the manifest's own hash and size instead. A
// missing or corrupt blob inside the loaded set refuses the load exactly as
// before.

import type { ArchiveManifest } from './archive-manifest.js';
import type { ArchiveSource, DataTree } from './archive-source.js';
import { sha256Hex } from './sha256.js';

export interface BlobVerification {
  path: string;
  sha256: string;
  state: 'verified' | 'missing' | 'checksum-mismatch' | 'byte-count-mismatch';
  actualSha256?: string;
  actualBytes?: number;
}

export interface RestoredTree {
  tree: DataTree;
  verifications: BlobVerification[];
  ok: boolean;
}

export async function restoreTreeFromArchive(
  source: ArchiveSource,
  manifest: ArchiveManifest,
  /** Data-directory paths to fetch. Absent means the whole manifest. */
  load?: ReadonlySet<string>,
): Promise<RestoredTree> {
  const tree: DataTree = new Map();
  const verifications: BlobVerification[] = [];
  for (const file of manifest.files) {
    if (load !== undefined && !load.has(file.path)) continue;
    const bytes = await source.readBlob(file.objectKey);
    if (bytes === undefined) {
      verifications.push({ path: file.path, sha256: file.sha256, state: 'missing' });
      continue;
    }
    const actualSha256 = sha256Hex(bytes);
    if (actualSha256 !== file.sha256) {
      verifications.push({
        path: file.path,
        sha256: file.sha256,
        state: 'checksum-mismatch',
        actualSha256,
        actualBytes: bytes.byteLength,
      });
      continue;
    }
    if (bytes.byteLength !== file.sourceBytes) {
      verifications.push({
        path: file.path,
        sha256: file.sha256,
        state: 'byte-count-mismatch',
        actualSha256,
        actualBytes: bytes.byteLength,
      });
      continue;
    }
    tree.set(file.path, bytes);
    verifications.push({ path: file.path, sha256: file.sha256, state: 'verified' });
  }
  return { tree, verifications, ok: verifications.every((v) => v.state === 'verified') };
}
