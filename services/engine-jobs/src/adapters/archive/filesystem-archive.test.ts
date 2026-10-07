import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { syntheticArchive, syntheticDataTree } from '../../test-support/synthetic-archive.js';
import { createFilesystemArchiveSource, readDataDirectory } from './filesystem-archive.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('the filesystem archive source', () => {
  it('lists manifests oldest first, reads blobs by object key and reads a data directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'engine-jobs-archive-'));
    roots.push(root);
    const tree = syntheticDataTree();
    const archive = syntheticArchive(tree);
    for (const [key, bytes] of archive.objects) {
      const file = join(root, ...key.split('/'));
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, bytes);
    }
    const older = archive.manifestKey.replace('2026/01/02', '2026/01/01');
    await mkdir(dirname(join(root, ...older.split('/'))), { recursive: true });
    await writeFile(join(root, ...older.split('/')), archive.objects.get(archive.manifestKey)!);

    const source = createFilesystemArchiveSource(root);
    expect(await source.listManifestKeys()).toEqual([older, archive.manifestKey]);
    const { manifest } = await source.readManifest(archive.manifestKey);
    expect(manifest.files.length).toBe(tree.size);
    const first = manifest.files[0]!;
    expect(
      Buffer.from((await source.readBlob(first.objectKey))!).equals(
        Buffer.from(tree.get(first.path)!),
      ),
    ).toBe(true);
    expect(
      await source.readBlob('synthetic/v1/blobs/sha256/00/' + '0'.repeat(64) + '.gz'),
    ).toBeUndefined();

    const dataRoot = join(root, 'data-copy');
    for (const [path, bytes] of tree) {
      await mkdir(dirname(join(dataRoot, ...path.split('/'))), { recursive: true });
      await writeFile(join(dataRoot, ...path.split('/')), bytes);
    }
    const read = await readDataDirectory(dataRoot);
    expect([...read.keys()].sort()).toEqual([...tree.keys()].sort());
  });
});
