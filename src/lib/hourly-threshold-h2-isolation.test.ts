import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const source = (file: string) => readFileSync(path.join(process.cwd(), 'src/lib', file), 'utf8');

describe('hourly threshold H2 isolation', () => {
  it('keeps the observation store and observer out of money, policy, settlement-write, and reconciliation readers', () => {
    for (const file of [
      'prediction-policy.ts', 'signal-persistence.ts', 'portfolio-policy.ts', 'paper-execution.ts',
      'live-orders.ts', 'provider-budget-store.ts', 'budget-ledger.ts', 'execution-reconciliation.ts',
      'periodic-reconciliation.ts', 'settlement-average.ts', 'trading-control.ts',
    ]) {
      expect(source(file), file).not.toContain('hourly-threshold-observation');
      expect(source(file), file).not.toContain('HourlyThresholdObservation');
    }
  });

  it('allows only the persistent background owner to start the detached observer', () => {
    const collector = source('background-collector.ts');
    expect(collector).toContain("from './hourly-threshold-observer'");
    expect(collector).toContain('startHourlyThresholdObserver();');
    expect(collector).not.toContain('await startHourlyThresholdObserver');
    expect(collector).not.toContain('getHourlyThresholdObservationStore');
    expect(source('hourly-threshold-observer.ts')).toContain('isStatelessDeployment()');
  });

  it('keeps H2 disconnected from paper and live capability changes', () => {
    const observer = source('hourly-threshold-observer.ts');
    const store = source('hourly-threshold-observation-store.ts');
    for (const text of [observer, store]) {
      expect(text).not.toContain("from './paper-execution'");
      expect(text).not.toContain("from './live-orders'");
      expect(text).not.toContain("from './trading-control'");
      expect(text).not.toContain('reserveTradingBudget');
      expect(text).not.toContain('placeKalshi');
    }
  });
});
