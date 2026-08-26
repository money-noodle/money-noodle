import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const source = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('hourly H1 remains read-only and detached', () => {
  it('has no import or read path into funded or paper orchestration', () => {
    for (const path of ['./live-orders.ts', './paper-execution.ts', './background-collector.ts']) {
      const text = source(path);
      expect(text).not.toContain('hourly-threshold-market');
      expect(text).not.toContain('CRYPTO_1H');
      expect(text).not.toContain('crypto-1h');
    }
  });

  it('does not import policy, budget, ledger, order, settlement, reconciliation, or stores', () => {
    const service = source('./hourly-threshold-market-service.ts');
    expect(service).not.toMatch(/from ['"].*(prediction-policy|policy-manifest|budget|ledger|order|settlement|reconciliation|store)/);
    expect(service).not.toMatch(/\b(writeFile|appendFile|rename|mkdir|placeOrder|reserve)\b/);
  });

  it('cannot appear in funded allocation controls', () => {
    const allocations = source('../app/api/trading/allocations/route.ts');
    expect(allocations).toContain('providerFundedMarkets(providerId)');
    expect(allocations).toContain('providerMarketCapability(providerId, marketId)?.live !== true');
  });

  it('publishes a GET-only public route with no refresh cache bypass', () => {
    const route = source('../app/api/markets/hourly/route.ts');
    expect(route).toContain('export async function GET()');
    expect(route).not.toMatch(/export async function (POST|PUT|PATCH|DELETE)/);
    expect(route).not.toContain('searchParams');
  });
});
