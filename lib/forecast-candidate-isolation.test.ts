import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const moneyPath = [
  'prediction-policy.ts',
  'signal-persistence.ts',
  'asset-exclusion.ts',
  'portfolio-policy.ts',
  'entry-execution-policy.ts',
  'paper-execution.ts',
  'live-orders.ts',
];

describe('forecast candidate isolation', () => {
  it('keeps observation-only candidates out of every decision and money module', () => {
    for (const file of moneyPath) {
      const source = readFileSync(path.join(process.cwd(), 'lib', file), 'utf8');
      expect(source, file).not.toContain('forecast-candidates');
      expect(source, file).not.toContain('candidateEvaluation');
    }
  });
});
