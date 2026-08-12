import { NextRequest, NextResponse } from 'next/server';
import { isAuthenticatedRequest } from '@/lib/auth';
import { isStatelessDeployment, STATELESS_WORKER_MESSAGE } from '@/lib/runtime-environment';
import { getExecutionOrders, groupedRecentOrders } from '@/lib/paper-execution';
import type { ExecutionMode, PaperOrderStatus } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const openStatuses = new Set<PaperOrderStatus>(['pending_reservation', 'uncertain', 'open']);
const settledStatuses = new Set<PaperOrderStatus>(['sold', 'won', 'lost', 'invalid']);

export async function GET(request: NextRequest) {
  if (!isAuthenticatedRequest(request)) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  if (isStatelessDeployment()) return NextResponse.json({ error: STATELESS_WORKER_MESSAGE }, { status: 503 });
  try {
    const modeParam = request.nextUrl.searchParams.get('mode');
    const stateParam = request.nextUrl.searchParams.get('state');
    const mode: ExecutionMode | null = modeParam === 'live' || modeParam === 'paper' ? modeParam : null;
    const limit = Math.min(100, Math.max(10, Number(request.nextUrl.searchParams.get('limit')) || 50));
    const offset = Math.max(0, Number(request.nextUrl.searchParams.get('offset')) || 0);
    const grouped = groupedRecentOrders(await getExecutionOrders()).filter((order) => {
      if (mode && order.executionMode !== mode) return false;
      if (stateParam === 'open' && !openStatuses.has(order.status)) return false;
      if (stateParam === 'settled' && !settledStatuses.has(order.status)) return false;
      if (stateParam === 'unfilled' && order.status !== 'unfilled' && order.status !== 'rejected') return false;
      return true;
    });
    return NextResponse.json({
      orders: grouped.slice(offset, offset + limit),
      total: grouped.length,
      offset,
      limit,
      hasMore: offset + limit < grouped.length,
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    console.error('Trading history read failed:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to read trading history' }, { status: 500 });
  }
}
