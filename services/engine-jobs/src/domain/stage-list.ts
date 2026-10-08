// What to upload, and nothing more.
//
// The restore reads a staged copy of the archive layout, so before an execution
// the operator has to put the right objects in the staging bucket. Under the
// `authoritative` load scope that is a small fraction of the archive, and which
// fraction is decidable from the manifest alone — which is what this module
// answers, so the operator never has to guess and never has to sync the whole
// thing "to be safe".
//
// Output contract: one archive object key per line on stdout, the manifest first,
// so the list pipes straight into a copy loop; the human summary goes to stderr
// for the same reason. Keys are the archive's own content-addressed layout
// (`<prefix>/blobs/sha256/<2>/<sha>.gz`); no bucket, endpoint or local path
// appears here or in the output.

import type { ArchiveManifest, ArchiveManifestFile } from './archive-manifest.js';
import { classifyPath, rulesFor, type LoadScope, type NotLoadedReason } from './load-scope.js';

export interface StagedObject {
  /** The manifest's relative path inside the v1 data directory. */
  path: string;
  /** The archive object key to copy, relative to the archive prefix root. */
  objectKey: string;
  sha256: string;
  sourceBytes: number;
  compressedBytes: number;
}

export interface RetainedObject {
  path: string;
  sha256: string;
  sourceBytes: number;
  compressedBytes: number;
  reason: NotLoadedReason;
  note: string;
}

export interface StagePlan {
  scope: LoadScope;
  /** Objects the job will fetch and verify. */
  staged: StagedObject[];
  /** Manifest entries left in the archive, with the manifest's own hash and size. */
  retained: RetainedObject[];
  /** Entries the table classifies as neither; staged defensively so nothing vanishes. */
  unmapped: StagedObject[];
  stagedSourceBytes: number;
  stagedCompressedBytes: number;
  retainedSourceBytes: number;
  retainedCompressedBytes: number;
}

const staged = (file: ArchiveManifestFile): StagedObject => ({
  compressedBytes: file.compressedBytes,
  objectKey: file.objectKey,
  path: file.path,
  sha256: file.sha256,
  sourceBytes: file.sourceBytes,
});

const sum = (values: { compressedBytes: number; sourceBytes: number }[]) => ({
  compressed: values.reduce((total, value) => total + value.compressedBytes, 0),
  source: values.reduce((total, value) => total + value.sourceBytes, 0),
});

/**
 * Splits the manifest into what the scope loads and what it leaves in the
 * archive. An UNMAPPED entry is staged and fetched: the job refuses on it later
 * anyway, and an entry nobody has classified is exactly the one a human should be
 * able to look at rather than one the stage list silently omits.
 */
export function planStaging(manifest: Pick<ArchiveManifest, 'files'>, scope: LoadScope): StagePlan {
  const rules = rulesFor(scope);
  const stagedObjects: StagedObject[] = [];
  const retained: RetainedObject[] = [];
  const unmapped: StagedObject[] = [];
  for (const file of [...manifest.files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const found = classifyPath(file.path, rules);
    if (found.kind === 'loaded') stagedObjects.push(staged(file));
    else if (found.kind === 'unmapped') unmapped.push(staged(file));
    else {
      retained.push({
        compressedBytes: file.compressedBytes,
        note: found.note,
        path: file.path,
        reason: found.reason,
        sha256: file.sha256,
        sourceBytes: file.sourceBytes,
      });
    }
  }
  const stagedTotals = sum([...stagedObjects, ...unmapped]);
  const retainedTotals = sum(retained);
  return {
    retained,
    retainedCompressedBytes: retainedTotals.compressed,
    retainedSourceBytes: retainedTotals.source,
    scope,
    staged: stagedObjects,
    stagedCompressedBytes: stagedTotals.compressed,
    stagedSourceBytes: stagedTotals.source,
    unmapped,
  };
}

/** Every data-directory path the staged set covers, for the scoped comparisons. */
export const stagedPaths = (plan: StagePlan): ReadonlySet<string> =>
  new Set([...plan.staged, ...plan.unmapped].map((object) => object.path));

/** Every archive object key to copy, manifest first, one per line. */
export function stageListLines(plan: StagePlan, manifestKey: string): string[] {
  return [manifestKey, ...[...plan.staged, ...plan.unmapped].map((object) => object.objectKey)];
}

export function stageListSummary(plan: StagePlan): string {
  const files = plan.staged.length + plan.unmapped.length + 1;
  const unmapped = plan.unmapped.length
    ? `, ${plan.unmapped.length} unmapped (staged so the refusal can name them)`
    : '';
  return (
    `${files} files to stage (1 manifest + ${plan.staged.length + plan.unmapped.length} blobs), ` +
    `${plan.stagedCompressedBytes} bytes compressed / ${plan.stagedSourceBytes} uncompressed${unmapped}; ` +
    `${plan.retained.length} entries left in the archive, ${plan.retainedCompressedBytes} bytes compressed ` +
    `(load scope ${plan.scope})`
  );
}
