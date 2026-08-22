import 'server-only';

import { getCyclePathReport } from './cycle-path-store';
import { buildProviderTradeRecords, buildTradeRecord, buildTradeTrackSummary } from './execution-report';
import { getPerformanceSummary, getRecentForecastHistory } from './forecast-tracker';
import { getExecutionOrders, getPaperBankrollFunding } from './paper-execution';
import {
  buildPositiveEdgeFundingReport, compactPerformanceSignal, forecastHistoryRow,
} from './performance-read-model';
import {
  postgresPaperProjectionSyncEnabled, readPublicPaperPerformanceFromPostgres,
  readPublicPaperPerformanceSummaryFromPostgres, syncPublicPaperPerformanceSummaryToPostgres,
  syncPublicPaperPerformanceToPostgres,
} from './postgres-paper-projection';
import { isStatelessDeployment } from './runtime-environment';
import { EDGE_BINARY_BUY } from './strategy-registry';
import type { PublicPaperPerformance, PublicPaperPerformanceSummary } from './types';

/** Same bound as the signed history tab, so the public list is complete rather than a teaser. */
const FORECAST_LIMIT = 500;

/** Homepage counters move every minute; the complete analytical document is on-demand and settles slowly. */
const SUMMARY_REPLICATION_INTERVAL_MS = 60_000;
const FULL_REPLICATION_INTERVAL_MS = 15 * 60_000;
const REPLICATION_MAX_BACKOFF_MS = 60 * 60_000;
let nextSummaryReplicationAt = 0;
let nextFullReplicationAt = 0;
let consecutiveReplicationFailures = 0;
let replicationInFlight: Promise<void> | undefined;

/**
 * Paper-only counterpart to the signed performance history. Forecast scoring is mode-independent and the
 * lifetime summary is served whole from rollups; the history list reads only enough newest shards for its
 * bounded 500 rows. The executed-money half is built from paper orders alone. The live record and the
 * live-only maker-fill report, private target-integrity registry report, and worker-local prospective
 * policy/calendar evaluations are never requested, so no real-money or private evaluation record exists here to redact.
 */
export async function getPublicPaperPerformance(): Promise<PublicPaperPerformance | null> {
  const generatedAt = new Date().toISOString();
  // A hosted dashboard has no forecast log or ledger of its own; it reports the replicated projection.
  if (isStatelessDeployment()) return readPublicPaperPerformanceFromPostgres();
  const [summary, forecasts, orders, cyclePaths, paperFunding] = await Promise.all([
    getPerformanceSummary(), getRecentForecastHistory(FORECAST_LIMIT, true),
    getExecutionOrders({ executionMode: 'paper', strategyId: EDGE_BINARY_BUY }), getCyclePathReport(),
    getPaperBankrollFunding(),
  ]);
  const funding = buildPositiveEdgeFundingReport(orders, undefined, paperFunding);
  return {
    durable: true, generatedAt,
    summary: { ...summary, recent: summary.recent.map(forecastHistoryRow) },
    paperRecord: buildTradeRecord(orders, 'paper'),
    paperProviderRecords: buildProviderTradeRecords(orders, 'paper'),
    paperEpochs: funding.paperEpochs,
    forecasts: forecasts.map(forecastHistoryRow),
    cyclePaths,
  };
}

/** Polling read model: rollup counters plus one compact edge-paper record, never history shards. */
export async function getPublicPaperPerformanceSummary(): Promise<PublicPaperPerformanceSummary | null> {
  if (isStatelessDeployment()) return readPublicPaperPerformanceSummaryFromPostgres();
  const [summary, orders] = await Promise.all([
    getPerformanceSummary(),
    getExecutionOrders({ executionMode: 'paper', strategyId: EDGE_BINARY_BUY, includeArchivedEvidence: false }),
  ]);
  return {
    durable: true,
    generatedAt: new Date().toISOString(),
    summary: compactPerformanceSignal(summary),
    paperRecord: buildTradeTrackSummary(orders, 'paper'),
  };
}

/**
 * Publishes the worker's track record for the hosted dashboard to read. Best effort and throttled: the
 * caller must never await it on a collection or execution path, and a database outage may only cost the
 * hosted dashboard freshness, never a local cycle.
 */
export async function replicatePublicPaperPerformance(): Promise<void> {
  if (!postgresPaperProjectionSyncEnabled()) return;
  if (replicationInFlight) return replicationInFlight;
  const startedAt = Date.now();
  if (startedAt < nextSummaryReplicationAt) return;
  nextSummaryReplicationAt = startedAt + SUMMARY_REPLICATION_INTERVAL_MS;

  const operation = (async () => {
    try {
      // Probe availability with the bounded homepage projection first. A database outage must fail before
      // the worker hydrates terminal execution evidence and builds a full analytical document that cannot
      // be published. On a healthy full interval this small write also keeps the homepage current while
      // the larger report is assembled.
      const summary = await getPublicPaperPerformanceSummary();
      if (!summary) return;
      const { durable: _summaryDurable, generatedAt: _summaryGeneratedAt, ...summaryPayload } = summary;
      await syncPublicPaperPerformanceSummaryToPostgres(summaryPayload);

      if (startedAt >= nextFullReplicationAt) {
        // Bound attempts as well as successful writes. A full-payload-specific failure may not force the
        // archive to hydrate again every minute while the compact projection remains healthy.
        nextFullReplicationAt = Date.now() + FULL_REPLICATION_INTERVAL_MS;
        const full = await getPublicPaperPerformance();
        // Only a locally scored payload is worth publishing; never echo a projection back into itself.
        if (!full) return;
        const { durable: _durable, generatedAt: _generatedAt, ...payload } = full;
        await syncPublicPaperPerformanceToPostgres(payload);
      }
      consecutiveReplicationFailures = 0;
      nextSummaryReplicationAt = Date.now() + SUMMARY_REPLICATION_INTERVAL_MS;
    } catch (error) {
      consecutiveReplicationFailures += 1;
      nextSummaryReplicationAt = Date.now() + Math.min(
        REPLICATION_MAX_BACKOFF_MS,
        SUMMARY_REPLICATION_INTERVAL_MS * 2 ** consecutiveReplicationFailures,
      );
      throw error;
    }
  })();
  replicationInFlight = operation;
  try { await operation; }
  finally { if (replicationInFlight === operation) replicationInFlight = undefined; }
}
