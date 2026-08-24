import { describe, expect, it } from 'vitest';
import {
  OFFLINE_EVALUATION_CONFIRMATION, offlineEvaluationBlockers,
} from './offline-evaluation-gate';

type Control = Parameters<typeof offlineEvaluationBlockers>[0];
const paused = (over: Partial<Control> = {}): Control => ({
  state: 'paused', operatorIntent: 'paused', reservedBudgetCents: 0, ...over,
});

describe('offline walk-forward evaluation gate', () => {
  it('admits only exact confirmation on paused zero-reservation control', () => {
    expect(offlineEvaluationBlockers(paused(), OFFLINE_EVALUATION_CONFIRMATION)).toEqual([]);
  });

  const refused: Array<[string, Control, string | undefined, RegExp]> = [
    ['missing confirmation', paused(), undefined, /MONEY_NOODLE_OFFLINE_EVALUATION/],
    ['active state', paused({ state: 'active' }), OFFLINE_EVALUATION_CONFIRMATION, /must be paused/],
    ['active intent', paused({ operatorIntent: 'active' }), OFFLINE_EVALUATION_CONFIRMATION, /intent must be paused/],
    ['positive reservation', paused({ reservedBudgetCents: 1 }), OFFLINE_EVALUATION_CONFIRMATION, /exactly zero/],
    ['malformed reservation', paused({ reservedBudgetCents: Number.NaN }), OFFLINE_EVALUATION_CONFIRMATION, /exactly zero/],
  ];
  it.each(refused)('refuses %s', (_label, control, confirmation, expected) => {
    expect(offlineEvaluationBlockers(control, confirmation).join(' ')).toMatch(expected);
  });
});
