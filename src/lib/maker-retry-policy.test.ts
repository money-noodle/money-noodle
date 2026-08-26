import { afterEach, describe, expect, it } from 'vitest';
import { ENTRY_EXECUTION_POLICY_VERSION } from './entry-execution-policy';
import { adaptiveEntryEpisodeDecision, entryAttemptsForLogicalOrder, entryEpisodeId, makerAttemptId, makerRetryDecision, maximumLiveMakerAttempts } from './maker-retry-policy';
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

describe('requalifying adaptive entry episodes', () => {
  const makerMiss = (patch: Partial<PaperOrder> = {}) => order({
    liquidityRole: 'maker', makerCompletedAt: '2026-01-01T00:01:20Z',
    entryExecutionDecision: {
      policyVersion: ENTRY_EXECUTION_POLICY_VERSION, configuredMode: 'adaptive', executedStyle: 'maker', recommendedStyle: 'maker',
      reason: 'maker', takerNetEdge: 0.18, medianNetEdge: 0.14, makerNetEdge: 0.2,
      makerExpectedCapturedEdge: 0.1, takerAdvantage: 0.08, makerCohort: 'x', makerSamples: 40,
      makerFillRate: 0.5,
    },
    ...patch,
  });

  it('opens a new episode after an authoritative current-policy maker zero-fill', () => {
    expect(adaptiveEntryEpisodeDecision([makerMiss()], ENTRY_EXECUTION_POLICY_VERSION)).toMatchObject({
      allowed: true, attemptNumber: 2, retryOfOrderId: logical,
    });
  });

  it('uses the simulator generation for a production-shaped paper row that also carries the shared route generation', () => {
    const paperMiss = makerMiss({
      executionMode: 'paper',
      entryDecision: {
        version: 'entry-decision-v2', providerId: 'kalshi', forecastModelVersion: 'test',
        executionPolicyVersion: PAPER_MANAGED_MAKER_EXECUTION_VERSION, policyVersion: 'test',
        calculationAt: '2026-01-01T00:01:00Z', side: 'UP', probabilityUp: 0.7, probabilityDown: 0.3,
        selectedSideProbability: 0.7, confidence: 0.7,
        confidenceBreakdown: { base: 0.3, dataQuality: 0.2, sampleQuality: 0.2, uncertaintyPenalty: 0 }, actionableAsk: 0.4,
        actionableBid: 0.39, feeRate: 0.01, netEdge: 0.29, spread: 0.01, secondsRemaining: 840,
        qualifyingSnapshots: 2, medianNetEdge: 0.28, factors: [],
      },
    });
    expect(paperMiss.entryExecutionDecision?.policyVersion).toBe(ENTRY_EXECUTION_POLICY_VERSION);
    expect(adaptiveEntryEpisodeDecision([paperMiss], PAPER_MANAGED_MAKER_EXECUTION_VERSION)).toMatchObject({
      allowed: true, attemptNumber: 2,
    });
    expect(adaptiveEntryEpisodeDecision([paperMiss], 'paper-managed-execution-route-ioc-v4')).toMatchObject({
      allowed: false, reason: 'A prior execution-policy generation cannot authorize a current entry episode.',
    });
  });

  it('caps the sequence after three maker episodes', () => {
    const second = makerMiss({ id: `${logical}:episode:2`, attemptNumber: 2, entryEpisode: 2, createdAt: '2026-01-01T00:02:00Z' });
    const third = makerMiss({ id: `${logical}:episode:3`, attemptNumber: 3, entryEpisode: 3, createdAt: '2026-01-01T00:03:00Z' });
    expect(adaptiveEntryEpisodeDecision([makerMiss(), second], ENTRY_EXECUTION_POLICY_VERSION)).toMatchObject({ allowed: true, attemptNumber: 3 });
    const ended = adaptiveEntryEpisodeDecision([makerMiss(), second, third], ENTRY_EXECUTION_POLICY_VERSION);
    expect(ended.allowed).toBe(false);
    expect(ended.reason).toContain('Maximum 3 entry episodes');
  });

  it('never follows a fill, uncertainty, taker, rejection, or retired-policy row', () => {
    expect(adaptiveEntryEpisodeDecision([makerMiss({ status: 'open', filledCount: 0.1 })], ENTRY_EXECUTION_POLICY_VERSION).allowed).toBe(false);
    expect(adaptiveEntryEpisodeDecision([makerMiss({ status: 'uncertain' })], ENTRY_EXECUTION_POLICY_VERSION).allowed).toBe(false);
    expect(adaptiveEntryEpisodeDecision([makerMiss({
      entryExecutionDecision: { ...makerMiss().entryExecutionDecision!, executedStyle: 'taker' },
    })], ENTRY_EXECUTION_POLICY_VERSION).allowed).toBe(false);
    expect(adaptiveEntryEpisodeDecision([makerMiss({ status: 'rejected' })], ENTRY_EXECUTION_POLICY_VERSION).allowed).toBe(false);
    expect(adaptiveEntryEpisodeDecision([makerMiss({
      entryExecutionDecision: { ...makerMiss().entryExecutionDecision!, policyVersion: 'retired-v1' },
    })], ENTRY_EXECUTION_POLICY_VERSION).allowed).toBe(false);
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
