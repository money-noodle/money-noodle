import { describe, expect, it } from 'vitest';
import { evaluateEntryExecutionPolicy, makerCohortEvidence, parseEntryExecutionMode } from './entry-execution-policy';
import type { PaperOrder } from './types';

const base = {
  mode: 'maker' as const, currentNetEdge: 0.18, medianNetEdge: 0.14, confidence: 0.72,
  spread: 0.01, makerNetEdge: 0.20,
  makerEvidence: { label: '25-50c · 1-2c', accepted: 40, fills: 20, fillRate: 0.5 },
  minimumTakerNetEdge: 0.15, minimumMedianNetEdge: 0.10, minimumConfidence: 0.65,
  maximumSpread: 0.02, minimumMakerSamples: 30, minimumTakerAdvantage: 0.02,
};

describe('adaptive maker/taker entry policy', () => {
  it('records a taker recommendation without changing live maker execution in maker mode', () => {
    const decision = evaluateEntryExecutionPolicy(base);
    expect(decision).toMatchObject({ recommendedStyle: 'taker', executedStyle: 'maker' });
    expect(decision.takerAdvantage).toBeCloseTo(0.08);
    expect(decision.reason).toContain('Shadow only');
  });

  it('allows adaptive execution only after every strict gate clears', () => {
    expect(evaluateEntryExecutionPolicy({ ...base, mode: 'adaptive' }).executedStyle).toBe('taker');
    expect(evaluateEntryExecutionPolicy({ ...base, mode: 'adaptive', spread: 0.03 }).executedStyle).toBe('maker');
    expect(evaluateEntryExecutionPolicy({ ...base, mode: 'adaptive', makerEvidence: { ...base.makerEvidence, accepted: 29 } }).executedStyle).toBe('maker');
    expect(evaluateEntryExecutionPolicy({ ...base, mode: 'adaptive', medianNetEdge: 0.09 }).executedStyle).toBe('maker');
  });

  it('defaults invalid configuration to maker mode', () => {
    expect(parseEntryExecutionMode(undefined)).toBe('maker');
    expect(parseEntryExecutionMode('invalid')).toBe('maker');
    expect(parseEntryExecutionMode('adaptive')).toBe('adaptive');
  });

  it('builds empirical evidence only from accepted comparable maker attempts', () => {
    const order = (id: string, patch: Partial<PaperOrder> = {}): PaperOrder => ({
      id, executionMode: 'live', symbol: 'BTC', venue: 'kalshi', contractId: 'ticker', side: 'UP', status: 'unfilled',
      createdAt: '2026-01-01T00:00:00Z', calculationAt: '2026-01-01T00:00:00Z', closesAt: '2026-01-01T00:15:00Z',
      modelProbabilityUp: 0.6, confidence: 0.7, askPrice: 0.30, bidPrice: 0.29, spread: 0.01,
      quantity: 1, stakeCents: 31, feeCents: 1, potentialPayoutCents: 100, venueOrderId: `venue-${id}`, ...patch,
    });
    const evidence = makerCohortEvidence([
      order('filled', { filledCount: 1, liquidityRole: 'maker' }), order('no-fill'),
      order('taker', { filledCount: 1, liquidityRole: 'taker' }), order('other-band', { askPrice: 0.08 }),
      order('not-accepted', { venueOrderId: undefined }),
    ], 0.32, 0.015);
    expect(evidence).toMatchObject({ accepted: 2, fills: 1, fillRate: 0.5 });
  });
});
