import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENTRY_ADMISSION_FEE_ROLE, venueFeeRate } from './prediction-policy';

describe('entry fee semantics', () => {
  it('keeps shared admission on immediate taker economics', () => {
    expect(ENTRY_ADMISSION_FEE_ROLE).toBe('taker');
    expect(venueFeeRate('kalshi', 0.5, ENTRY_ADMISSION_FEE_ROLE)).toBeCloseTo(0.0175, 12);
  });

  it('makes adaptive taker and maker economics independent of the admission constant', async () => {
    const source = await readFile(path.join(process.cwd(), 'lib/paper-execution.ts'), 'utf8');
    const start = source.indexOf('function entryExecutionDecision(');
    const end = source.indexOf('export function applyTakerQuoteMovementReserve', start);
    const decision = source.slice(start, end);
    expect(decision).toContain("currentNetEdge: probability - ask - venueFeeRate('kalshi', ask, 'taker')");
    expect(decision).toContain("makerNetEdge: probability - bid - venueFeeRate('kalshi', bid, 'maker')");
    expect(decision).not.toContain('ENTRY_ADMISSION_FEE_ROLE');
  });

  it('prices ask and maker counterfactuals with their own roles', async () => {
    const source = await readFile(path.join(process.cwd(), 'lib/maker-shadow.ts'), 'utf8');
    expect(source).toContain("venueFeeRate(order.venue, price, 'taker')");
    expect(source).toContain("venueFeeRate(order.venue, bid, 'maker')");
  });
});
