import { NextResponse, type NextRequest } from 'next/server';
import { isAuthenticatedRequest } from '@/lib/auth';
import { isStatelessDeployment, STATELESS_WORKER_MESSAGE } from '@/lib/runtime-environment';
import { getProviderBudgets, providerBudget, updateProviderBudget } from '@/lib/provider-budget-store';
import { allocationsValid } from '@/lib/provider-budget-policy';
import { MARKETS, isMarketId, providerFundedMarkets, providerMarketCapability } from '@/lib/market-registry';
import { TRADING_PROVIDER_IDS } from '@/lib/trading-provider-config-store';
import { getTradingControl } from '@/lib/trading-control';
import { getExecutionOrders } from '@/lib/paper-execution';
import type { MarketAllocation, TradingProviderId } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Budget allocation across providers and markets.
 *
 * Reads are shaped as a tree so the UI renders from the registries rather than hardcoding today's provider
 * or market. The former strategy sub-allocation layer retired with the long-shot strategy; legacy fields
 * remain parseable in durable history but this route neither returns nor writes them. A market-cap change
 * still requires quiescent execution. Nothing here can arm, resume, or place an order.
 */
async function blockers(): Promise<string[]> {
  const control = await getTradingControl();
  const orders = await getExecutionOrders({ includeArchivedEvidence: false });
  const open = orders.filter((order) => order.executionMode === 'live'
    && ['open', 'pending_reservation', 'uncertain'].includes(order.status));
  const found: string[] = [];
  if (control.control.state === 'active') found.push('Automation is active. Pause and drain before changing an allocation.');
  if (control.control.reservedBudgetCents > 0) found.push(`${control.control.reservedBudgetCents}¢ is still reserved.`);
  if (open.length) found.push(`${open.length} live position(s) are still open or uncertain.`);
  if (!control.executionDrain?.restartSafe) found.push('Execution is not yet quiescent and restart-safe.');
  return found;
}

export async function GET(request: NextRequest) {
  if (!isAuthenticatedRequest(request)) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  if (isStatelessDeployment()) return NextResponse.json({ error: STATELESS_WORKER_MESSAGE }, { status: 503 });
  try {
    const [budgets, control] = await Promise.all([getProviderBudgets(), getTradingControl()]);
    // The whole configured budget sits behind the one provider that can trade today. Reported explicitly
    // rather than assumed, so a second funded provider changes data instead of code.
    const providerEquityCents = control.control.startingBudgetCents;

    return NextResponse.json({
      blockers: await blockers(),
      providerEquityCents,
      providers: TRADING_PROVIDER_IDS.map((providerId: TradingProviderId) => {
        const budget = providerBudget(budgets, providerId);
        const capable = control.tradingProviders?.find((item) => item.id === providerId);
        return {
          providerId,
          liveCapable: Boolean(capable?.liveEnabled),
          paperCapable: Boolean(capable?.paperEnabled),
          liveLimitCents: budget?.liveLimitCents ?? 0,
          markets: providerFundedMarkets(providerId).map((market) => {
            const allocation = budget?.allocations.find((item) => item.marketId === market.id);
            const percent = allocation?.percent ?? 0;
            const capCents = Math.floor(providerEquityCents * percent / 100);
            return { marketId: market.id, name: market.name, percent, capCents };
          }),
        };
      }),
      revision: budgets.revision,
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    console.error('Allocation read failed:', error);
    return NextResponse.json({ error: 'Allocations unavailable.' }, { status: 500 });
  }
}

interface AllocationPatch {
  providerId?: string;
  marketId?: string;
  /** Market share of the provider. Omit to leave unchanged. */
  marketPercent?: number;
}

export async function PATCH(request: NextRequest) {
  if (!isAuthenticatedRequest(request)) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  // Same-origin, matching the model-promotion write path: a budget change is a real-money control.
  const origin = request.headers.get('origin');
  if (!origin || origin !== request.nextUrl.origin) return NextResponse.json({ error: 'Invalid request origin.' }, { status: 403 });
  if (isStatelessDeployment()) return NextResponse.json({ error: STATELESS_WORKER_MESSAGE }, { status: 503 });

  try {
    const found = await blockers();
    if (found.length) return NextResponse.json({ error: found.join(' ') }, { status: 409 });

    const body = await request.json() as AllocationPatch;
    if (!body.providerId || !TRADING_PROVIDER_IDS.includes(body.providerId as TradingProviderId)) {
      return NextResponse.json({ error: 'Unknown provider.' }, { status: 400 });
    }
    if (!isMarketId(body.marketId)) return NextResponse.json({ error: 'Unknown market.' }, { status: 400 });
    const providerId = body.providerId as TradingProviderId;
    const marketId = body.marketId;
    if (providerMarketCapability(providerId, marketId)?.live !== true) {
      return NextResponse.json({ error: `${providerId} ${marketId} has no funded allocation capability.` }, { status: 400 });
    }
    const budgets = await getProviderBudgets();
    const existing = providerBudget(budgets, providerId);
    if (!existing) return NextResponse.json({ error: `No ${providerId} budget to allocate.` }, { status: 400 });

    const current = existing.allocations.find((item) => item.marketId === marketId);
    const marketPercent = body.marketPercent ?? current?.percent ?? 0;

    const allocations: MarketAllocation[] = MARKETS
      .map((market) => market.id === marketId
        ? { marketId, percent: marketPercent }
        : existing.allocations.find((item) => item.marketId === market.id))
      .filter((item): item is MarketAllocation => Boolean(item));

    if (!allocationsValid(allocations)) {
      return NextResponse.json({ error: 'Market allocations must be non-negative and sum to at most 100%.' }, { status: 400 });
    }

    const next = await updateProviderBudget(providerId, { allocations });
    return NextResponse.json({
      revision: next.revision,
      allocations: providerBudget(next, providerId)?.allocations ?? [],
    });
  } catch (error) {
    console.error('Allocation write failed:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Allocation update failed.' }, { status: 400 });
  }
}
