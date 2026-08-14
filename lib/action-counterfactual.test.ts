import { describe, expect, it } from 'vitest';
import { buildActionCounterfactuals, clusterByWindow } from './action-counterfactual';
import type { PaperOrder } from './types';

function order(patch: Partial<PaperOrder> = {}): PaperOrder {
  return {
    id: crypto.randomUUID(), executionMode: 'live', symbol: 'BTC', venue: 'kalshi', contractId: 'TEST', side: 'UP',
    status: 'sold', createdAt: '2026-01-01T00:01:00Z', calculationAt: '2026-01-01T00:01:00Z', closesAt: '2026-01-01T00:15:00Z',
    modelProbabilityUp: 0.7, confidence: 0.7, askPrice: 0.4, bidPrice: 0.39, spread: 0.01,
    quantity: 0.2, stakeCents: 10, feeCents: 1, potentialPayoutCents: 20,
    ...patch,
  };
}

const exit = (policy: PaperOrder['standaloneExitPolicy'], pnl: number, hold: number, patch: Partial<PaperOrder> = {}) =>
  order({ standaloneExitPolicy: policy, actualStakeCents: 10, actualPnlCents: pnl, counterfactualHoldOutcome: 'UP', counterfactualHoldPnlCents: hold, ...patch });

const findArm = (orders: PaperOrder[], policy: string) => buildActionCounterfactuals(orders, 'live').find((arm) => arm.policy === policy);

describe('window clustering', () => {
  it('counts trades sharing a settlement window as one observation', () => {
    const rows = [{ window: 'a', value: 0 }, { window: 'a', value: 10 }, { window: 'b', value: 3 }];
    const clustered = clusterByWindow(rows, (row) => row.window, (row) => row.value);
    expect(clustered.windows).toBe(2);
    // 5 and 3, not the 4.33 an unclustered mean of three "independent" trades would report.
    expect(clustered.mean).toBe(4);
  });

  it('reports no standard error from a single window', () => {
    expect(clusterByWindow([{ value: 1 }], () => 'a', (row) => row.value).standardError).toBeNull();
  });
});

describe('action counterfactual arms', () => {
  it('separates the two exit policies instead of averaging them together', () => {
    const orders = [
      exit('strict-value-v1', 8, 2),
      exit('profit-reversal-75-v1', 3, 15, { closesAt: '2026-01-01T00:30:00Z' }),
    ];
    expect(findArm(orders, 'strict-value-v1')?.incrementalCents).toBe(6);
    expect(findArm(orders, 'profit-reversal-75-v1')?.incrementalCents).toBe(-12);
  });

  it('normalizes incremental value by stake so eras with different sizing stay comparable', () => {
    const small = exit('strict-value-v1', 5, 0, { actualStakeCents: 10 });
    const large = exit('strict-value-v1', 50, 0, { actualStakeCents: 100, closesAt: '2026-01-01T00:30:00Z' });
    const arm = findArm([small, large], 'strict-value-v1');
    expect(arm?.incrementalCents).toBe(55);
    // Both exits returned +50% of stake; the 10x sizing difference must not weight one of them 10x.
    expect(arm?.meanIncrementalReturn).toBeCloseTo(0.5);
  });

  it('prices a hold against the last executable bid the exit engine observed', () => {
    const held = order({ status: 'lost', actualStakeCents: 10, actualPnlCents: -10, latestNetLiquidationCents: 4 });
    const arm = findArm([held], 'exit-at-last-observation');
    expect(arm?.action).toBe('HOLD');
    expect(arm?.basis).toBe('approximate');
    // Holding lost the full 10¢ stake; selling at the observed 4¢ bid would have lost 6¢.
    expect(arm?.incrementalCents).toBe(-4);
  });

  it('evaluates armed positions that were never sold at their recorded high water', () => {
    const armed = order({
      status: 'lost', actualStakeCents: 10, actualPnlCents: -10,
      profitLockArmedAt: '2026-01-01T00:05:00Z', peakNetLiquidationCents: 19, latestNetLiquidationCents: 4,
    });
    expect(findArm([armed], 'exit-at-armed-peak')?.incrementalCents).toBe(-19);
    const unarmed = order({ status: 'lost', actualStakeCents: 10, actualPnlCents: -10, latestNetLiquidationCents: 4 });
    expect(findArm([unarmed], 'exit-at-armed-peak')).toBeUndefined();
  });

  it('reports a switch against holding the incumbent', () => {
    const switched = order({ actualStakeCents: 10, actualPnlCents: -1, switchVsHoldCents: 3, switchedToOrderId: 'replacement' });
    const arm = findArm([switched], 'protected-switch');
    expect(arm?.action).toBe('SWITCH');
    expect(arm?.incrementalCents).toBe(3);
  });

  it('excludes switch liquidations from the standalone exit arms', () => {
    const switched = exit('strict-value-v1', 3, 9, { switchedToOrderId: 'replacement', switchVsHoldCents: -6 });
    expect(findArm([switched], 'strict-value-v1')).toBeUndefined();
  });

  it('withholds credibility until an arm clears two standard errors across enough windows', () => {
    const noisy = Array.from({ length: 6 }, (_, index) => exit('strict-value-v1', index % 2 ? 20 : -20, 0, { closesAt: `2026-01-01T0${index}:15:00Z` }));
    expect(findArm(noisy, 'strict-value-v1')?.credible).toBe(false);
    const consistent = Array.from({ length: 6 }, (_, index) => exit('strict-value-v1', 5, 0, { closesAt: `2026-01-01T0${index}:15:00Z` }));
    expect(findArm(consistent, 'strict-value-v1')?.credible).toBe(true);
  });

  it('keeps modes apart so paper exits never enter the live record', () => {
    const paper = exit('strict-value-v1', 8, 2, { executionMode: 'paper' });
    expect(buildActionCounterfactuals([paper], 'live')).toEqual([]);
    expect(findArm([paper], 'strict-value-v1')).toBeUndefined();
    expect(buildActionCounterfactuals([paper], 'paper')).toHaveLength(1);
  });
});
