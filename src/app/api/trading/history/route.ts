import { NextRequest, NextResponse } from 'next/server';
import { isAuthenticatedRequest } from '@/lib/auth';
import { isStatelessDeployment, STATELESS_WORKER_MESSAGE } from '@/lib/runtime-environment';
import {
  buildOrderAttributionFacets, orderMatchesAttribution, parseOrderAttributionFilters,
  unknownOrderAttributionFilters,
} from '@/lib/order-attribution';
import { getExecutionOrders, groupedRecentOrders } from '@/lib/paper-execution';
import { EDGE_BINARY_BUY } from '@/lib/strategy-registry';
import type { PaperOrderStatus } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const openStatuses = new Set<PaperOrderStatus>(['pending_reservation', 'uncertain', 'open']);
const settledStatuses = new Set<PaperOrderStatus>(['sold', 'won', 'lost', 'invalid']);

export async function GET(request: NextRequest) {
  if (!isAuthenticatedRequest(request)) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  if (isStatelessDeployment()) return NextResponse.json({ error: STATELESS_WORKER_MESSAGE }, { status: 503 });
  try {
    const stateParam = request.nextUrl.searchParams.get('state');
    if (stateParam && !['open', 'settled', 'unfilled'].includes(stateParam)) {
      return NextResponse.json({ error: 'Invalid history state filter.' }, { status: 400 });
    }
    let filters;
    try { filters = parseOrderAttributionFilters(request.nextUrl.searchParams); }
    catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid attribution filters.' }, { status: 400 });
    }
    const limit = Math.min(100, Math.max(10, Number(request.nextUrl.searchParams.get('limit')) || 50));
    const offset = Math.max(0, Number(request.nextUrl.searchParams.get('offset')) || 0);
    const population = groupedRecentOrders(await getExecutionOrders({
      strategyId: EDGE_BINARY_BUY, includeArchivedEvidence: true,
    }));
    const facets = buildOrderAttributionFacets(population);
    const unknown = unknownOrderAttributionFilters(filters, facets);
    if (unknown.length) {
      return NextResponse.json({ error: `Unknown attribution filter ${unknown[0].key}: ${unknown[0].value}.` }, { status: 400 });
    }
    const grouped = population.filter((order) => {
      if (!orderMatchesAttribution(order, filters)) return false;
      if (stateParam === 'open' && !openStatuses.has(order.status)) return false;
      if (stateParam === 'settled' && !settledStatuses.has(order.status)) return false;
      if (stateParam === 'unfilled' && order.status !== 'unfilled' && order.status !== 'rejected') return false;
      return true;
    });
    return NextResponse.json({
      orders: grouped.slice(offset, offset + limit), total: grouped.length, offset, limit,
      hasMore: offset + limit < grouped.length, attribution: { filters, facets },
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    console.error('Trading history read failed:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to read trading history' }, { status: 500 });
  }
}
