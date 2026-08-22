import 'server-only';
import { getExecutionOrders, getPaperBankrollStartingCents } from './paper-execution';
import { getTradingControl } from './trading-control';
import { getProviderBudgets } from './provider-budget-store';
import { getHoldSentinelReport } from './hold-sentinel-store';
import { getContractPathRollups } from './contract-path-store';
import { buildLongShotReport } from './long-shot-report';
import { longShotExitFeeCents, longShotAllocationCents, longShotPolicyVersion, longShotTrackStartingCents } from './long-shot-execution';
import { longShotFunding } from './long-shot-engine';
import { longShotDailyLossCapCents, longShotSettings } from './long-shot-policy';
import { strategyOrders } from './execution-report';
import { LONG_SHOT_ROUND_TRIP } from './strategy-registry';
import { DEFAULT_MARKET_ID } from './market-registry';
import { postgresPaperProjectionSyncEnabled, syncPublicLongShotToPostgres } from './postgres-paper-projection';
import { estimatePaperFill, venueFeeCents } from './venue-fill';
import { evaluateBand, type AnalysisBandResult } from './analysis-bands';
import { readAnalysisBands } from './analysis-bands-store';
import { getLongShotCandidates } from './long-shot-candidate-store';
import { buildNearMoneySentinelReport } from './near-money-sentinel';

/**
 * The long-shot surface, assembled once so the signed local route and the replicated public projection
 * cannot drift apart. See docs/long-shot-policy-design.md.
 */
export async function buildLongShotPayload(): Promise<Record<string, unknown>> {
  const settings = longShotSettings();
  const [orders, control, budgets, hold, paths, paperBankrollCents] = await Promise.all([
    getExecutionOrders({ strategyId: LONG_SHOT_ROUND_TRIP, includeArchivedEvidence: false }), getTradingControl(), getProviderBudgets(),
    getHoldSentinelReport(longShotPolicyVersion(settings), longShotExitFeeCents),
    getContractPathRollups(200),
    getPaperBankrollStartingCents(),
  ]);

  const [bandStore, candidates] = await Promise.all([readAnalysisBands(), getLongShotCandidates()]);

  const allocation = budgets.providers.find((provider) => provider.providerId === 'kalshi')?.allocations
    .find((item) => item.marketId === DEFAULT_MARKET_ID)?.strategies
    ?.find((strategy) => strategy.strategyId === LONG_SHOT_ROUND_TRIP);
  const fundedAtMs = Date.parse(allocation?.fundedAt ?? '') || 0;
  const liveStartingCents = longShotAllocationCents(control.control.startingBudgetCents, allocation?.startingCents);
  const mine = strategyOrders(orders, LONG_SHOT_ROUND_TRIP);
  const policyVersion = longShotPolicyVersion(settings);

  const track = (mode: 'paper' | 'live') => {
    // Per-track basis, matching the engine exactly: a reporting surface that sizes differently from the
    // executor would show the operator a ticket the desk would never place.
    const startingCents = longShotTrackStartingCents({
      mode,
      marketCapCents: control.control.startingBudgetCents,
      paperBankrollCents,
      configuredStartingCents: allocation?.startingCents,
    });
    const funding = longShotFunding(orders, mode, startingCents, settings, mode === 'live' ? fundedAtMs : 0);
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
    // The live funded allocation. Paper's basis is the paper bankroll and is reported per track below.
    allocation: {
      startingCents: liveStartingCents,
      funded: liveStartingCents > 0,
      fundedAt: allocation?.fundedAt ?? null,
    },
    tracks: [track('paper'), track('live')],
    hold,
    contractPaths: {
      windows: paths.length,
      samples: paths.reduce((total, path) => total + path.samples, 0),
      recent: paths.slice(0, 20),
    },
    bands: buildBandReport(bandStore, candidates, settings),
    // Approach (iii), committed as a prospective test rather than screened into existence. See §15b.
    nearMoney: buildNearMoneySentinelReport(candidates, {
      ticketCents: Math.max(settings.minimumTicketCents, 20),
      fill: (stakeLimitCents: number, askPrice: number) => estimatePaperFill(stakeLimitCents, askPrice, 'kalshi'),
      exitFeeCents: (priceCents: number, quantity: number) => venueFeeCents('kalshi', priceCents, quantity, 'taker'),
    }),
  };
}

/**
 * Operator-defined bands measured over recorded candidates.
 *
 * The ticket and entry window come from the live settings so a band is scored on the same footing the desk
 * would trade it, and `savedCount` is carried onto the surface because it is the multiple-comparison
 * denominator — see docs/long-shot-policy-design.md §15a. This promotes nothing.
 */
function buildBandReport(
  bandStore: Awaited<ReturnType<typeof readAnalysisBands>>,
  candidates: Awaited<ReturnType<typeof getLongShotCandidates>>,
  settings: ReturnType<typeof longShotSettings>,
): {
  bandsVersion: string;
  savedCount: number;
  lastSavedAt: string | null;
  candidateRows: number;
  gradedWindows: number;
  ticketCents: number;
  minimumSecondsRemaining: number;
  results: AnalysisBandResult[];
} {
  // Scored at the launch ticket rather than current equity: return per $1 staked is what bands are
  // compared on, and a ticket that drifts with the book would make two bands measured days apart
  // incomparable for a reason that has nothing to do with either band.
  const ticketCents = Math.max(settings.minimumTicketCents, 20);
  const options = {
    ticketCents,
    minimumSecondsRemaining: settings.minimumSecondsRemaining,
    fill: (stakeLimitCents: number, askPrice: number) => estimatePaperFill(stakeLimitCents, askPrice, 'kalshi'),
    exitFeeCents: (priceCents: number, quantity: number) => venueFeeCents('kalshi', priceCents, quantity, 'taker'),
  };
  return {
    bandsVersion: bandStore.bandsVersion,
    savedCount: bandStore.savedCount,
    lastSavedAt: bandStore.history[0]?.savedAt ?? null,
    candidateRows: candidates.length,
    gradedWindows: new Set(candidates.filter((candidate) => candidate.settledSide).map((candidate) => candidate.closesAt)).size,
    ticketCents,
    minimumSecondsRemaining: settings.minimumSecondsRemaining,
    results: bandStore.current.map((band) => evaluateBand(candidates, band, options)),
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
    bands: full.bands,
    nearMoney: full.nearMoney,
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
