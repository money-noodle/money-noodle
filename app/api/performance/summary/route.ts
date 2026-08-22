import { NextResponse } from 'next/server';
import { isAuthenticatedRequest } from '@/lib/auth';
import { buildTradeTrackSummary } from '@/lib/execution-report';
import { getExecutionOrders } from '@/lib/paper-execution';
import { isStatelessDeployment, STATELESS_WORKER_MESSAGE } from '@/lib/runtime-environment';
import { EDGE_BINARY_BUY } from '@/lib/strategy-registry';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Signed polling surface: execution totals only, with no forecast-history or analytical-report read. */
export async function GET(request: Request) {
  if (!isAuthenticatedRequest(request as import('next/server').NextRequest)) {
    return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  }
  if (isStatelessDeployment()) {
    return NextResponse.json({ error: STATELESS_WORKER_MESSAGE }, { status: 503 });
  }
  try {
    const orders = await getExecutionOrders({ strategyId: EDGE_BINARY_BUY });
    return NextResponse.json({
      paperRecord: buildTradeTrackSummary(orders, 'paper'),
      liveRecord: buildTradeTrackSummary(orders, 'live'),
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    console.error('Performance summary failed:', error);
    return NextResponse.json({ error: 'Unable to read the execution track summary.' }, { status: 500 });
  }
}
