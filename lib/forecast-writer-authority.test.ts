import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

async function sourceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(target));
    else if (/\.(?:ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.test.ts')) files.push(target);
  }
  return files;
}

describe('forecast writer authority', () => {
  it('keeps calculation recording out of every request and rendering entrypoint', async () => {
    const files = [...await sourceFiles(path.resolve('app')), ...await sourceFiles(path.resolve('lib'))];
    const calculationWriters: string[] = [];
    const resolutionWriters: string[] = [];
    for (const file of files) {
      const source = await readFile(file, 'utf8');
      if (source.includes('recordCollectorCalculations')) calculationWriters.push(path.relative(process.cwd(), file));
      if (source.includes('resolveDueForecasts')) resolutionWriters.push(path.relative(process.cwd(), file));
    }
    expect(calculationWriters.sort()).toEqual(['lib/background-collector.ts', 'lib/forecast-tracker.ts']);
    expect(resolutionWriters.sort()).toEqual(['lib/background-collector.ts', 'lib/forecast-tracker.ts']);
    expect(await readFile(path.resolve('lib/dashboard.ts'), 'utf8')).not.toContain('trackCalculations');
  });
});
