// Manifest-to-load reconciliation (#255 review, item 4). Every entry of the last
// manifest is classified exactly once: loaded into a named table, intentionally
// not loaded for a reason the maintainer decided, or UNMAPPED. The job refuses to
// load while any entry is unmapped, so a store the transform never heard of
// cannot vanish without trace. Names are the manifest's own relative paths inside
// the v1 data directory; nothing here is a location.
//
// The decision is `load-scope.ts`'s table, so the classification in the evidence
// document and the stage list the operator uploaded from cannot disagree. This
// module adds only what the table cannot know from a path: which tables the
// transform actually filled, and the one case where a loaded-class entry turns
// out to belong to a generation the active index does not name.

import type { ArchiveManifest } from './archive-manifest.js';
import {
  classifyPath,
  NOT_LOADED_REASONS,
  type LoadScopeRules,
  type NotLoadedReason,
} from './load-scope.js';

export { NOT_LOADED_REASONS, type NotLoadedReason };

export interface LoadedEntry {
  path: string;
  /** The `engine` table(s) the file's rows went to. */
  tables: string[];
}

export interface NotLoadedEntry {
  path: string;
  reason: NotLoadedReason;
  note: string;
}

export interface ManifestClassification {
  manifestFiles: number;
  loaded: LoadedEntry[];
  notLoaded: NotLoadedEntry[];
  unmapped: string[];
  /** Loaded + not loaded + unmapped; equals `manifestFiles` by construction. */
  classified: number;
}

/**
 * What the transform knows about the tree it consumed, recorded while the plan
 * was built so the classification cannot disagree with the load.
 */
export interface ConsumptionRecord {
  /** Files the plan read, with the tables their rows went to. */
  consumed: Map<string, Set<string>>;
}

export function classifyManifest(
  manifest: Pick<ArchiveManifest, 'files'>,
  record: ConsumptionRecord,
  rules: LoadScopeRules,
): ManifestClassification {
  const loaded: LoadedEntry[] = [];
  const notLoaded: NotLoadedEntry[] = [];
  const unmapped: string[] = [];
  const seen = new Set<string>();

  for (const file of [...manifest.files].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const path = file.path;
    if (seen.has(path)) continue;
    seen.add(path);

    const found = classifyPath(path, rules);
    if (found.kind === 'unmapped') {
      unmapped.push(path);
      continue;
    }
    if (found.kind === 'not-loaded') {
      notLoaded.push({ note: found.note, path, reason: found.reason });
      continue;
    }

    // Loaded by the table. What the transform actually filled is authoritative
    // over what the table predicted: the only entry that can be staged and go
    // unread is an open forecast set the active index does not name, because its
    // file name carries its own hash and the index cannot be read while deciding
    // what to stage.
    const tables = record.consumed.get(path);
    if (tables && tables.size > 0) {
      loaded.push({ path, tables: [...tables].sort() });
      continue;
    }
    notLoaded.push({
      note: 'staged as a candidate, then found to belong to a generation the active index does not name',
      path,
      reason: 'superseded',
    });
  }

  return {
    classified: loaded.length + notLoaded.length + unmapped.length,
    loaded,
    manifestFiles: manifest.files.length,
    notLoaded,
    unmapped,
  };
}

export function countByReason(entries: NotLoadedEntry[]): Record<NotLoadedReason, number> {
  const counts = Object.fromEntries(NOT_LOADED_REASONS.map((r) => [r, 0])) as Record<
    NotLoadedReason,
    number
  >;
  for (const entry of entries) counts[entry.reason] += 1;
  return counts;
}
