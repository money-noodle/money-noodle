import 'server-only';
import { getExecutionOrders } from './paper-execution';
import { getTradingControl } from './trading-control';
import { getProviderBudgets } from './provider-budget-store';
import { getHoldSentinelReport } from './hold-sentinel-store';
import { getContractPathRollups } from './contract-path-store';
import { buildLongShotReport } from './long-shot-report';
import { longShotExitFeeCents, longShotAllocationCents, longShotPolicyVersion } from './long-shot-execution';
import { longShotFunding } from './long-shot-engine';
import { longShotDailyLossCapCents, longShotSettings } from './long-shot-policy';
import { strategyOrders } from './execution-report';
import { LONG_SHOT_ROUND_TRIP } from './strategy-registry';
import { DEFAULT_MARKET_ID } from './market-registry';
import { postgresPaperProjectionSyncEnabled, syncPublicLongShotToPostgres } from './postgres-paper-projection';

/**
 * The long-shot surface, assembled once so the signed local route and the replicated public projection
 * cannot drift apart. See docs/long-shot-policy-design.md.
 */
export async function buildLongShotPayload(): Promise<Record<string, unknown>> {
  const settings = longShotSettings();
  const [orders, control, budgets, hold, paths] = await Promise.all([
    getExecutionOrders(), getTradingControl(), getProviderBudgets(),
    getHoldSentinelReport(longShotPolicyVersion(settings), longShotExitFeeCents),
    getContractPathRollups(200),
  ]);

  const allocation = budgets.providers.find((provider) => provider.providerId === 'kalshi')?.allocations
    .find((item) => item.marketId === DEFAULT_MARKET_ID)?.strategies
    ?.find((strategy) => strategy.strategyId === LONG_SHOT_ROUND_TRIP);
  const startingCents = longShotAllocationCents(control.control.startingBudgetCents, allocation?.startingCents);
  const fundedAtMs = Date.parse(allocation?.fundedAt ?? '') || 0;
  const mine = strategyOrders(orders, LONG_SHOT_ROUND_TRIP);
  const policyVersion = longShotPolicyVersion(settings);

  const track = (mode: 'paper' | 'live') => {
    const funding = longShotFunding(orders, mode, startingCents, settings, fundedAtMs);
    return {
      mode,
      equityCents: funding.equityCents,
      reservedCents: funding.reservedCents,
      headroomCents: funding.headroomCents,
      ticketCents: funding.sizing.ticketCents,
      halted: funding.sizing.halted,
      haltThresholdCents: funding.sizing.haltThresholdCents,
      haltReason: funding.sizing.reason ?? null,
      dailyLossCapCents: longShotDailyLossCapCents(funding.sizing.ticketCents, settings),
      report: buildLongShotReport({ orders: mine, mode, policyVersion }),
    };
  };

  return {
    policyVersion,
    enabled: settings.enabled,
    liveEnabled: settings.liveEnabled,
    settings: {
      entryMarkCents: settings.entryMarkCents,
      exitMarkCents: settings.exitMarkCents,
      minimumSecondsRemaining: settings.minimumSecondsRemaining,
      drawdownDivisor: settings.drawdownDivisor,
      minimumTicketCents: settings.minimumTicketCents,
      maximumOpenPerSettlementWindow: settings.maximumOpenPerSettlementWindow,
      maximumEntriesPerAssetWindow: settings.maximumEntriesPerAssetWindow,
      dailyLossTickets: settings.dailyLossTickets,
      excludedAssets: settings.excludedAssets,
    },
    allocation: { startingCents, funded: startingCents > 0, fundedAt: allocation?.fundedAt ?? null },
    tracks: [track('paper'), track('live')],
    hold,
    contractPaths: {
      windows: paths.length,
      samples: paths.reduce((total, path) => total + path.samples, 0),
      recent: paths.slice(0, 20),
    },
  };
}

/**
 * The replicated shape: **paper only**.
 *
 * A stateless deployment may read replicated paper projections and nothing else. Carrying the live track
 * would put real equity, tickets, and P&L on a host with no execution authority and no way to reconcile
 * them, so it is dropped here rather than filtered at the reader — the reader cannot drop a field it was
 * never told about, and this is the only place that decision is made.
 *
 * `liveEnabled` is dropped for the same reason: arming state belongs to the worker that can act on it.
 */
export function publicLongShotPayload(full: Record<string, unknown>): Record<string, unknown> {
  const tracks = (full.tracks ?? []) as Array<{ mode: string }>;
  return {
    policyVersion: full.policyVersion,
    enabled: full.enabled,
    settings: full.settings,
    allocation: full.allocation,
    paper: tracks.find((track) => track.mode === 'paper') ?? null,
    hold: full.hold,
    contractPaths: full.contractPaths,
  };
}

/** Matches the performance projection: freshness on a hosted dashboard is not worth a cycle's latency. */
const REPLICATION_INTERVAL_MS = 60_000;
let lastReplicatedAt = 0;

/**
 * Publishes the paper lane for the hosted dashboard.
 *
 * Best effort and throttled, and the caller must never await it on a collection or execution path: a
 * database outage may cost the hosted dashboard freshness and nothing else.
 */
export async function replicatePublicLongShot(): Promise<void> {
  if (!postgresPaperProjectionSyncEnabled()) return;
  if (Date.now() - lastReplicatedAt < REPLICATION_INTERVAL_MS) return;
  lastReplicatedAt = Date.now();
  await syncPublicLongShotToPostgres(publicLongShotPayload(await buildLongShotPayload()));
}
