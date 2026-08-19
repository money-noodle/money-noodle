import { afterEach, describe, expect, it } from 'vitest';
import { ENTRY_EXECUTION_POLICY_VERSION } from './entry-execution-policy';
import { adaptiveTakerFallbackDecision, entryAttemptsForLogicalOrder, makerAttemptId, makerRetryDecision, maximumLiveMakerAttempts } from './maker-retry-policy';
import type { PaperOrder } from './types';

const logical = 'live:BTC:2026-01-01T00:15:00Z';
const close = '2026-01-01T00:15:00Z';
const order = (patch: Partial<PaperOrder> = {}): PaperOrder => ({
  id: logical, logicalOrderId: logical, attemptNumber: 1, clientOrderId: logical,
  executionMode: 'live', symbol: 'BTC', venue: 'kalshi', contractId: 'TEST', side: 'UP', status: 'unfilled',
  createdAt: '2026-01-01T00:01:00Z', calculationAt: '2026-01-01T00:01:00Z', closesAt: close,
  modelProbabilityUp: 0.7, confidence: 0.7, askPrice: 0.4, bidPrice: 0.39, spread: 0.01,
  quantity: 0.2, stakeCents: 9, feeCents: 1, potentialPayoutCents: 20, ...patch,
});

afterEach(() => {
  delete process.env.MONEY_NOODLE_MAX_LIVE_MAKER_ATTEMPTS;
});

describe('single-attempt adaptive execution', () => {
  const makerMiss = (patch: Partial<PaperOrder> = {}) => order({
    makerCompletedAt: '2026-01-01T00:01:20Z',
    entryExecutionDecision: {
      policyVersion: ENTRY_EXECUTION_POLICY_VERSION, configuredMode: 'adaptive', executedStyle: 'maker', recommendedStyle: 'maker',
      reason: 'maker', takerNetEdge: 0.18, medianNetEdge: 0.14, makerNetEdge: 0.2,
      makerExpectedCapturedEdge: 0.1, takerAdvantage: 0.08, makerCohort: 'x', makerSamples: 40,
      makerFillRate: 0.5,
    },
    ...patch,
  });

  it('ends the sequence after one authoritative maker zero-fill', () => {
    const result = adaptiveTakerFallbackDecision([makerMiss()], Date.parse('2026-01-01T00:01:20Z'), close);
    expect(result).toMatchObject({ allowed: false, attemptNumber: 2 });
    expect(result.reason).toContain('Maximum 1 adaptive entry attempt');
  });

  it('never follows a partial fill, uncertainty, retired policy attempt, or completed second row', () => {
    expect(adaptiveTakerFallbackDecision([makerMiss({ status: 'open', filledCount: 0.1 })], Date.parse('2026-01-01T00:02:00Z'), close).allowed).toBe(false);
    expect(adaptiveTakerFallbackDecision([makerMiss({ status: 'uncertain' })], Date.parse('2026-01-01T00:02:00Z'), close).allowed).toBe(false);
    expect(adaptiveTakerFallbackDecision([makerMiss({
      entryExecutionDecision: { ...makerMiss().entryExecutionDecision!, policyVersion: 'retired-v1' },
    })], Date.parse('2026-01-01T00:02:00Z'), close).allowed).toBe(false);
    const fallback = makerMiss({ id: `${logical}:retry:2`, attemptNumber: 2, createdAt: '2026-01-01T00:02:00Z' });
    expect(adaptiveTakerFallbackDecision([makerMiss(), fallback], Date.parse('2026-01-01T00:03:00Z'), close).allowed).toBe(false);
  });
});

describe('bounded maker retry policy', () => {
  it('creates durable unique ids for retry reservations and venue clients', () => {
    expect(makerAttemptId(logical, 1)).toBe(logical);
    expect(makerAttemptId(logical, 2)).toBe(`${logical}:retry:2`);
  });

  it('allows one retry after cooldown with enough contract time', () => {
    const result = makerRetryDecision([order()], Date.parse('2026-01-01T00:02:00Z'), close);
    expect(result).toMatchObject({ allowed: true, attemptNumber: 2, retryOfOrderId: logical });
  });

  it('starts the cooldown after the maker attempt completes, not when it was submitted', () => {
    const completed = order({ makerCompletedAt: '2026-01-01T00:01:20Z' });
    expect(makerRetryDecision([completed], Date.parse('2026-01-01T00:01:40Z'), close).allowed).toBe(false);
    expect(makerRetryDecision([completed], Date.parse('2026-01-01T00:01:50Z'), close)).toMatchObject({ allowed: true, attemptNumber: 2 });
  });

  it('supports a one-attempt live validation cap without removing the two-attempt hard ceiling', () => {
    const result = makerRetryDecision([order()], Date.parse('2026-01-01T00:02:00Z'), close, 1);
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Maximum 1 maker attempt');
  });

  it('keeps the conservative maker-only live default at one attempt', () => {
    expect(maximumLiveMakerAttempts()).toBe(1);
  });

  it('blocks during cooldown and in the final two minutes', () => {
    expect(makerRetryDecision([order()], Date.parse('2026-01-01T00:01:20Z'), close).reason).toContain('cooldown');
    expect(makerRetryDecision([order()], Date.parse('2026-01-01T00:13:30Z'), close).reason).toContain('final 120s');
  });

  it('never retries a fill, uncertain order, or completed second attempt', () => {
    expect(makerRetryDecision([order({ status: 'open', filledCount: 0.1 })], Date.parse('2026-01-01T00:02:00Z'), close).allowed).toBe(false);
    expect(makerRetryDecision([order({ status: 'uncertain' })], Date.parse('2026-01-01T00:02:00Z'), close).allowed).toBe(false);
    const retry = order({ id: `${logical}:retry:2`, logicalOrderId: logical, attemptNumber: 2, createdAt: '2026-01-01T00:02:00Z' });
    expect(makerRetryDecision([order(), retry], Date.parse('2026-01-01T00:03:00Z'), close).reason).toContain('Maximum 2');
  });

  it('finds attempts for the requested track and excludes copied exit records', () => {
    const retry = order({ id: `${logical}:retry:2`, attemptNumber: 2, createdAt: '2026-01-01T00:02:00Z' });
    const exit = order({ id: `${logical}:exit:venue`, status: 'sold' });
    const unrelated = order({ id: 'live:ETH:other', logicalOrderId: 'live:ETH:other', symbol: 'ETH' });
    const paperLogical = logical.replace('live:', 'paper:');
    const paper = order({ id: paperLogical, logicalOrderId: paperLogical, executionMode: 'paper' });
    expect(entryAttemptsForLogicalOrder([unrelated, exit, retry, paper, order({ logicalOrderId: undefined })], logical).map((item) => item.id)).toEqual([logical, `${logical}:retry:2`]);
    expect(entryAttemptsForLogicalOrder([paper, order()], paperLogical, 'paper').map((item) => item.id)).toEqual([paperLogical]);
  });
});
