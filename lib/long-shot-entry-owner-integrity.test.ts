import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/** Entry ownership is architectural: duplicate callers made trailing depend on queue timing. */
describe('long-shot entry owner integrity', () => {
  it('allows only the trailing entry tick to call the paper and live entry function', async () => {
    const source = await readFile(path.join(process.cwd(), 'lib/paper-execution.ts'), 'utf8');
    const processStart = source.indexOf('async function processCycle(');
    const processEnd = source.indexOf('/**\n * Long-shot entries for one track.', processStart);
    const processCycle = source.slice(processStart, processEnd);
    expect(processCycle).not.toContain('runLongShot(');

    const tickStart = source.indexOf('async function longShotEntryTick(');
    const tickEnd = source.indexOf('/**\n * Runs at one second while nothing is being trailed', tickStart);
    const entryTick = source.slice(tickStart, tickEnd);
    expect(entryTick).toContain("runLongShot(priced, status, ledger, 'paper')");
    expect(entryTick).toContain("runLongShot(priced, status, ledger, 'live')");
    expect(entryTick).toContain('evaluateTrailingEntry(');

    const calls = source.match(/\brunLongShot\(/g) ?? [];
    // One declaration plus the paper/live calls above. Any fourth occurrence reintroduces another owner.
    expect(calls).toHaveLength(3);
  });
});
