import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const stateless = vi.fn(() => false);
const performanceSummary = vi.fn();
const forecastHistory = vi.fn();
const executionOrders = vi.fn();
const cyclePaths = vi.fn();
const walkForward = vi.fn();
const syncEnabled = vi.fn(() => false);
const readProjection = vi.fn();
const readSummaryProjection = vi.fn();
const writeProjection = vi.fn();
const writeSummaryProjection = vi.fn();

vi.mock('./runtime-environment', () => ({
  isStatelessDeployment: () => stateless(),
  STATELESS_WORKER_MESSAGE: 'stateless',
}));
vi.mock('./forecast-tracker', () => ({
  getPerformanceSummary: () => performanceSummary(),
  getRecentForecastHistory: () => forecastHistory(),
}));
vi.mock('./paper-execution', () => ({
  getExecutionOrders: (filter?: unknown) => executionOrders(filter),
  getPaperBankrollFunding: () => ({ fundingId: 'paper-original', fundingSequence: 1, resets: 0, correctionCents: 0 }),
}));
vi.mock('./cycle-path-store', () => ({ getCyclePathReport: () => cyclePaths() }));
vi.mock('./model-evaluation-store', () => ({ getWalkForwardEvaluationHistory: () => walkForward() }));
vi.mock('./postgres-paper-projection', () => ({
  postgresPaperProjectionSyncEnabled: () => syncEnabled(),
  readPublicPaperPerformanceFromPostgres: () => readProjection(),
  readPublicPaperPerformanceSummaryFromPostgres: () => readSummaryProjection(),
  syncPublicPaperPerformanceToPostgres: (payload: unknown) => writeProjection(payload),
  syncPublicPaperPerformanceSummaryToPostgres: (payload: unknown) => writeSummaryProjection(payload),
}));

import {
  getPublicPaperPerformance as maybePublicPaperPerformance, getPublicPaperPerformanceSummary,
  replicatePublicPaperPerformance,
} from './public-paper-performance';
import { summarizePerformance } from './performance';
import type { PaperOrder, TrackedForecast } from './types';

afterEach(() => vi.useRealTimers());

function forecast(id: string, overrides: Partial<TrackedForecast> = {}): TrackedForecast {
  return {
    id, symbol: 'BTC', marketUrl: 'https://example.com/btc', issuedAt: '2026-08-11T00:00:00Z',
    closesAt: '2026-08-11T00:15:00Z', direction: 'UP', probabilityUp: 0.62,
    directionalLikelihood: 0.62, confidence: 0.7, modelVersion: 'test', policyVersion: 'test',
    polymarketProbabilityUp: 0.55, status: 'resolved', outcome: 'UP', correct: true,
    // Private per-forecast detail that must never reach a public reader.
    factors: [{ id: 'trend', label: 'Trend', score: 0.4, weight: 0.3, contribution: 0.12, confidence: 0.8, available: true }],
    venueContracts: { kalshi: { contractId: 'KX-SECRET', capturedAt: '2026-08-11T00:00:00Z' } },
    ...overrides,
  } as TrackedForecast;
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

const EVALUATIONS = { policyVersion: 'test', activationWindows: 100, checkpointEveryWindows: 25, currentWindows: 9, nextCheckpointWindows: 25, runs: [] };
const PATHS = { policyVersion: 'test', totalCycles: 4, completedCycles: 3, totalPoints: 40, latestByAsset: [] };

async function getPublicPaperPerformance() {
  const projection = await maybePublicPaperPerformance();
  if (!projection) throw new Error('Expected a public paper projection.');
  return projection;
}

describe('public paper performance projection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateless.mockReturnValue(false);
    syncEnabled.mockReturnValue(false);
    performanceSummary.mockImplementation(() => summarizePerformance([forecast('scored-1'), forecast('scored-2')]));
    forecastHistory.mockResolvedValue([forecast('history-1')]);
    executionOrders.mockResolvedValue([]);
    cyclePaths.mockResolvedValue(PATHS);
    walkForward.mockResolvedValue(EVALUATIONS);
  });

  it('serves the full forecast scoring, not a narrowed subset', async () => {
    const { summary } = await getPublicPaperPerformance();
    for (const field of ['calibrationBins', 'benchmarks', 'edgeBuckets', 'segments', 'byLeadTime',
      'byAsset', 'byDirection', 'byConfidenceBucket', 'timeline', 'missedBuyCounterfactual', 'logLoss']) {
      expect(summary).toHaveProperty(field);
    }
  });

  it('includes cycle paths for the public regimes tab', async () => {
    expect((await getPublicPaperPerformance()).cyclePaths).toEqual(PATHS);
  });

  it('never carries a live record, the live-only maker report, or the fitted model', async () => {
    const projection = await getPublicPaperPerformance();
    expect(projection).not.toHaveProperty('liveRecord');
    expect(projection).not.toHaveProperty('makerFillReport');
    expect(projection).not.toHaveProperty('modelEvaluations');
    // Funding history is published for paper and never for live: live's fundings describe real money.
    expect(projection).not.toHaveProperty('liveEpochs');
    expect(projection).toHaveProperty('paperEpochs');
    expect(projection.paperRecord.mode).toBe('paper');
    // Publishing results must not read the walk-forward store at all, so fitted weights cannot leak.
    expect(walkForward).not.toHaveBeenCalled();
  });

  it('publishes only paper fundings, and none that name a live epoch', async () => {
    const projection = await getPublicPaperPerformance();
    for (const funding of projection.paperEpochs ?? []) {
      // Live ids are minted as `epoch-N-...`; a paper funding carrying one would mean a paper order was
      // attributed to a real funding that never paid for it, which is the defect the split identity closes.
      expect(funding.epochId.startsWith('epoch-')).toBe(false);
    }
    expect(JSON.stringify(projection)).not.toContain('legacy-pre-epoch');
  });

  it('omits fitted model parameters from the serialized payload', async () => {
    const serialized = JSON.stringify(await getPublicPaperPerformance());
    for (const weight of ['basisWeight', 'temperature', 'volatilityScale', 'slowTiltScale',
      'probabilityCap', 'selectedParameters', 'recommendedParameters', 'datasetFingerprint']) {
      expect(serialized).not.toContain(weight);
    }
  });

  it('compacts recent and historical forecasts to rows without factors or contract provenance', async () => {
    const { summary, forecasts } = await getPublicPaperPerformance();
    const serialized = JSON.stringify({ recent: summary.recent, forecasts });
    expect(serialized).not.toContain('KX-SECRET');
    expect(serialized).not.toContain('factors');
    expect(serialized).not.toContain('venueContracts');
    expect(Object.keys(forecasts[0]).sort()).toEqual([
      'confidence', 'correct', 'direction', 'directionalLikelihood', 'id', 'issuedAt',
      'modelVersion', 'outcome', 'policyVersion', 'status', 'symbol',
    ]);
  });

  it('reports the same money in the funding history as in the published bankroll', async () => {
    executionOrders.mockResolvedValue([
      order('paper-edge', 'paper', 250),
      { ...order('paper-longshot', 'paper', -900), strategyId: 'long-shot-round-trip' } as PaperOrder,
      order('live-win', 'live', 9_999),
    ]);
    const { paperEpochs } = await getPublicPaperPerformance();
    // Another strategy draws on its own equity, not this bankroll, and live never appears at all. The
    // history reports what the published bankroll did, so it narrows to the policy that owns it.
    expect(paperEpochs).toHaveLength(1);
    expect(paperEpochs![0].budgetPnlCents).toBe(250);
    expect(paperEpochs![0].settled).toBe(1);
  });

  it('requests only the paper edge-policy ledger cohort from the shared runtime', async () => {
    await getPublicPaperPerformance();
    expect(executionOrders).toHaveBeenCalledWith({ executionMode: 'paper', strategyId: 'edge-binary-buy' });
  });

  it('builds the polling summary without reading history shards or cycle paths', async () => {
    executionOrders.mockResolvedValue([order('paper-win', 'paper', 250)]);
    const summary = await getPublicPaperPerformanceSummary();
    expect(summary).toMatchObject({
      durable: true,
      paperRecord: { mode: 'paper', settled: 1, realizedPnlCents: 250 },
    });
    expect(summary!.summary.recent).toHaveLength(2);
    expect(forecastHistory).not.toHaveBeenCalled();
    expect(cyclePaths).not.toHaveBeenCalled();
  });

  it('scores paper orders only, so a live result can never reach a public reader', async () => {
    executionOrders.mockResolvedValue([
      { ...order('paper-win', 'paper', 250), executionMirrorPair: {
        version: 'entry-execution-mirror-pair-v1', id: 'private-pair-id',
      } } as PaperOrder,
      order('live-win', 'live', 9_999),
    ]);
    const projection = await getPublicPaperPerformance();
    const { paperRecord } = projection;
    expect(paperRecord.settled).toBe(1);
    expect(paperRecord.realizedPnlCents).toBe(250);
    expect(JSON.stringify(projection)).not.toContain('private-pair-id');
  });

  it('reads the replicated projection on a hosted dashboard instead of the local ledger', async () => {
    stateless.mockReturnValue(true);
    readProjection.mockResolvedValue({ durable: true, generatedAt: 'replicated', summary: { recent: [] }, paperRecord: { mode: 'paper' } });
    const projection = await getPublicPaperPerformance();
    expect(projection.durable).toBe(true);
    expect(projection.generatedAt).toBe('replicated');
    expect(performanceSummary).not.toHaveBeenCalled();
    expect(executionOrders).not.toHaveBeenCalled();
  });

  it('reports a hosted dashboard with no snapshot as unavailable instead of inventing figures', async () => {
    stateless.mockReturnValue(true);
    readProjection.mockResolvedValue(null);
    readSummaryProjection.mockResolvedValue(null);
    expect(await maybePublicPaperPerformance()).toBeNull();
    expect(await getPublicPaperPerformanceSummary()).toBeNull();
  });
});

describe('public paper performance replication', () => {
  /** The throttle is module state, so each case gets its own instance rather than inheriting a cooldown. */
  async function freshReplicate() {
    vi.resetModules();
    return (await import('./public-paper-performance')).replicatePublicPaperPerformance;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    stateless.mockReturnValue(false);
    syncEnabled.mockReturnValue(true);
    performanceSummary.mockImplementation(() => summarizePerformance([forecast('scored-1')]));
    forecastHistory.mockResolvedValue([forecast('history-1')]);
    executionOrders.mockResolvedValue([]);
    cyclePaths.mockResolvedValue(PATHS);
    walkForward.mockResolvedValue(EVALUATIONS);
  });

  it('publishes a payload without the read-time durable and generatedAt fields', async () => {
    await (await freshReplicate())();
    expect(writeProjection).toHaveBeenCalledTimes(1);
    const payload = writeProjection.mock.calls[0][0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty('durable');
    expect(payload).not.toHaveProperty('generatedAt');
    expect(payload).toHaveProperty('summary');
    expect(payload).toHaveProperty('paperRecord');
  });

  it('throttles below the collector cadence so scoring cannot run every cycle', async () => {
    const replicate = await freshReplicate();
    await replicate();
    await replicate();
    await replicate();
    expect(writeProjection).toHaveBeenCalledTimes(1);
  });

  it('publishes only the compact homepage member between full-report intervals', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-22T00:00:00Z'));
    const replicate = await freshReplicate();
    await replicate();
    expect(writeProjection).toHaveBeenCalledTimes(1);
    expect(writeSummaryProjection).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    await replicate();
    expect(writeProjection).toHaveBeenCalledTimes(1);
    expect(writeSummaryProjection).toHaveBeenCalledTimes(1);
    expect(forecastHistory).toHaveBeenCalledTimes(1);
    const compact = writeSummaryProjection.mock.calls[0][0] as Record<string, unknown>;
    expect(compact).toHaveProperty('summary');
    expect(compact).toHaveProperty('paperRecord');
    expect(compact).not.toHaveProperty('forecasts');
    vi.useRealTimers();
  });

  it('backs off exponentially after a database failure before rebuilding the payload', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-22T00:00:00Z'));
    writeProjection.mockRejectedValueOnce(new Error('quota exceeded')).mockResolvedValueOnce(undefined);
    const replicate = await freshReplicate();
    await expect(replicate()).rejects.toThrow('quota exceeded');
    expect(performanceSummary).toHaveBeenCalledTimes(1);

    await replicate();
    expect(performanceSummary).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    await replicate();
    expect(performanceSummary).toHaveBeenCalledTimes(2);
    expect(writeProjection).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('does nothing at all when replication is not configured', async () => {
    syncEnabled.mockReturnValue(false);
    await (await freshReplicate())();
    expect(writeProjection).not.toHaveBeenCalled();
    expect(performanceSummary).not.toHaveBeenCalled();
  });
});
