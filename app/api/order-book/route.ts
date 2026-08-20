import { NextRequest, NextResponse } from 'next/server';
import { isAuthenticatedRequest } from '@/lib/auth';
import { readKalshiOrderBookNow } from '@/lib/kalshi-depth';
import { selectedSideOrderBook } from '@/lib/order-book-depth';
import { isStatelessDeployment, STATELESS_WORKER_MESSAGE } from '@/lib/runtime-environment';
import type { PositionSide } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TICKER = /^KX[A-Z0-9-]{3,80}$/;

/** Authenticated observation-only depth read. It never touches the signed API or execution depth cache. */
export async function GET(request: NextRequest) {
  if (!isAuthenticatedRequest(request)) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  if (isStatelessDeployment()) return NextResponse.json({ error: STATELESS_WORKER_MESSAGE }, { status: 503 });

  const ticker = request.nextUrl.searchParams.get('ticker')?.toUpperCase() ?? '';
  const rawSide = request.nextUrl.searchParams.get('side');
  if (!TICKER.test(ticker) || (rawSide !== 'UP' && rawSide !== 'DOWN')) {
    return NextResponse.json({ error: 'A valid Kalshi ticker and UP/DOWN side are required.' }, { status: 400 });
  }

  try {
    const book = await readKalshiOrderBookNow(ticker);
    if (!book) return NextResponse.json({ error: 'Kalshi returned no displayed depth.' }, { status: 503 });
    const ladder = selectedSideOrderBook(book, rawSide as PositionSide, 10);
    if (ladder.bids[0] && ladder.asks[0] && ladder.bids[0].price >= ladder.asks[0].price - 1e-9) {
      return NextResponse.json({ error: 'Kalshi returned a crossed selected-side book.' }, { status: 503 });
    }
    return NextResponse.json({ ticker, ...ladder }, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    console.error(`Order-book monitor failed for ${ticker}:`, error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to read Kalshi order-book depth.' }, { status: 503 });
  }
}
