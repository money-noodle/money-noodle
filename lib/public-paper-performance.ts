import 'server-only';

import { getCyclePathReport } from './cycle-path-store';
import { buildTradeRecord } from './execution-report';
import { getForecastHistory, getPerformanceSummary } from './forecast-tracker';
import { getExecutionOrders } from './paper-execution';
import { summarizePerformance } from './performance';
import { postgresPaperProjectionSyncEnabled, readPublicPaperPerformanceFromPostgres, syncPublicPaperPerformanceToPostgres } from './postgres-paper-projection';
import { isStatelessDeployment } from './runtime-environment';
import type { ForecastHistoryRow, PublicPaperPerformance, TrackedForecast } from './types';

/** Same bound as the signed history tab, so the public list is complete rather than a teaser. */
const FORECAST_LIMIT = 500;

/** Scoring the whole forecast log costs far more than the budget aggregate, and the collector runs every
 *  15 seconds, so replication is throttled well below the collector cadence. */
const REPLICATION_INTERVAL_MS = 60_000;
let lastReplicatedAt = 0;

/**
 * The private summary carries whole forecast records in `recent`, including factor weights, contract
 * provenance, and calibration replay snapshots. The public payload reports the same forecasts through
 * the compact row shape already used by the history list.
 */
function historyRow(forecast: TrackedForecast): ForecastHistoryRow {
  return {
    id: forecast.id, symbol: forecast.symbol, direction: forecast.direction,
    directionalLikelihood: forecast.directionalLikelihood, issuedAt: forecast.issuedAt,
    modelVersion: forecast.modelVersion, policyVersion: forecast.policyVersion,
    confidence: forecast.confidence, outcome: forecast.outcome,
    status: forecast.status, correct: forecast.correct,
  };
}

/**
 * Built from the real summarizer and record builder over empty inputs rather than a hand-written object,
 * so the zeroed shape cannot drift as scoring gains fields. Used only when a hosted dashboard has no
 * replicated projection to serve yet.
 */
function emptyPerformance(generatedAt: string): PublicPaperPerformance {
  const summary = summarizePerformance([]);
  return {
    durable: false, generatedAt,
    summary: { ...summary, recent: [] },
    paperRecord: buildTradeRecord([], 'paper'),
    forecasts: [],
  };
}

/**
 * Paper-only counterpart to the signed performance history. Forecast scoring is mode-independent and is
 * served whole; the executed-money half is built from paper orders alone. The live record and the
 * live-only maker-fill report are never requested, so no real-money figure exists here to redact.
 */
export async function getPublicPaperPerformance(): Promise<PublicPaperPerformance> {
  const generatedAt = new Date().toISOString();
  // A hosted dashboard has no forecast log or ledger of its own; it reports the replicated projection.
  if (isStatelessDeployment()) {
    return await readPublicPaperPerformanceFromPostgres() ?? emptyPerformance(generatedAt);
  }
  const [summary, forecasts, orders, cyclePaths] = await Promise.all([
    getPerformanceSummary(), getForecastHistory(), getExecutionOrders(), getCyclePathReport(),
  ]);
  return {
    durable: true, generatedAt,
    summary: { ...summary, recent: summary.recent.map(historyRow) },
    paperRecord: buildTradeRecord(orders, 'paper'),
    forecasts: forecasts.filter((forecast) => forecast.qualified !== false).slice(0, FORECAST_LIMIT).map(historyRow),
    cyclePaths,
  };
}

/**
 * Publishes the worker's track record for the hosted dashboard to read. Best effort and throttled: the
 * caller must never await it on a collection or execution path, and a database outage may only cost the
 * hosted dashboard freshness, never a local cycle.
 */
export async function replicatePublicPaperPerformance(): Promise<void> {
  if (!postgresPaperProjectionSyncEnabled()) return;
  if (Date.now() - lastReplicatedAt < REPLICATION_INTERVAL_MS) return;
  lastReplicatedAt = Date.now();
  const { durable, generatedAt: _generatedAt, ...payload } = await getPublicPaperPerformance();
  // Only a locally scored payload is worth publishing; never echo a projection back into itself.
  if (!durable) return;
  await syncPublicPaperPerformanceToPostgres(payload);
}
