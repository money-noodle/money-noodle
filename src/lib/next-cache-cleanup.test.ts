import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupNextBuildCaches, hasActiveNextBuildOrDev } from './next-cache-cleanup';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'money-noodle-next-cleanup-'));
  roots.push(root);
  for (const directory of ['.next/cache/turbopack', '.next/dev/cache', '.next/server', '.next/static']) {
    await mkdir(path.join(root, directory), { recursive: true });
  }
  await writeFile(path.join(root, '.next/cache/turbopack/cache.bin'), 'build cache');
  await writeFile(path.join(root, '.next/dev/cache/dev.bin'), 'dev cache');
  await writeFile(path.join(root, '.next/server/server.js'), 'production server');
  await writeFile(path.join(root, '.next/static/client.js'), 'production static');
  return root;
}

describe('Next cache cleanup', () => {
  it('recognizes build and development processes but permits production next-server', () => {
    expect(hasActiveNextBuildOrDev('123 node node_modules/next/dist/bin/next build\n')).toBe(true);
    expect(hasActiveNextBuildOrDev('123 npm run dev\n')).toBe(true);
    expect(hasActiveNextBuildOrDev('123 next-server (v16.3.0)\n')).toBe(false);
  });

  it('removes only rebuildable caches and preserves production output', async () => {
    const root = await fixture();
    const result = await cleanupNextBuildCaches(root, '123 next-server (v16.3.0)\n');
    expect(result.removed).toEqual(['.next/cache', '.next/dev']);
    expect(result.reclaimedBytes).toBeGreaterThan(0);
    await expect(stat(path.join(root, '.next/cache'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(path.join(root, '.next/dev'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(path.join(root, '.next/server/server.js'), 'utf8')).toBe('production server');
    expect(await readFile(path.join(root, '.next/static/client.js'), 'utf8')).toBe('production static');
  });

  it('refuses cleanup while next dev/build runs', async () => {
    const root = await fixture();
    await expect(cleanupNextBuildCaches(root, 'node /project/node_modules/next/dist/bin/next dev\n')).rejects.toThrow('next dev or next build');
    expect(await readFile(path.join(root, '.next/cache/turbopack/cache.bin'), 'utf8')).toBe('build cache');
  });

  it('refuses a symlinked cache target without touching its destination', async () => {
    const root = await fixture();
    const outside = await mkdtemp(path.join(os.tmpdir(), 'money-noodle-next-outside-'));
    roots.push(outside);
    await writeFile(path.join(outside, 'keep'), 'keep');
    await rm(path.join(root, '.next/cache'), { recursive: true });
    await symlink(outside, path.join(root, '.next/cache'));
    await expect(cleanupNextBuildCaches(root, '')).rejects.toThrow('not a real directory');
    expect(await readFile(path.join(outside, 'keep'), 'utf8')).toBe('keep');
  });
});
