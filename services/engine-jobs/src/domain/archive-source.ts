import type { ArchiveManifest } from './archive-manifest.js';

/**
 * Where the archive is read from. The job never writes to it. The production
 * adapter reads a copy of the bucket prefix the operator has staged on a
 * filesystem; the fixture adapter is the same code over a synthetic tree.
 */
export interface ArchiveSource {
  /** Manifest keys, oldest first; the restore uses the last one. */
  listManifestKeys(): Promise<string[]>;
  readManifest(key: string): Promise<{ manifest: ArchiveManifest; raw: Uint8Array }>;
  /** The decompressed bytes of one blob, or undefined when the object is absent. */
  readBlob(objectKey: string): Promise<Uint8Array | undefined>;
}

/** A tree of files by data-directory relative path, as bytes. */
export type DataTree = Map<string, Uint8Array>;

export function readTreeText(tree: DataTree, path: string): string | undefined {
  const bytes = tree.get(path);
  return bytes === undefined ? undefined : Buffer.from(bytes).toString('utf8');
}

export function readTreeJson<T>(tree: DataTree, path: string): T | undefined {
  const text = readTreeText(tree, path);
  return text === undefined ? undefined : (JSON.parse(text) as T);
}
