import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { KALSHI_RECONCILIATION_CHECKPOINT_VERSION } from './reconciliation-checkpoint';
import {
  incrementalReconciliationInterval,
  liveReconciliationAuthorityFingerprint,
  localReconciliationPlan,
} from './reconciliation-scope';
import type { PaperOrder } from './types';

const order = (patch: Partial<PaperOrder> = {}): PaperOrder => ({
  id: 'live:BTC:UP:2026-01-01T00:15:00Z', executionMode: 'live', strategyId: 'edge-binary-buy',
  symbol: 'BTC', venue: 'kalshi', providerId: 'kalshi', providerVariantId: 'kalshi-15m-maker-v1',
  marketId: 'crypto-15m', contractId: 'KXBTC-TEST', side: 'UP', status: 'open',
  createdAt: '2026-01-01T00:10:00.000Z', calculationAt: '2026-01-01T00:09:45.000Z',
  closesAt: '2026-01-01T00:15:00.000Z', modelProbabilityUp: 0.7, confidence: 0.7,
  askPrice: 0.3, bidPrice: 0.28, spread: 0.02, quantity: 0.3, stakeCents: 10, feeCents: 1,
  potentialPayoutCents: 30, venueOrderId: 'venue-entry', ...patch,
});

const checkpoint = {
  version: KALSHI_RECONCILIATION_CHECKPOINT_VERSION,
  completedThroughTs: Date.parse('2026-01-01T00:12:00Z') / 1_000,
  completedAt: '2026-01-01T00:12:01.000Z',
  trigger: 'periodic' as const,
};

describe('incremental reconciliation scope', () => {
  it('targets only live transactions whose venue state can still change local money authority', () => {
    const plan = localReconciliationPlan([
      order(),
      order({ id: 'live:ETH', status: 'uncertain', venueOrderId: undefined, createdAt: '2026-01-01T00:11:00Z' }),
      order({ id: 'live:SOL', status: 'open', venueOrderId: 'entry-sol', exitPending: true,
        exitVenueOrderId: 'exit-sol', exitRequestedAt: '2026-01-01T00:11:30Z' }),
      order({ id: 'live:DOGE', status: 'unfilled', venueOrderId: 'terminal-zero' }),
      order({ id: 'paper:BTC', executionMode: 'paper', status: 'open', venueOrderId: undefined }),
    ]);
    expect(plan.trackedVenueOrderIds.sort()).toEqual(['entry-sol', 'exit-sol', 'venue-entry']);
    expect(plan.earliestRequiredAtMs).toBe(Date.parse('2026-01-01T00:10:00Z'));
  });

  it('reaches behind both the checkpoint and the earliest active transaction with overlap', () => {
    const plan = localReconciliationPlan([order()]);
    expect(incrementalReconciliationInterval(
      checkpoint, plan, Date.parse('2026-01-01T00:13:00Z') / 1_000,
    )).toEqual({
      minTs: Date.parse('2026-01-01T00:08:00Z') / 1_000,
      maxTs: Date.parse('2026-01-01T00:13:00Z') / 1_000,
    });
    expect(incrementalReconciliationInterval(
      { ...checkpoint, completedThroughTs: Date.parse('2026-01-01T00:05:00Z') / 1_000 },
      plan, Date.parse('2026-01-01T00:13:00Z') / 1_000,
    ).minTs).toBe(Date.parse('2026-01-01T00:03:00Z') / 1_000);
  });

  it('fingerprints live authority while ignoring unrelated paper mutations', () => {
    const live = order();
    const before = liveReconciliationAuthorityFingerprint([live, order({ id: 'paper:one', executionMode: 'paper' })]);
    expect(liveReconciliationAuthorityFingerprint([
      live, order({ id: 'paper:two', executionMode: 'paper', status: 'lost' }),
    ])).toBe(before);
    expect(liveReconciliationAuthorityFingerprint([{ ...live, status: 'sold' }])).not.toBe(before);
  });
});
