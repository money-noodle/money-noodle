import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const stateless = vi.fn(() => false);
const performanceSummary = vi.fn();
const forecastHistory = vi.fn();
const executionOrders = vi.fn();
const cyclePaths = vi.fn();
const walkForward = vi.fn();
const syncEnabled = vi.fn(() => false);
const readProjection = vi.fn();
const writeProjection = vi.fn();

vi.mock('./runtime-environment', () => ({
  isStatelessDeployment: () => stateless(),
  STATELESS_WORKER_MESSAGE: 'stateless',
}));
vi.mock('./forecast-tracker', () => ({
  getPerformanceSummary: () => performanceSummary(),
  getForecastHistory: () => forecastHistory(),
}));
vi.mock('./paper-execution', () => ({ getExecutionOrders: () => executionOrders() }));
vi.mock('./cycle-path-store', () => ({ getCyclePathReport: () => cyclePaths() }));
vi.mock('./model-evaluation-store', () => ({ getWalkForwardEvaluationHistory: () => walkForward() }));
vi.mock('./postgres-paper-projection', () => ({
  postgresPaperProjectionSyncEnabled: () => syncEnabled(),
  readPublicPaperPerformanceFromPostgres: () => readProjection(),
  syncPublicPaperPerformanceToPostgres: (payload: unknown) => writeProjection(payload),
}));

import { getPublicPaperPerformance, replicatePublicPaperPerformance } from './public-paper-performance';
import { summarizePerformance } from './performance';
import type { PaperOrder, TrackedForecast } from './types';

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
    expect(projection.paperRecord.mode).toBe('paper');
    // Publishing results must not read the walk-forward store at all, so fitted weights cannot leak.
    expect(walkForward).not.toHaveBeenCalled();
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

  it('scores paper orders only, so a live result can never reach a public reader', async () => {
    executionOrders.mockResolvedValue([
      order('paper-win', 'paper', 250),
      order('live-win', 'live', 9_999),
    ]);
    const { paperRecord } = await getPublicPaperPerformance();
    expect(paperRecord.settled).toBe(1);
    expect(paperRecord.realizedPnlCents).toBe(250);
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

  it('reports a hosted dashboard with no snapshot as non-durable instead of inventing figures', async () => {
    stateless.mockReturnValue(true);
    readProjection.mockResolvedValue(null);
    const projection = await getPublicPaperPerformance();
    expect(projection.durable).toBe(false);
    expect(projection.summary.issued).toBe(0);
    expect(projection.paperRecord.settled).toBe(0);
    expect(projection.forecasts).toEqual([]);
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

  it('does nothing at all when replication is not configured', async () => {
    syncEnabled.mockReturnValue(false);
    await (await freshReplicate())();
    expect(writeProjection).not.toHaveBeenCalled();
    expect(performanceSummary).not.toHaveBeenCalled();
  });
});
