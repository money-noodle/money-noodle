import { describe, expect, it } from 'vitest';
import { MAKER_MANAGEMENT_CHECKS, MAKER_MANAGEMENT_POLL_MS } from './managed-maker';
import {
  DEFAULT_RECONCILIATION_INTERVAL_MS, TASK_CADENCE, configuredReconciliationIntervalMs,
} from './task-cadence';

describe('task cadence registry', () => {
  it('registers each independent runtime task once', () => {
    expect(TASK_CADENCE.map((task) => task.id)).toEqual([
      'dashboard-calculation', 'edge-observation', 'exact-pre-submit-quote', 'managed-maker',
      'reconciliation',
    ]);
    expect(new Set(TASK_CADENCE.map((task) => task.id)).size).toBe(TASK_CADENCE.length);
    for (const task of TASK_CADENCE) {
      expect(task.activation).toBeTruthy();
      expect(task.purpose).toBeTruthy();
      expect(task.requestCost).toBeTruthy();
    }
  });

  it('derives managed-maker display from the constants its loop uses', () => {
    expect(TASK_CADENCE.find((task) => task.id === 'managed-maker')?.cadenceMs).toBe(MAKER_MANAGEMENT_POLL_MS);
    expect(TASK_CADENCE.find((task) => task.id === 'managed-maker')?.cadenceLabel).toContain(`${MAKER_MANAGEMENT_CHECKS} checks`);
  });

  it('fails invalid reconciliation configuration to the default and bounds valid values', () => {
    expect(configuredReconciliationIntervalMs({})).toBe(DEFAULT_RECONCILIATION_INTERVAL_MS);
    expect(configuredReconciliationIntervalMs({ MONEY_NOODLE_RECONCILIATION_INTERVAL_SECONDS: 'invalid' })).toBe(DEFAULT_RECONCILIATION_INTERVAL_MS);
    expect(configuredReconciliationIntervalMs({ MONEY_NOODLE_RECONCILIATION_INTERVAL_SECONDS: '2' })).toBe(60_000);
    expect(configuredReconciliationIntervalMs({ MONEY_NOODLE_RECONCILIATION_INTERVAL_SECONDS: '120' })).toBe(120_000);
    expect(configuredReconciliationIntervalMs({ MONEY_NOODLE_RECONCILIATION_INTERVAL_SECONDS: '99999' })).toBe(60 * 60_000);
  });
});
