import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  CONTRACT_SELECTION_POLICIES, clusterSnapshotPairs, historicalAttemptAvailability,
  orderOccupiesSlotAt, type ContractSelectionOrder, type ContractSelectionSnapshotResult,
} from './contract-selection-analysis';

const close = '2026-08-18T12:15:00Z';
const order = (patch: Partial<ContractSelectionOrder> = {}): ContractSelectionOrder => ({
  id: 'live:BTC:UP:2026-08-18T12:15:00Z', executionMode: 'live', symbol: 'BTC', side: 'UP',
  closesAt: close, createdAt: '2026-08-18T12:05:00Z', calculationAt: '2026-08-18T12:04:59Z',
  status: 'unfilled', makerCompletedAt: '2026-08-18T12:05:15Z', stakeCents: 100,
  quantity: 2, potentialPayoutCents: 200, modelProbabilityUp: 0.6,
  ...patch,
});

const snapshot = (closesAt: string, difference: number): ContractSelectionSnapshotResult => ({
  policyVersion: 'v17', policyLabel: 'v17', calculationAt: '2026-08-18T12:05:00Z', closesAt,
  chosenIds: ['chosen'], preferredIds: ['preferred'], chosenReturn: difference,
  preferredReturn: 0, difference, sameChoice: false, chosenAdmittedByReplay: true,
  reconstructedCandidates: 1, exclusions: {},
});

describe('contract-selection historical state reconstruction', () => {
  it('counts an unfilled intent only while its reservation is active', () => {
    expect(orderOccupiesSlotAt(order(), Date.parse('2026-08-18T12:05:10Z'))).toBe(true);
    expect(orderOccupiesSlotAt(order(), Date.parse('2026-08-18T12:05:16Z'))).toBe(false);
  });

  it('counts a filled position through close, and a sold position only through its exit', () => {
    expect(orderOccupiesSlotAt(order({ status: 'lost', filledCount: 2 }), Date.parse('2026-08-18T12:10:00Z'))).toBe(true);
    expect(orderOccupiesSlotAt(order({ status: 'lost', filledCount: 2 }), Date.parse(close))).toBe(false);
    const sold = order({ status: 'sold', filledCount: 2, settledAt: '2026-08-18T12:08:00Z' });
    expect(orderOccupiesSlotAt(sold, Date.parse('2026-08-18T12:07:59Z'))).toBe(true);
    expect(orderOccupiesSlotAt(sold, Date.parse('2026-08-18T12:08:01Z'))).toBe(false);
  });

  it('fails a spent one-attempt generation and enforces the post-exit cooldown', () => {
    expect(historicalAttemptAvailability([order()], 'BTC', 'UP', close, Date.parse('2026-08-18T12:06:00Z')))
      .toMatchObject({ allowed: false, reason: 'retry' });
    const sold = order({ status: 'sold', filledCount: 2, settledAt: '2026-08-18T12:08:00Z' });
    expect(historicalAttemptAvailability([sold], 'BTC', 'UP', close, Date.parse('2026-08-18T12:08:30Z')))
      .toMatchObject({ allowed: false, reason: 'cooldown' });
    expect(historicalAttemptAvailability([sold], 'BTC', 'UP', close, Date.parse('2026-08-18T12:09:01Z')).allowed)
      .toBe(true);
  });

  it('clusters repeated snapshots on settlement windows before estimating uncertainty', () => {
    const result = clusterSnapshotPairs([
      snapshot('2026-08-18T12:15:00Z', 1), snapshot('2026-08-18T12:15:00Z', -1),
      snapshot('2026-08-18T12:30:00Z', 0.5),
    ]);
    expect(result.snapshots).toBe(3);
    expect(result.windows).toBe(2);
    expect(result.differenceMean).toBeCloseTo(0.25, 12);
    expect(result.differenceStandardError).toBeCloseTo(0.25, 12);
  });

  it('fails closed outside the policy eras whose runtime constraints are known', () => {
    expect(CONTRACT_SELECTION_POLICIES.size).toBe(3);
    expect([...CONTRACT_SELECTION_POLICIES.keys()].every((version) => /v1[789]$/.test(version))).toBe(true);
  });
});
