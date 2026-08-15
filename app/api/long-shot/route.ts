import { NextResponse } from 'next/server';
import { isAuthenticatedRequest } from '@/lib/auth';
import { isStatelessDeployment, STATELESS_WORKER_MESSAGE } from '@/lib/runtime-environment';
import { getExecutionOrders } from '@/lib/paper-execution';
import { getHoldSentinelReport } from '@/lib/hold-sentinel-store';
import { getContractPathRollups } from '@/lib/contract-path-store';
import { buildLongShotReport } from '@/lib/long-shot-report';
import { longShotExitFeeCents, longShotAllocationCents } from '@/lib/long-shot-execution';
import { longShotFunding } from '@/lib/long-shot-engine';
import { longShotDailyLossCapCents, longShotPolicyVersion, longShotSettings } from '@/lib/long-shot-policy';
import { strategyOrders } from '@/lib/execution-report';
import { LONG_SHOT_ROUND_TRIP } from '@/lib/strategy-registry';
import { getProviderBudgets } from '@/lib/provider-budget-store';
import { getTradingControl } from '@/lib/trading-control';
import { DEFAULT_MARKET_ID } from '@/lib/market-registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Read-only long-shot policy surface.
 *
 * Signed and worker-local, like the other evaluation lanes: this is collection evidence, and the public
 * paper projection must continue to describe the edge policy alone. Nothing here can arm, fund, size, or
 * trade — it reports what already happened.
 */
export async function GET(request: Request) {
  if (!isAuthenticatedRequest(request as import('next/server').NextRequest)) {
    return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  }
  if (isStatelessDeployment()) return NextResponse.json({ error: STATELESS_WORKER_MESSAGE }, { status: 503 });

  try {
    const settings = longShotSettings();
    const [orders, control, budgets, sentinels, paths] = await Promise.all([
      getExecutionOrders(), getTradingControl(), getProviderBudgets(),
      getHoldSentinelReport(longShotPolicyVersion(longShotSettings()), longShotExitFeeCents),
      getContractPathRollups(200),
    ]);

    const startingCents = longShotAllocationCents(
      control.control.startingBudgetCents,
      budgets.providers.find((provider) => provider.providerId === 'kalshi')?.allocations
        .find((allocation) => allocation.marketId === DEFAULT_MARKET_ID)?.strategies
        ?.find((strategy) => strategy.strategyId === LONG_SHOT_ROUND_TRIP)?.startingCents,
    );
    const mine = strategyOrders(orders, LONG_SHOT_ROUND_TRIP);

    // Per track, never blended: `paper − live` is only readable if the two are reported apart.
    const tracks = (['paper', 'live'] as const).map((mode) => {
      const funding = longShotFunding(orders, mode, startingCents, settings);
      return {
        mode,
        equityCents: funding.equityCents,
        reservedCents: funding.reservedCents,
        headroomCents: funding.headroomCents,
        ticketCents: funding.sizing.ticketCents,
        halted: funding.sizing.halted,
        haltThresholdCents: funding.sizing.haltThresholdCents,
        haltReason: funding.sizing.reason,
        dailyLossCapCents: longShotDailyLossCapCents(funding.sizing.ticketCents, settings),
        report: buildLongShotReport({ orders: mine, mode, policyVersion: longShotPolicyVersion(settings) }),
      };
    });

    return NextResponse.json({
      policyVersion: longShotPolicyVersion(settings),
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
      allocation: { startingCents, funded: startingCents > 0 },
      tracks,
      // Approach (ii): the same triggers held to settlement, committed at trigger time so the sample is
      // not conditioned on having successfully bought.
      hold: sentinels,
      // Observation only. Peak-after-entry is a query rather than a stored field, so every candidate mark
      // stays evaluable from this one dataset.
      contractPaths: {
        windows: paths.length,
        samples: paths.reduce((total, path) => total + path.samples, 0),
        recent: paths.slice(0, 20),
      },
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    console.error('Long-shot report failed:', error);
    return NextResponse.json({ error: 'Long-shot report unavailable.' }, { status: 500 });
  }
}
