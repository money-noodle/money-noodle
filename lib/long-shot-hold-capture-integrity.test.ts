import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/** The v1 defect was wiring, not arithmetic; protect the authoritative runtime boundary explicitly. */
describe('long-shot hold capture integrity', () => {
  it('captures and durably reconciles the sentinel inside the paper entry path', async () => {
    const source = await readFile(path.join(process.cwd(), 'lib/paper-execution.ts'), 'utf8');
    const start = source.indexOf('async function runLongShot(');
    const end = source.indexOf('/**\n * One pass of the long-shot exit poll', start);
    const runLongShot = source.slice(start, end);
    expect(runLongShot).toContain('order.holdSentinelVersion = HOLD_SENTINEL_VERSION');
    expect(runLongShot).toContain('holdSentinelFromStampedPaperOrder(order)');
    expect(runLongShot).toContain('await writeLedger(ledger)');
    expect(runLongShot).toContain('await updateHoldSentinelStore');
  });

  it('does not recreate triggers in the detached dashboard collector', async () => {
    const source = await readFile(path.join(process.cwd(), 'lib/long-shot-execution.ts'), 'utf8');
    expect(source).not.toContain('Collection only: the long-shot execution path is not wired in yet.');
    expect(source).not.toContain('export function longShotCycle(');
    expect(source).toContain('holdSentinelFromStampedPaperOrder(order)');
  });
});
