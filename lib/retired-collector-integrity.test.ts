import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();

/** Retired evidence lanes stay readable, but must not regain runtime or package-command wiring. */
describe('retired collector integrity', () => {
  it('keeps the completed persistence candidate and maker observer off the execution cycle', async () => {
    const source = await readFile(path.join(root, 'lib/paper-execution.ts'), 'utf8');
    expect(source).not.toContain('persistenceCandidateCycle');
    expect(source).not.toContain('updatePersistenceCandidateStore');
    expect(source).not.toContain('observeMakerPosts');
  });

  it('does not expose the invalid depth collection or historical backfill as package commands', async () => {
    const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
    expect(packageJson.scripts).not.toHaveProperty('experiment:maker-depth');
    expect(packageJson.scripts).not.toHaveProperty('backfill:maker-posts');
  });

  it('fails closed when either retired historical script is invoked directly', async () => {
    const experiment = await readFile(path.join(root, 'scripts/experiment-maker-depth.ts'), 'utf8');
    const backfill = await readFile(path.join(root, 'scripts/backfill-maker-post-observations.ts'), 'utf8');
    expect(experiment).toContain("throw new Error('Retired: maker-depth-experiment-v1 discarded takerSide");
    expect(backfill).toContain("throw new Error('Retired: the completed persistence sentinel");
  });
});
