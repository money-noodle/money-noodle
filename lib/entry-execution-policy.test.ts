import { describe, expect, it } from 'vitest';
import {
  ENTRY_EXECUTION_POLICY_VERSION, HIGH_EDGE_TAKER_THRESHOLD, MAX_ENTRY_EPISODES_PER_WINDOW,
  evaluateEntryExecutionPolicy, makerCohortEvidence, parseEntryExecutionMode,
} from './entry-execution-policy';
import type { PaperOrder } from './types';

const base = {
  mode: 'maker' as const, currentNetEdge: 0.32, medianNetEdge: 0.14, confidence: 0.72,
  spread: 0.01, makerNetEdge: 0.34,
  makerEvidence: { label: '25-50c · 1-2c', accepted: 40, fills: 20, fillRate: 0.5 },
  minimumMedianNetEdge: 0.10, minimumConfidence: 0.65, maximumSpread: 0.02,
};

describe('high-edge maker/taker entry policy v5', () => {
  it('records the new policy identity and episode ceiling', () => {
    expect(ENTRY_EXECUTION_POLICY_VERSION).toBe('maker-high30-requalify3-fresh1c-idv2-v6');
    expect(MAX_ENTRY_EPISODES_PER_WINDOW).toBe(3);
  });

  it('records a high-edge taker recommendation without changing maker mode', () => {
    const decision = evaluateEntryExecutionPolicy(base);
    expect(decision).toMatchObject({ recommendedStyle: 'taker', executedStyle: 'maker', route: 'high-edge-taker' });
    expect(decision.reason).toContain('Shadow only');
  });

  it('takes adaptively only when fresh edge is at least 30pp and every absolute gate clears', () => {
    expect(evaluateEntryExecutionPolicy({ ...base, mode: 'adaptive' }).executedStyle).toBe('taker');
    expect(evaluateEntryExecutionPolicy({ ...base, mode: 'adaptive', currentNetEdge: 0.299 }).executedStyle).toBe('maker');
    expect(evaluateEntryExecutionPolicy({ ...base, mode: 'adaptive', medianNetEdge: 0.09 }).executedStyle).toBe('maker');
    expect(evaluateEntryExecutionPolicy({ ...base, mode: 'adaptive', confidence: 0.64 }).executedStyle).toBe('maker');
    expect(evaluateEntryExecutionPolicy({ ...base, mode: 'adaptive', spread: 0.03 }).executedStyle).toBe('maker');
  });

  it('does not use maker sample count or random-fill captured edge as a high-edge gate', () => {
    const decision = evaluateEntryExecutionPolicy({
      ...base, mode: 'adaptive',
      makerEvidence: { ...base.makerEvidence, accepted: 0, fills: 0, fillRate: null },
    });
    expect(decision).toMatchObject({ executedStyle: 'taker', makerSamples: 0, makerExpectedCapturedEdge: null });
  });

  it('holds the 30pp and 2c boundaries to their named tolerances', () => {
    expect(evaluateEntryExecutionPolicy({ ...base, mode: 'adaptive', currentNetEdge: HIGH_EDGE_TAKER_THRESHOLD - 2e-12 }).executedStyle).toBe('maker');
    expect(evaluateEntryExecutionPolicy({ ...base, mode: 'adaptive', currentNetEdge: HIGH_EDGE_TAKER_THRESHOLD - 0.5e-12 }).executedStyle).toBe('taker');
    expect(evaluateEntryExecutionPolicy({ ...base, mode: 'adaptive', spread: 0.02 }).executedStyle).toBe('taker');
    expect(evaluateEntryExecutionPolicy({ ...base, mode: 'adaptive', spread: 0.020_000_000_002 }).executedStyle).toBe('maker');
  });

  it('refuses fallback authority even if a historical caller supplies it', () => {
    const decision = evaluateEntryExecutionPolicy({
      ...base, mode: 'adaptive', makerMissFallback: true, fallbackFromOrderId: 'live:BTC:first',
    });
    expect(decision).toMatchObject({ executedStyle: 'maker', makerMissFallback: true, fallbackFromOrderId: 'live:BTC:first' });
    expect(decision.reason).toContain('does not permit taker fallback authority');
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
