import { lstat, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';

export interface NextCacheCleanupResult {
  removed: string[];
  reclaimedBytes: number;
}

export function hasActiveNextBuildOrDev(processList: string): boolean {
  return processList.split('\n').some((line) => (
    /(?:^|\s)(?:[^\s]*\/)?next(?:\.js)?\s+(?:dev|build)(?:\s|$)/.test(line)
    || /(?:^|\s)npm\s+run\s+(?:dev|build)(?:\s|$)/.test(line)
  ));
}

async function allocatedBytes(root: string): Promise<number> {
  const details = await lstat(root);
  if (details.isSymbolicLink()) throw new Error(`Refusing symlinked Next cache path ${root}.`);
  if (!details.isDirectory()) return details.blocks * 512;
  let total = details.blocks * 512;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const child = path.join(root, entry.name);
    if (entry.isSymbolicLink()) continue;
    total += await allocatedBytes(child);
  }
  return total;
}

/** Removes only Next's rebuildable build and development caches; production output is outside this set. */
export async function cleanupNextBuildCaches(projectRoot: string, processList: string): Promise<NextCacheCleanupResult> {
  if (hasActiveNextBuildOrDev(processList)) throw new Error('Refusing Next cache cleanup while next dev or next build is running.');
  const root = path.resolve(projectRoot);
  const nextDirectory = path.join(root, '.next');
  const nextDetails = await lstat(nextDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!nextDetails) return { removed: [], reclaimedBytes: 0 };
  if (nextDetails.isSymbolicLink() || !nextDetails.isDirectory()) throw new Error('Refusing cleanup because .next is not a real directory.');
  const canonicalNextDirectory = path.join(await realpath(root), '.next');
  if (await realpath(nextDirectory) !== canonicalNextDirectory) throw new Error('Refusing cleanup because .next resolves outside the project path.');

  const removed: string[] = [];
  let reclaimedBytes = 0;
  for (const name of ['cache', 'dev'] as const) {
    const target = path.join(nextDirectory, name);
    const details = await lstat(target).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!details) continue;
    if (details.isSymbolicLink() || !details.isDirectory()) throw new Error(`Refusing cleanup because .next/${name} is not a real directory.`);
    if (await realpath(target) !== path.join(canonicalNextDirectory, name)) throw new Error(`Refusing cleanup because .next/${name} resolves unexpectedly.`);
    reclaimedBytes += await allocatedBytes(target);
    await rm(target, { recursive: true, force: false });
    removed.push(`.next/${name}`);
  }
  return { removed, reclaimedBytes };
}
