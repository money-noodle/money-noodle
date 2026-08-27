import { afterEach, describe, expect, it } from 'vitest';
import { ENTRY_EXECUTION_POLICY_VERSION } from './entry-execution-policy';
import { adaptiveEntryEpisodeDecision, entryAttemptsForLogicalOrder, entryEpisodeId, makerAttemptId, makerRetryDecision, maximumLiveMakerAttempts, terminalizeAdaptiveContinuation, terminalizeRefusedAdaptiveContinuation } from './maker-retry-policy';
import { PAPER_MANAGED_MAKER_EXECUTION_VERSION } from './paper-maker-simulation';
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

describe('maker then two-taker adaptive sequence', () => {
  const makerMiss = (patch: Partial<PaperOrder> = {}) => order({
    liquidityRole: 'maker', noFillReason: 'rested_no_fill', makerCompletedAt: '2026-01-01T00:01:20Z',
    entryExecutionDecision: {
      policyVersion: ENTRY_EXECUTION_POLICY_VERSION, configuredMode: 'adaptive', executedStyle: 'maker', recommendedStyle: 'maker',
      route: 'ordinary-maker', reason: 'maker', takerNetEdge: 0.18, medianNetEdge: 0.14, makerNetEdge: 0.2,
      makerExpectedCapturedEdge: 0.1, takerAdvantage: 0.08, makerCohort: 'x', makerSamples: 40, makerFillRate: 0.5,
    }, ...patch,
  });
  const takerMiss = (patch: Partial<PaperOrder> = {}) => makerMiss({
    id: `${logical}:episode:2`, attemptNumber: 2, createdAt: '2026-01-01T00:02:00Z',
    liquidityRole: 'taker', noFillReason: 'ioc_no_fill',
    entryExecutionDecision: { ...makerMiss().entryExecutionDecision!, executedStyle: 'taker', recommendedStyle: 'taker', route: 'maker-miss-taker-fallback' },
    ...patch,
  });

  it('opens taker one only after authoritative maker zero-fill', () => {
    expect(adaptiveEntryEpisodeDecision([makerMiss()], ENTRY_EXECUTION_POLICY_VERSION)).toMatchObject({
      allowed: true, attemptNumber: 2, retryOfOrderId: logical, takerFallback: true,
    });
    expect(adaptiveEntryEpisodeDecision([makerMiss({ noFillReason: 'post_only_race' })], ENTRY_EXECUTION_POLICY_VERSION).allowed).toBe(false);
  });

  it('opens one final taker only after an accepted IOC zero-fill', () => {
    expect(adaptiveEntryEpisodeDecision([makerMiss(), takerMiss()], ENTRY_EXECUTION_POLICY_VERSION)).toMatchObject({
      allowed: true, attemptNumber: 3, takerFallback: true,
    });
    expect(adaptiveEntryEpisodeDecision([makerMiss(), takerMiss({ noFillReason: 'pre_submit_quote_moved' })], ENTRY_EXECUTION_POLICY_VERSION).allowed).toBe(false);
    expect(adaptiveEntryEpisodeDecision([makerMiss(), takerMiss({ status: 'rejected' })], ENTRY_EXECUTION_POLICY_VERSION).allowed).toBe(false);
  });

  it('ends after the second taker and never follows fill, partial, ambiguity, or old generation', () => {
    const third = takerMiss({ id: `${logical}:episode:3`, attemptNumber: 3, createdAt: '2026-01-01T00:03:00Z' });
    expect(adaptiveEntryEpisodeDecision([makerMiss(), takerMiss(), third], ENTRY_EXECUTION_POLICY_VERSION).reason).toContain('Maximum 3 entry intents');
    expect(adaptiveEntryEpisodeDecision([makerMiss({ status: 'open', filledCount: 0.1 })], ENTRY_EXECUTION_POLICY_VERSION).allowed).toBe(false);
    expect(adaptiveEntryEpisodeDecision([makerMiss({ status: 'uncertain' })], ENTRY_EXECUTION_POLICY_VERSION).allowed).toBe(false);
    expect(adaptiveEntryEpisodeDecision([makerMiss({ fallbackSequenceEndedAt: '2026-01-01T00:01:21Z', fallbackSequenceEndReason: 'edge refused' })], ENTRY_EXECUTION_POLICY_VERSION)).toMatchObject({ allowed: false, reason: 'edge refused' });
    expect(adaptiveEntryEpisodeDecision([makerMiss({ entryExecutionDecision: {
      ...makerMiss().entryExecutionDecision!, policyVersion: 'maker-then-positive-edge-taker2-fresh2tick-v8',
    } })], ENTRY_EXECUTION_POLICY_VERSION)).toMatchObject({
      allowed: false, reason: 'A prior execution-policy generation cannot authorize a current fallback.',
    });
  });

  it('terminalizes a refused continuation on its predecessor and never overwrites the exact first reason', () => {
    const predecessor = makerMiss();
    const refusalDecision = {
      configuredMode: 'adaptive' as const, executedStyle: 'maker' as const, route: 'ordinary-maker' as const,
      reason: 'Taker fallback withheld: quality 64.8% < 65.0%; spread 3.0c > 2.0c.',
    };
    expect(terminalizeRefusedAdaptiveContinuation(
      [predecessor], true, refusalDecision, '2026-01-01T00:01:21Z',
    )).toBe(refusalDecision.reason);
    expect(predecessor).toMatchObject({
      fallbackSequenceEndedAt: '2026-01-01T00:01:21Z',
      fallbackSequenceEndReason: refusalDecision.reason,
    });
    expect(adaptiveEntryEpisodeDecision([predecessor], ENTRY_EXECUTION_POLICY_VERSION)).toMatchObject({
      allowed: false, reason: refusalDecision.reason,
    });
    expect(terminalizeAdaptiveContinuation([predecessor], 'generic outer reason', '2026-01-01T00:01:22Z'))
      .toBe(refusalDecision.reason);
    expect(predecessor.fallbackSequenceEndReason).toBe(refusalDecision.reason);
  });

  it('accepts only a taker fallback as an executable adaptive continuation', () => {
    const predecessor = makerMiss();
    expect(terminalizeRefusedAdaptiveContinuation([predecessor], true, {
      configuredMode: 'adaptive', executedStyle: 'taker', route: 'maker-miss-taker-fallback', reason: 'authorized',
    }, '2026-01-01T00:01:21Z')).toBeUndefined();
    expect(predecessor.fallbackSequenceEndedAt).toBeUndefined();
  });

  it('uses the paper simulator generation for paper lifecycle authority', () => {
    const paperMiss = makerMiss({ executionMode: 'paper', entryDecision: {
      version: 'entry-decision-v2', providerId: 'kalshi', forecastModelVersion: 'test', executionPolicyVersion: PAPER_MANAGED_MAKER_EXECUTION_VERSION,
      policyVersion: 'test', calculationAt: '2026-01-01T00:01:00Z', side: 'UP', probabilityUp: 0.7, probabilityDown: 0.3,
      selectedSideProbability: 0.7, confidence: 0.7, confidenceBreakdown: { base: 0.3, dataQuality: 0.2, sampleQuality: 0.2, uncertaintyPenalty: 0 },
      actionableAsk: 0.4, actionableBid: 0.39, feeRate: 0.01, netEdge: 0.29, spread: 0.01, secondsRemaining: 840,
      qualifyingSnapshots: 2, medianNetEdge: 0.28, factors: [],
    } });
    expect(adaptiveEntryEpisodeDecision([paperMiss], PAPER_MANAGED_MAKER_EXECUTION_VERSION).allowed).toBe(true);
    expect(adaptiveEntryEpisodeDecision([paperMiss], 'paper-managed-execution-route-ioc-v4').allowed).toBe(false);
  });
});

describe('bounded maker retry policy', () => {
  it('creates distinct durable ids for historical retries and current episodes', () => {
    expect(makerAttemptId(logical, 1)).toBe(logical);
    expect(makerAttemptId(logical, 2)).toBe(`${logical}:retry:2`);
    expect(entryEpisodeId(logical, 1)).toBe(logical);
    expect(entryEpisodeId(logical, 2)).toBe(`${logical}:episode:2`);
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
    const episode = order({ id: `${logical}:episode:3`, attemptNumber: 3, createdAt: '2026-01-01T00:03:00Z' });
    const exit = order({ id: `${logical}:exit:venue`, status: 'sold' });
    const unrelated = order({ id: 'live:ETH:other', logicalOrderId: 'live:ETH:other', symbol: 'ETH' });
    const paperLogical = logical.replace('live:', 'paper:');
    const paper = order({ id: paperLogical, logicalOrderId: paperLogical, executionMode: 'paper' });
    expect(entryAttemptsForLogicalOrder([unrelated, exit, episode, retry, paper, order({ logicalOrderId: undefined })], logical).map((item) => item.id)).toEqual([logical, `${logical}:retry:2`, `${logical}:episode:3`]);
    expect(entryAttemptsForLogicalOrder([paper, order()], paperLogical, 'paper').map((item) => item.id)).toEqual([paperLogical]);
  });
});
