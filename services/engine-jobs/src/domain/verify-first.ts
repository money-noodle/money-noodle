// The verify-first step of ADR-0013 §1: whether a successful archive run completed
// after the v1 worker's final write is unknown, so the last manifest is compared
// with the workstation copy and the finding is written down before anything loads.
//
// The comparison is over the **load scope**, not the whole manifest (maintainer
// decision 2026-10-08): the question it answers is whether what the job is about
// to load is the same stopping point the workstation holds, and an entry the scope
// leaves in the archive is never loaded, so a difference in it cannot change a
// loaded row. Entries outside the scope are counted — on both sides — and the
// counts are in the evidence document, so "we compared a subset" is a number a
// reader can see rather than something they have to infer.

import { isArchiveCandidate, type ArchiveManifest } from './archive-manifest.js';
import type { DataTree } from './archive-source.js';
import { sha256Hex } from './sha256.js';

export type ManifestFinding = 'complete' | 'incomplete' | 'differing' | 'workstation-absent';

export interface FileComparison {
  path: string;
  state: 'equal' | 'differs' | 'missing-in-workstation' | 'missing-in-manifest';
  manifestSha256?: string;
  workstationSha256?: string;
  manifestBytes?: number;
  workstationBytes?: number;
}

export interface VerifyFirstFinding {
  finding: ManifestFinding;
  manifestCreatedAt: string;
  manifestFiles: number;
  workstationFiles: number;
  equal: number;
  differing: number;
  missingInWorkstation: number;
  missingInManifest: number;
  files: FileComparison[];
  /** Manifest entries inside the load scope. Only these are compared. */
  comparedFiles: number;
  /** Manifest entries the scope leaves in the archive: counted, not compared. */
  retainedManifestFiles: number;
  /** Archive-eligible workstation files outside the scope: counted, not compared. */
  retainedWorkstationOnly: number;
  /** True when the job may proceed to load from the archive. */
  loadPermitted: boolean;
  reason: string;
}

/**
 * Classifies the last manifest against the workstation copy.
 *
 * Only manifest entries inside `load` take part; the rest are counted. With no
 * `load` the whole manifest is compared, which is what the unit tests do.
 *
 * - `complete`: every compared manifest file exists in the workstation copy with
 *   the same sha256, and the workstation holds no in-scope archive-eligible file
 *   the manifest lacks.
 * - `incomplete`: the workstation holds eligible files the manifest does not list,
 *   which is what a final write after the last archive run looks like.
 * - `differing`: the same set of files, but at least one hash differs.
 * - `workstation-absent`: no workstation copy was supplied, so completeness cannot
 *   be established from the manifest alone.
 *
 * Load is permitted only on `complete`. The acceptance rule names the case that
 * must refuse — an incomplete manifest with no workstation copy — and the
 * conservative reading applied here is that an unverifiable manifest is treated
 * as incomplete, so `workstation-absent` refuses too unless the operator passes
 * the documented override.
 */
export function compareManifestWithWorkstation(
  manifest: ArchiveManifest,
  workstation: DataTree | undefined,
  /**
   * Whether a data-directory path is inside the active load scope. Absent
   * compares everything. It is a predicate rather than the staged set because the
   * workstation side asks the question of paths the manifest has never seen,
   * which is exactly the "a store was written after the last archive run" case
   * the finding exists to catch.
   */
  inScope: (path: string) => boolean = () => true,
): VerifyFirstFinding {
  const compared = manifest.files.filter((file) => inScope(file.path));
  const base = {
    manifestCreatedAt: manifest.createdAt,
    manifestFiles: manifest.files.length,
    comparedFiles: compared.length,
    retainedManifestFiles: manifest.files.length - compared.length,
  };
  if (!workstation) {
    return {
      ...base,
      finding: 'workstation-absent',
      workstationFiles: 0,
      equal: 0,
      differing: 0,
      missingInWorkstation: compared.length,
      missingInManifest: 0,
      retainedWorkstationOnly: 0,
      files: compared.map((file) => ({
        path: file.path,
        state: 'missing-in-workstation' as const,
        manifestSha256: file.sha256,
        manifestBytes: file.sourceBytes,
      })),
      loadPermitted: false,
      reason:
        'No workstation copy was supplied, so whether the last manifest is a complete stopping point cannot be established. Supply the workstation copy, or pass the documented override after recording why.',
    };
  }

  const files: FileComparison[] = [];
  // Every manifest path, in scope or not: a retained entry the workstation also
  // holds is not "absent from the manifest".
  const manifestPaths = new Set(manifest.files.map((file) => file.path));
  for (const file of compared) {
    const bytes = workstation.get(file.path);
    if (bytes === undefined) {
      files.push({
        path: file.path,
        state: 'missing-in-workstation',
        manifestSha256: file.sha256,
        manifestBytes: file.sourceBytes,
      });
      continue;
    }
    const digest = sha256Hex(bytes);
    files.push({
      path: file.path,
      state: digest === file.sha256 && bytes.byteLength === file.sourceBytes ? 'equal' : 'differs',
      manifestSha256: file.sha256,
      workstationSha256: digest,
      manifestBytes: file.sourceBytes,
      workstationBytes: bytes.byteLength,
    });
  }
  let workstationFiles = 0;
  let retainedWorkstationOnly = 0;
  for (const [path, bytes] of [...workstation.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!isArchiveCandidate(path)) continue;
    workstationFiles += 1;
    if (manifestPaths.has(path)) continue;
    if (!inScope(path)) {
      retainedWorkstationOnly += 1;
      continue;
    }
    files.push({
      path,
      state: 'missing-in-manifest',
      workstationSha256: sha256Hex(bytes),
      workstationBytes: bytes.byteLength,
    });
  }
  const count = (state: FileComparison['state']) => files.filter((f) => f.state === state).length;
  const equal = count('equal');
  const differing = count('differs');
  const missingInWorkstation = count('missing-in-workstation');
  const missingInManifest = count('missing-in-manifest');

  let finding: ManifestFinding;
  let reason: string;
  if (missingInManifest > 0) {
    finding = 'incomplete';
    reason = `The workstation copy holds ${missingInManifest} archive-eligible file(s) inside the load scope that the last manifest does not list; the last archive run did not capture the final state.`;
  } else if (differing > 0 || missingInWorkstation > 0) {
    finding = 'differing';
    reason = `${differing} file(s) differ between the last manifest and the workstation copy and ${missingInWorkstation} manifest file(s) are absent from it; the two copies are not the same stopping point.`;
  } else {
    finding = 'complete';
    reason = `All ${equal} manifest files inside the load scope are present in the workstation copy with matching sha256 and byte counts, and the workstation holds no in-scope eligible file outside the manifest. ${base.retainedManifestFiles} manifest entr${base.retainedManifestFiles === 1 ? 'y' : 'ies'} and ${retainedWorkstationOnly} workstation file(s) are outside the scope and were counted, not compared.`;
  }
  return {
    ...base,
    finding,
    workstationFiles,
    equal,
    differing,
    missingInWorkstation,
    missingInManifest,
    retainedWorkstationOnly,
    files: files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    loadPermitted: finding === 'complete',
    reason,
  };
}
