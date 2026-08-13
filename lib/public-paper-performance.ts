import 'server-only';

import { buildTradeRecord } from './execution-report';
import { getPerformanceSummary } from './forecast-tracker';
import { getExecutionOrders } from './paper-execution';
import { isStatelessDeployment } from './runtime-environment';
import type { PublicPaperPerformance, PublicPaperTradeRecord, PublicRecentForecast, PublicSignalQuality, TradeTrackRecord } from './types';

/** Newest qualifying calculations shown publicly. Bounded for the same reason as the paper ledger: a
 *  public reader gets a representative recent sample, never the full scoring history. */
const RECENT_LIMIT = 12;

const EMPTY_RECORD: PublicPaperTradeRecord = {
  settled: 0, pending: 0, windows: 0, wins: 0, losses: 0, winRate: null, roi: null,
  stakedCents: 0, realizedPnlCents: 0, meanPredictedEdge: null, meanRealizedReturn: null,
};

const EMPTY_SIGNAL: PublicSignalQuality = {
  issued: 0, cycles: 0, resolved: 0, resolvedCycles: 0, accuracy: null, cycleBalancedAccuracy: null,
  brierScore: null, currentCycleStreak: 0, calibrationWindows: 0, calibrationMinimum: 0,
  calibrationProgress: 0, calibrationReady: false,
};

/**
 * Field-by-field projection rather than a spread. The private record carries live-comparable segment,
 * switch, and exit counterfactuals, so copying it wholesale is how real-money detail would leak into a
 * public payload the first time an upstream field is added.
 */
function publicTradeRecord(record: TradeTrackRecord): PublicPaperTradeRecord {
  return {
    settled: record.settled, pending: record.pending, windows: record.windows,
    wins: record.wins, losses: record.losses, winRate: record.winRate, roi: record.roi,
    stakedCents: record.stakedCents, realizedPnlCents: record.realizedPnlCents,
    meanPredictedEdge: record.meanPredictedEdge, meanRealizedReturn: record.meanRealizedReturn,
  };
}

/**
 * Paper-only counterpart to the signed performance history. Signal quality scores the calculation and is
 * mode-independent; the executed-money half is built from paper orders alone and the live record is never
 * requested, so no real-money figure exists in this payload to redact.
 */
export async function getPublicPaperPerformance(): Promise<PublicPaperPerformance> {
  const generatedAt = new Date().toISOString();
  // A hosted dashboard has no persistent worker ledger or forecast log to score.
  if (isStatelessDeployment()) {
    return { durable: false, generatedAt, signal: EMPTY_SIGNAL, paperRecord: EMPTY_RECORD, recent: [] };
  }
  const [summary, orders] = await Promise.all([getPerformanceSummary(), getExecutionOrders()]);
  const signal: PublicSignalQuality = {
    issued: summary.issued, cycles: summary.cycles, resolved: summary.resolved,
    resolvedCycles: summary.resolvedCycles, accuracy: summary.accuracy,
    cycleBalancedAccuracy: summary.cycleBalancedAccuracy, brierScore: summary.brierScore,
    currentCycleStreak: summary.currentCycleStreak, calibrationWindows: summary.calibrationWindows,
    calibrationMinimum: summary.calibrationMinimum, calibrationProgress: summary.calibrationProgress,
    calibrationReady: summary.calibrationReady,
  };
  const recent: PublicRecentForecast[] = summary.recent.slice(0, RECENT_LIMIT).map((forecast) => ({
    symbol: forecast.symbol, direction: forecast.direction,
    status: forecast.status, correct: forecast.correct,
  }));
  return { durable: true, generatedAt, signal, paperRecord: publicTradeRecord(buildTradeRecord(orders, 'paper')), recent };
}
