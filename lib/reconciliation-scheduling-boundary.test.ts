import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('background reconciliation scheduling boundary', () => {
  it('is started by the persistent runtime and is not awaited by the collector', async () => {
    const root = process.cwd();
    const collector = await readFile(path.join(root, 'lib/background-collector.ts'), 'utf8');
    const instrumentation = await readFile(path.join(root, 'instrumentation.node.ts'), 'utf8');
    expect(collector).not.toContain('periodic-reconciliation');
    expect(collector).not.toContain('maybeRunPeriodicReconciliation');
    expect(instrumentation).toContain('startPeriodicReconciliationScheduler');
  });

  it('launches uncertain-order recovery without returning its venue wait to the collector', async () => {
    const source = await readFile(path.join(process.cwd(), 'lib/paper-execution.ts'), 'utf8');
    expect(source).toContain("void reconcileLiveExecution({ trigger: 'automatic' })");
    expect(source).not.toContain("await reconcileLiveExecution({ trigger: 'automatic' })");
  });
});
