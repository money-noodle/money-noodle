import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  beginTaskCadenceRun, recordTaskCadenceSuccess, resetTaskCadenceRuntimeForTests,
  taskCadenceStatuses,
} from './task-cadence-runtime';

const status = (id: string, nowMs = Date.parse('2026-08-20T12:00:00.000Z')) =>
  taskCadenceStatuses({ nowMs, environment: {} }).find((item) => item.id === id)!;

describe('task cadence runtime health', () => {
  beforeEach(() => resetTaskCadenceRuntimeForTests());

  it('moves a task from idle through running to healthy', () => {
    expect(status('managed-maker').health).toBe('idle');
    const run = beginTaskCadenceRun('managed-maker', Date.parse('2026-08-20T11:59:58.000Z'));
    expect(status('managed-maker').health).toBe('running');
    run.succeed(Date.parse('2026-08-20T12:00:00.000Z'));
    expect(status('managed-maker')).toMatchObject({
      health: 'healthy',
      lastStartedAt: '2026-08-20T11:59:58.000Z',
      lastCompletedAt: '2026-08-20T12:00:00.000Z',
      lastSuccessAt: '2026-08-20T12:00:00.000Z',
    });
  });

  it('reports the latest failure without making a never-activated on-demand task stale', () => {
    const run = beginTaskCadenceRun('exact-pre-submit-quote', Date.parse('2026-08-20T11:59:59.000Z'));
    run.fail(new Error('quote unavailable'), Date.parse('2026-08-20T12:00:00.000Z'));
    expect(status('exact-pre-submit-quote')).toMatchObject({ health: 'degraded', lastError: 'quote unavailable' });
    resetTaskCadenceRuntimeForTests();
    expect(status('exact-pre-submit-quote', Date.parse('2026-08-21T12:00:00.000Z')).health).toBe('idle');
  });

  it('degrades an always-expected edge clock only after its stale allowance', () => {
    recordTaskCadenceSuccess('edge-observation', '2026-08-20T12:00:00.000Z');
    expect(status('edge-observation', Date.parse('2026-08-20T12:00:45.000Z')).health).toBe('healthy');
    expect(status('edge-observation', Date.parse('2026-08-20T12:00:45.001Z')).health).toBe('degraded');
  });

  it('marks worker-only tasks unavailable on stateless deployments', () => {
    const statuses = taskCadenceStatuses({ stateless: true, environment: {} });
    expect(statuses.find((item) => item.id === 'dashboard-calculation')?.health).toBe('idle');
    expect(statuses.find((item) => item.id === 'managed-maker')?.health).toBe('unavailable');
    expect(statuses.find((item) => item.id === 'reconciliation')?.health).toBe('unavailable');
  });
});
