// Reads an archive that has been staged on a filesystem under the same layout
// the bucket uses: `<root>/<prefix>/manifests/<yyyy>/<mm>/<dd>/<stamp>.json` and
// `<root>/<prefix>/blobs/sha256/<2>/<sha>.gz`. The root and the prefix are job
// inputs; nothing here names a bucket, endpoint or path.

import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';

import { parseArchiveManifest } from '../../domain/archive-manifest.js';
import type { ArchiveSource, DataTree } from '../../domain/archive-source.js';

async function walk(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const child = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(child)));
    else if (entry.isFile()) files.push(child);
  }
  return files;
}

export function createFilesystemArchiveSource(root: string): ArchiveSource {
  return {
    async listManifestKeys() {
      const files = await walk(root);
      return files
        .map((file) => relative(root, file).split(sep).join('/'))
        .filter((key) => /(^|\/)manifests\/.+\.json$/.test(key))
        .sort();
    },
    async readManifest(key) {
      const raw = await readFile(join(root, ...key.split('/')));
      return { manifest: parseArchiveManifest(raw.toString('utf8')), raw };
    },
    async readBlob(objectKey) {
      try {
        const compressed = await readFile(join(root, ...objectKey.split('/')));
        return gunzipSync(compressed);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
      }
    },
  };
}

/** Reads a data directory into a tree keyed by data-relative path. */
export async function readDataDirectory(root: string): Promise<DataTree> {
  const tree: DataTree = new Map();
  for (const file of await walk(root)) {
    tree.set(relative(root, file).split(sep).join('/'), await readFile(file));
  }
  return tree;
}
