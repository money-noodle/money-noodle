import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (file: string) => readFileSync(path.join(process.cwd(), 'src/lib', file), 'utf8');

const forbiddenReaders = [
  'prediction-policy.ts', 'signal-persistence.ts', 'portfolio-policy.ts',
  'entry-execution-policy.ts', 'entry-sizing-policy.ts', 'live-orders.ts', 'live-risk-policy.ts',
  'trading-control.ts', 'provider-budget-store.ts', 'budget-ledger.ts',
  'execution-reconciliation.ts', 'periodic-reconciliation.ts', 'settlement-average.ts',
  'public-paper-performance.ts',
];

describe('paper execution timing shadow isolation', () => {
  it('keeps timing evidence out of policy, live authority, money, settlement, and public projection', () => {
    for (const file of forbiddenReaders) {
      expect(source(file), file).not.toContain('paper-execution-timing');
      expect(source(file), file).not.toContain('PaperExecutionTiming');
    }
  });

  it('lets the paper orchestrator launch observers but never read their store or result', () => {
    const orchestrator = source('paper-execution.ts');
    expect(orchestrator).toContain("from './paper-execution-timing-observer'");
    expect(orchestrator.indexOf('await writeLedger(ledger);', orchestrator.indexOf('if (startedPaperOrders.length)')))
      .toBeLessThan(orchestrator.indexOf('startPaperExecutionTimingObservers(startedPaperOrders)'));
    expect(orchestrator).not.toContain('await startPaperExecutionTimingObservers');
    expect(orchestrator).not.toContain("from './paper-execution-timing-shadow-store'");
    expect(orchestrator).not.toContain('getPaperExecutionTimingShadows');
  });

  it('keeps the observer independent of live outcomes and authoritative account state', () => {
    const observer = source('paper-execution-timing-observer.ts');
    expect(observer).not.toContain("from './live-orders'");
    expect(observer).not.toContain("from './execution-reconciliation'");
    expect(observer).not.toContain("from './provider-budget-store'");
    expect(observer).not.toContain('venueOrderId');
    expect(observer).not.toContain('actualPnlCents');
  });
});
