import { epochResults, lifetimeRealizedPnlCents, type EpochResult } from './budget-epoch';
import { strategyOrders } from './execution-report';
import { EDGE_BINARY_BUY } from './strategy-registry';
import type {
  ForecastHistoryRow, PaperOrder, PerformanceSignalSummary, PerformanceSummary,
  PublicPaperPerformance, PublicPaperPerformanceSummary, TrackedForecast,
  TradeTrackRecord, TradeTrackSummary,
} from './types';

/** One forecast row with private factors and contract provenance removed. */
export function forecastHistoryRow(forecast: TrackedForecast | ForecastHistoryRow): ForecastHistoryRow {
  return {
    id: forecast.id, symbol: forecast.symbol, direction: forecast.direction,
    directionalLikelihood: forecast.directionalLikelihood, issuedAt: forecast.issuedAt,
    modelVersion: forecast.modelVersion, policyVersion: forecast.policyVersion,
    confidence: forecast.confidence, outcome: forecast.outcome,
    status: forecast.status, correct: forecast.correct,
  };
}

/** Only what the dashboard row renders; detailed execution evidence remains in the full report. */
export function compactTradeTrackRecord(record: TradeTrackRecord): TradeTrackSummary {
  return {
    mode: record.mode, settled: record.settled, windows: record.windows,
    wins: record.wins, losses: record.losses, winRate: record.winRate, roi: record.roi,
    realizedPnlCents: record.realizedPnlCents,
    meanPredictedEdge: record.meanPredictedEdge,
    meanRealizedReturn: record.meanRealizedReturn,
  };
}

/** The signal counters and four recent rows used before the full report is opened. */
export function compactPerformanceSignal(summary: PerformanceSummary): PerformanceSignalSummary {
  return {
    issued: summary.issued, cycles: summary.cycles, resolved: summary.resolved,
    resolvedCycles: summary.resolvedCycles, accuracy: summary.accuracy,
    cycleBalancedAccuracy: summary.cycleBalancedAccuracy, brierScore: summary.brierScore,
    currentCycleStreak: summary.currentCycleStreak,
    calibrationWindows: summary.calibrationWindows, calibrationMinimum: summary.calibrationMinimum,
    calibrationProgress: summary.calibrationProgress, calibrationReady: summary.calibrationReady,
    recent: summary.recent.slice(0, 4).map(forecastHistoryRow),
  };
}

/** Compatibility projection from the complete public record to its bounded homepage contract. */
export function compactPublicPaperPerformance(
  performance: PublicPaperPerformance,
  generatedAt = performance.generatedAt,
): PublicPaperPerformanceSummary {
  return {
    durable: true,
    generatedAt,
    summary: compactPerformanceSignal(performance.summary as PerformanceSummary),
    paperRecord: compactTradeTrackRecord(performance.paperRecord),
  };
}

export interface PositiveEdgeFundingReport {
  edgeOrders: PaperOrder[];
  liveEpochs: EpochResult[];
  liveLifetimePnlCents: number;
  paperEpochs: EpochResult[];
  paperLifetimePnlCents: number;
}

/**
 * Positive-edge funding attribution from a shared account ledger.
 *
 * Reconciliation remains account-wide; this is a reporting read model, so every money aggregate is
 * narrowed back to the strategy whose track record it accompanies. Paper's current funding then receives
 * the durable whole-cent corrections made against that bankroll.
 */
export function buildPositiveEdgeFundingReport(
  orders: PaperOrder[],
  liveEpochId: string | undefined,
  paperFunding: { fundingId: string; correctionCents: number },
): PositiveEdgeFundingReport {
  const edgeOrders = strategyOrders(orders, EDGE_BINARY_BUY);
  const paperEpochs = epochResults(edgeOrders, 'paper', paperFunding.fundingId).map((entry) => entry.current
    ? { ...entry, budgetPnlCents: entry.budgetPnlCents + paperFunding.correctionCents }
    : entry);
  return {
    edgeOrders,
    liveEpochs: epochResults(edgeOrders, 'live', liveEpochId),
    liveLifetimePnlCents: lifetimeRealizedPnlCents(edgeOrders, 'live'),
    paperEpochs,
    paperLifetimePnlCents: lifetimeRealizedPnlCents(edgeOrders, 'paper'),
  };
}
