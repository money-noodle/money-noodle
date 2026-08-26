import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('./live-orders', () => ({ liveTradingEnabled: () => true }));
vi.mock('./paper-execution', () => ({ reconcileLiveExecution: vi.fn() }));

import { initialPeriodicReconciliationAt, periodicReconciliationIntervalMs } from './periodic-reconciliation';

describe('periodic reconciliation schedule', () => {
  it('defaults to five minutes', () => {
    expect(periodicReconciliationIntervalMs({})).toBe(300_000);
  });

  it('enforces a one-minute minimum and one-hour maximum', () => {
    expect(periodicReconciliationIntervalMs({ MONEY_NOODLE_RECONCILIATION_INTERVAL_SECONDS: '10' })).toBe(60_000);
    expect(periodicReconciliationIntervalMs({ MONEY_NOODLE_RECONCILIATION_INTERVAL_SECONDS: '7200' })).toBe(3_600_000);
  });

  it('schedules relative to the latest completed authoritative check', () => {
    const completed = '2026-01-01T00:00:00.000Z';
    expect(initialPeriodicReconciliationAt(completed, Date.parse('2026-01-01T00:01:00Z'), 300_000)).toBe(Date.parse('2026-01-01T00:05:00Z'));
    expect(initialPeriodicReconciliationAt(completed, Date.parse('2026-01-01T00:06:00Z'), 300_000)).toBe(Date.parse('2026-01-01T00:06:00Z'));
  });
});
