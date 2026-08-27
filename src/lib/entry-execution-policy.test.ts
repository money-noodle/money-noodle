import { describe, expect, it } from 'vitest';
import {
  ENTRY_EXECUTION_POLICY_VERSION, MAX_ENTRY_EPISODES_PER_WINDOW, adaptiveContinuationRefusal,
  evaluateEntryExecutionPolicy, makerCohortEvidence, parseEntryExecutionMode,
} from './entry-execution-policy';
import type { PaperOrder } from './types';

const base = {
  mode: 'adaptive' as const, currentNetEdge: 0.01, medianNetEdge: Number.NEGATIVE_INFINITY, confidence: 0.72,
  spread: 0.01, makerNetEdge: 0.03,
  makerEvidence: { label: '25-50c · 1-2c', accepted: 40, fills: 20, fillRate: 0.5 },
  minimumMedianNetEdge: 0.10, minimumConfidence: 0.65, maximumSpread: 0.02,
};

describe('maker then positive-edge taker fallback policy v9', () => {
  it('records the policy identity and three-intent ceiling', () => {
    expect(ENTRY_EXECUTION_POLICY_VERSION).toBe('maker-then-positive-edge-taker2-terminal-refusal-v9');
    expect(MAX_ENTRY_EPISODES_PER_WINDOW).toBe(3);
  });

  it('always starts with the managed maker, including at high edge', () => {
    expect(evaluateEntryExecutionPolicy({ ...base, currentNetEdge: 0.40 })).toMatchObject({
      recommendedStyle: 'maker', executedStyle: 'maker', route: 'ordinary-maker',
    });
  });

  it('authorizes fallback on strictly positive edge without post-miss median persistence', () => {
    expect(evaluateEntryExecutionPolicy({ ...base, makerMissFallback: true, fallbackFromOrderId: 'maker' })).toMatchObject({
      recommendedStyle: 'taker', executedStyle: 'taker', route: 'maker-miss-taker-fallback',
      makerMissFallback: true, fallbackFromOrderId: 'maker',
    });
    expect(evaluateEntryExecutionPolicy({ ...base, makerMissFallback: true, currentNetEdge: 1e-12 }).executedStyle).toBe('maker');
    expect(evaluateEntryExecutionPolicy({ ...base, makerMissFallback: true, currentNetEdge: 2e-12 }).executedStyle).toBe('taker');
  });

  it('retains quality and spread gates on a fallback and exposes them as terminal continuation refusals', () => {
    for (const decision of [
      evaluateEntryExecutionPolicy({ ...base, makerMissFallback: true, confidence: 0.64 }),
      evaluateEntryExecutionPolicy({ ...base, makerMissFallback: true, spread: 0.020_000_000_002 }),
      evaluateEntryExecutionPolicy({ ...base, makerMissFallback: true, currentNetEdge: 0 }),
    ]) {
      expect(decision.executedStyle).toBe('maker');
      expect(adaptiveContinuationRefusal(true, decision)).toBe(decision.reason);
    }
    const authorized = evaluateEntryExecutionPolicy({ ...base, makerMissFallback: true });
    expect(adaptiveContinuationRefusal(true, authorized)).toBeUndefined();
    expect(adaptiveContinuationRefusal(false, evaluateEntryExecutionPolicy(base))).toBeUndefined();
  });

  it('keeps maker mode incapable of acting on a taker recommendation or turning it into another maker', () => {
    const decision = evaluateEntryExecutionPolicy({ ...base, mode: 'maker', makerMissFallback: true });
    expect(decision).toMatchObject({ recommendedStyle: 'taker', executedStyle: 'maker' });
    expect(decision.reason).toContain('Shadow only');
    expect(adaptiveContinuationRefusal(true, decision)).toBe(decision.reason);
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
