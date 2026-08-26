import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('walk-forward evaluation scheduling boundary', () => {
  it('keeps evaluation out of the funded background collector', async () => {
    const collector = await readFile(path.join(process.cwd(), 'src/lib/background-collector.ts'), 'utf8');
    expect(collector).not.toContain('model-evaluation-store');
    expect(collector).not.toContain('maybeRunWalkForwardEvaluation');
    expect(collector).not.toContain('runWalkForwardEvaluationOffline');
  });

  it('exposes the writer only through the explicitly gated offline command', async () => {
    const script = await readFile(path.join(process.cwd(), 'scripts/run-walk-forward-evaluation-offline.ts'), 'utf8');
    expect(script).toContain('offlineEvaluationBlockers');
    expect(script).toContain('runWalkForwardEvaluationOffline');
    expect(script).toContain('MONEY_NOODLE_OFFLINE_EVALUATION');
  });
});
