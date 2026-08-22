import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = (relative: string) => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

describe('bounded reporting read paths', () => {
  it('polls one compact public performance resource for both homepage panels', () => {
    const dashboard = source('components/dashboard.tsx');
    const hook = source('components/use-public-paper.ts');
    const automation = source('components/automation-status.tsx');
    expect(dashboard.match(/usePublicPaperPerformanceSummary\(/g)).toHaveLength(1);
    expect(automation).not.toContain('usePublicPaperPerformanceSummary');
    expect(hook).toContain("'/api/paper-performance/summary'");
    expect(hook).not.toContain("usePublicPaperData<PublicPaperPerformance>('/api/paper-performance'");
  });

  it('keeps complete performance reports on the dialog-open path only', () => {
    const dashboard = source('components/dashboard.tsx');
    const dialog = source('components/performance-dialog.tsx');
    expect(dashboard).toContain("fetch('/api/performance/summary'");
    expect(dashboard).not.toContain("fetch('/api/performance',");
    expect(dialog).toContain("publicView ? '/api/paper-performance' : '/api/performance'");
    expect(dialog).toContain('if (open) void load()');
  });

  it('never turns an unavailable hosted paper budget into a zero ledger', () => {
    const execution = source('lib/paper-execution.ts');
    const route = source('app/api/paper-budget/route.ts');
    const getter = execution.slice(
      execution.indexOf('export async function getPublicPaperBudget'),
      execution.indexOf('export async function getExecutionSummaries'),
    );
    expect(getter).toContain('return readPublicPaperBudgetFromPostgres()');
    expect(getter).not.toContain('startingCents: 0');
    expect(route).toContain('status: 503');
    expect(route).toContain('No zero balance was inferred');
  });

  it('keeps the signed polling route free of forecast-history imports', () => {
    const route = source('app/api/performance/summary/route.ts');
    expect(route).toContain("getExecutionOrders({ strategyId: EDGE_BINARY_BUY })");
    expect(route).not.toContain('forecast-tracker');
    expect(route).not.toContain('getForecastHistory');
  });
});
