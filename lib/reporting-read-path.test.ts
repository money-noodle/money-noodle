import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
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
    expect(route).toContain("getExecutionOrders({ strategyId: EDGE_BINARY_BUY, includeArchivedEvidence: false })");
    expect(route).not.toContain('forecast-tracker');
    expect(route).not.toContain('getForecastHistory');
  });

  it('owns one funded-control poll and leaves terminal order detail on demand', () => {
    const dashboard = source('components/dashboard.tsx');
    const automation = source('components/automation-status.tsx');
    const dialog = source('components/trading-control-dialog.tsx');
    expect(dashboard.match(/fetch\('\/api\/trading\/control'/g)).toHaveLength(1);
    expect(automation).not.toContain("fetch('/api/trading/control'");
    expect(dialog).toContain("fetch('/api/trading/control?details=1'");
  });

  it('keeps fixed order readers on compact v9 control rows', () => {
    expect(source('app/api/performance/summary/route.ts')).toContain('includeArchivedEvidence: false');
    expect(source('app/api/trading/history/route.ts')).toContain('includeArchivedEvidence: false');
    expect(source('app/api/trading/allocations/route.ts')).toContain('includeArchivedEvidence: false');
    expect(source('lib/public-paper-performance.ts')).toContain("strategyId: EDGE_BINARY_BUY, includeArchivedEvidence: false");
    expect(source('app/api/performance/route.ts')).toContain('getExecutionOrders()');
    const risk = source('lib/live-risk-store.ts');
    expect(risk).toContain('!runtime.activeMutation && runtime.committed');
    expect(risk).toContain('{ verifyEvidence: false }');
    expect(risk).not.toContain('serializeExecutionLedgerOperation');
  });

  it('routes analyses through v9 hydration and makes historical correction tools refuse compact rows', () => {
    const root = path.resolve(import.meta.dirname, '..');
    const files = ['lib', 'app', 'scripts'].flatMap((directory) => readdirSync(path.join(root, directory), {
      recursive: true, withFileTypes: true,
    }).filter((entry) => entry.isFile() && /\.(?:ts|mjs)$/.test(entry.name))
      .map((entry) => path.join(entry.parentPath, entry.name)));
    const direct = files.filter((file) => {
      if (file.endsWith('.test.ts')) return false;
      const text = readFileSync(file, 'utf8');
      return text.includes('paper-orders.json') && /readFile(?:Sync)?\([^\n]*paper-orders\.json/.test(text);
    }).map((file) => path.relative(root, file)).sort();
    expect(direct).toEqual(['scripts/lib/read-execution-ledger.mjs']);
    for (const correction of [
      'scripts/correct-live-order-identity.ts', 'scripts/correct-paper-bankroll-drift.ts',
      'scripts/correct-paper-bankroll-leak.ts', 'scripts/correct-paper-maker-fee.ts',
    ]) expect(source(correction)).toContain('historical correction refuses execution-ledger v9');
  });
});
