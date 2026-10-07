// The verify-first step of ADR-0013 §1: whether a successful archive run completed
// after the v1 worker's final write is unknown, so the last manifest is compared
// with the workstation copy and the finding is written down before anything loads.

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
  /** True when the job may proceed to load from the archive. */
  loadPermitted: boolean;
  reason: string;
}

/**
 * Classifies the last manifest against the workstation copy.
 *
 * - `complete`: every manifest file exists in the workstation copy with the same
 *   sha256, and the workstation holds no archive-eligible file the manifest lacks.
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
): VerifyFirstFinding {
  const base = {
    manifestCreatedAt: manifest.createdAt,
    manifestFiles: manifest.files.length,
  };
  if (!workstation) {
    return {
      ...base,
      finding: 'workstation-absent',
      workstationFiles: 0,
      equal: 0,
      differing: 0,
      missingInWorkstation: manifest.files.length,
      missingInManifest: 0,
      files: manifest.files.map((file) => ({
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
  const manifestPaths = new Set<string>();
  for (const file of manifest.files) {
    manifestPaths.add(file.path);
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
  for (const [path, bytes] of [...workstation.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!isArchiveCandidate(path)) continue;
    workstationFiles += 1;
    if (!manifestPaths.has(path)) {
      files.push({
        path,
        state: 'missing-in-manifest',
        workstationSha256: sha256Hex(bytes),
        workstationBytes: bytes.byteLength,
      });
    }
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
    reason = `The workstation copy holds ${missingInManifest} archive-eligible file(s) the last manifest does not list; the last archive run did not capture the final state.`;
  } else if (differing > 0 || missingInWorkstation > 0) {
    finding = 'differing';
    reason = `${differing} file(s) differ between the last manifest and the workstation copy and ${missingInWorkstation} manifest file(s) are absent from it; the two copies are not the same stopping point.`;
  } else {
    finding = 'complete';
    reason = `All ${equal} manifest files are present in the workstation copy with matching sha256 and byte counts, and the workstation holds no eligible file outside the manifest.`;
  }
  return {
    ...base,
    finding,
    workstationFiles,
    equal,
    differing,
    missingInWorkstation,
    missingInManifest,
    files: files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    loadPermitted: finding === 'complete',
    reason,
  };
}
