import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const stateless = vi.fn(() => false);
const performanceSummary = vi.fn();
const executionOrders = vi.fn();

vi.mock('./runtime-environment', () => ({
  isStatelessDeployment: () => stateless(),
  STATELESS_WORKER_MESSAGE: 'stateless',
}));
vi.mock('./forecast-tracker', () => ({ getPerformanceSummary: () => performanceSummary() }));
vi.mock('./paper-execution', () => ({ getExecutionOrders: () => executionOrders() }));

import { getPublicPaperPerformance } from './public-paper-performance';
import type { PaperOrder, PerformanceSummary, TrackedForecast } from './types';

/** Only the fields the projection reads, plus private extras that must never reach a public reader. */
function summary(): PerformanceSummary {
  return {
    issued: 40, pending: 4, resolved: 36, cycles: 12, resolvedCycles: 10,
    cycleBalancedAccuracy: 0.6, correct: 22, invalid: 0, accuracy: 0.61, brierScore: 0.21,
    logLoss: 0.6, currentStreak: 2, currentCycleStreak: 1, observedCalculations: 80,
    resolvedCalculations: 70, benchmarks: [{ id: 'coinflip' }], edgeBuckets: [{ id: 'bucket' }],
    segments: [{ id: 'segment' }], missedBuyCounterfactual: { evaluated: 3 },
    resolvedWindows: 9, evaluationMinimumWindows: 30, evaluationMeaningful: false,
    realizedEdgeTrades: 6, meanPredictedEdge: 0.07, meanRealizedReturn: 0.02,
    byLeadTime: [], calibrationBins: [{ bin: 0.5 }], calibrationWindows: 9,
    calibrationMinimum: 30, calibrationProgress: 0.3, calibrationReady: false,
    byAsset: [], byDirection: [], byModelVersion: [], byConfidenceBucket: [], timeline: [],
    recent: [forecast('paper-1'), forecast('paper-2')],
  } as unknown as PerformanceSummary;
}

function forecast(id: string): TrackedForecast {
  return {
    id, symbol: 'BTC', marketUrl: 'https://example.com/btc', issuedAt: '2026-08-11T00:00:00Z',
    closesAt: '2026-08-11T00:15:00Z', direction: 'UP', probabilityUp: 0.62,
    directionalLikelihood: 0.62, confidence: 0.7, modelVersion: 'test', policyVersion: 'test',
    polymarketProbabilityUp: 0.55, factors: [], status: 'resolved', correct: true,
  };
}

/** A settled winner whose realized P&L is unmistakable in the aggregate. */
function order(id: string, executionMode: PaperOrder['executionMode'], pnlCents: number): PaperOrder {
  return {
    id, executionMode, symbol: 'BTC', venue: 'kalshi', contractId: `contract-${id}`, side: 'UP',
    status: 'won', createdAt: '2026-08-11T00:01:00Z', calculationAt: '2026-08-11T00:00:30Z',
    closesAt: '2026-08-11T00:15:00Z', modelProbabilityUp: 0.62, confidence: 0.7,
    askPrice: 0.5, bidPrice: 0.48, spread: 0.02, quantity: 10, stakeCents: 500, feeCents: 10,
    potentialPayoutCents: 1_000, settledAt: '2026-08-11T00:15:05Z', outcome: 'UP',
    payoutCents: 500 + pnlCents, pnlCents,
  };
}

describe('public paper performance projection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateless.mockReturnValue(false);
    performanceSummary.mockResolvedValue(summary());
    executionOrders.mockResolvedValue([]);
  });

  it('exposes only allow-listed signal and paper-record fields', async () => {
    const projection = await getPublicPaperPerformance();
    expect(Object.keys(projection).sort()).toEqual(['durable', 'generatedAt', 'paperRecord', 'recent', 'signal']);
    expect(Object.keys(projection.signal).sort()).toEqual([
      'accuracy', 'brierScore', 'calibrationMinimum', 'calibrationProgress', 'calibrationReady',
      'calibrationWindows', 'currentCycleStreak', 'cycleBalancedAccuracy', 'cycles', 'issued',
      'resolved', 'resolvedCycles',
    ]);
    expect(Object.keys(projection.paperRecord).sort()).toEqual([
      'losses', 'meanPredictedEdge', 'meanRealizedReturn', 'pending', 'realizedPnlCents',
      'roi', 'settled', 'stakedCents', 'winRate', 'windows', 'wins',
    ]);
  });

  it('omits private summary detail that upstream scoring carries', async () => {
    const projection = await getPublicPaperPerformance();
    const serialized = JSON.stringify(projection);
    for (const leak of ['benchmarks', 'segments', 'missedBuyCounterfactual', 'calibrationBins', 'logLoss', 'edgeBuckets']) {
      expect(serialized).not.toContain(leak);
    }
  });

  it('drops the internal forecast identifier from recent calculations', async () => {
    const { recent } = await getPublicPaperPerformance();
    expect(recent).toEqual([
      { symbol: 'BTC', direction: 'UP', status: 'resolved', correct: true },
      { symbol: 'BTC', direction: 'UP', status: 'resolved', correct: true },
    ]);
  });

  it('scores paper orders only, so a live result can never reach a public reader', async () => {
    executionOrders.mockResolvedValue([
      order('paper-win', 'paper', 250),
      order('live-win', 'live', 9_999),
    ]);
    const { paperRecord } = await getPublicPaperPerformance();
    expect(paperRecord.settled).toBe(1);
    expect(paperRecord.realizedPnlCents).toBe(250);
  });

  it('reports a stateless hosted dashboard as non-durable instead of inventing figures', async () => {
    stateless.mockReturnValue(true);
    const projection = await getPublicPaperPerformance();
    expect(projection.durable).toBe(false);
    expect(projection.signal.issued).toBe(0);
    expect(projection.paperRecord.settled).toBe(0);
    expect(projection.recent).toEqual([]);
    expect(performanceSummary).not.toHaveBeenCalled();
  });
});
