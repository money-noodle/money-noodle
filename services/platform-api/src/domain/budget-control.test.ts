import { describe, expect, it } from 'vitest';

import {
  BUDGET_KINDS,
  CONTROL_ACTIONS,
  capabilityFor,
  deriveBudgetDetail,
  hasExecutionAuthority,
  isBudgetKind,
  isControlAction,
  type BudgetRecord,
  type IntentHistoryEntry,
} from './budget-control.js';

const NOW = new Date('2026-10-06T12:00:00.000Z');

const record = (kind: 'paper' | 'live'): BudgetRecord => ({
  accountId: 'account',
  createdAt: NOW,
  id: `account:${kind}`,
  kind,
});

const entry = (
  action: 'pause' | 'resume' | 'configure',
  epoch: number,
  offsetMs: number,
  outcomes: IntentHistoryEntry['outcomes'] = [],
): IntentHistoryEntry => ({
  intent: {
    action,
    actor: 'account',
    capability: 'budget:paper',
    epoch,
    id: `intent-${epoch}-${offsetMs}`,
    parameters: null,
    recordedAt: new Date(NOW.getTime() + offsetMs),
    runId: 'run',
  },
  outcomes,
});

describe('the vocabulary', () => {
  it('is exactly two budgets and five controls', () => {
    expect([...BUDGET_KINDS]).toEqual(['paper', 'live']);
    expect([...CONTROL_ACTIONS]).toEqual([
      'configure',
      'pause',
      'resume',
      'reset',
      'provider-enable',
    ]);
  });

  it('recognises its own values and nothing else', () => {
    expect(isBudgetKind('paper')).toBe(true);
    expect(isBudgetKind('simulated')).toBe(false);
    expect(isBudgetKind(7)).toBe(false);
    expect(isControlAction('provider-enable')).toBe(true);
    expect(isControlAction('arm')).toBe(false);
    expect(isControlAction(null)).toBe(false);
  });

  it('derives one capability per budget', () => {
    expect(capabilityFor('paper')).toBe('budget:paper');
    expect(capabilityFor('live')).toBe('budget:live');
  });
});

describe('execution authority', () => {
  it('belongs to the paper budget and to nothing else', () => {
    // ADR-0013 §4: the live budget exists as a record only. One function says so,
    // so a view and a handler cannot disagree about it.
    expect(hasExecutionAuthority('paper')).toBe(true);
    expect(hasExecutionAuthority('live')).toBe(false);
  });
});

describe('deriving budget detail', () => {
  it('reports no state at all when nothing has ever been recorded', () => {
    const detail = deriveBudgetDetail(record('paper'), []);

    expect(detail.desiredState).toBe('unset');
    expect(detail.appliedState).toBeNull();
    expect(detail.epoch).toBe(0);
    expect(detail.latestIntentAt).toBeNull();
  });

  it('takes the desired state from the latest pause or resume, ignoring other actions', () => {
    // The history arrives newest first, as the port returns it. A `configure`
    // recorded after a `pause` does not resume anything.
    const detail = deriveBudgetDetail(record('paper'), [
      entry('configure', 2, 3000),
      entry('pause', 2, 2000),
      entry('resume', 1, 1000),
    ]);

    expect(detail.desiredState).toBe('paused');
    expect(detail.epoch).toBe(2);
    expect(detail.latestIntentAt).toEqual(new Date(NOW.getTime() + 3000));
  });

  it('separates what was asked from what a job said it did', () => {
    const withOutcome = deriveBudgetDetail(record('paper'), [
      entry('resume', 3, 4000, [
        {
          appliedAt: new Date(NOW.getTime() + 5000),
          appliedRunId: 'run-2',
          id: 'outcome-1',
          intentId: 'intent-3-4000',
          outcome: 'refused',
          reason: 'stale-epoch',
        },
      ]),
    ]);

    // The operator asked for running; the job refused. Both facts survive, which
    // is the reason these are two fields rather than one.
    expect(withOutcome.desiredState).toBe('running');
    expect(withOutcome.appliedState).toBe('refused');
  });

  it('marks the live budget as carrying no execution authority', () => {
    expect(deriveBudgetDetail(record('live'), []).hasExecutionAuthority).toBe(false);
    expect(deriveBudgetDetail(record('live'), []).capability).toBe('budget:live');
  });
});
