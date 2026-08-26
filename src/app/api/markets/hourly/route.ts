import { NextResponse } from 'next/server';
import { getHourlyThresholdMarkets } from '@/lib/hourly-threshold-market-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const body = await getHourlyThresholdMarkets();
    return NextResponse.json(body, {
      headers: { 'Cache-Control': 'public, max-age=30, s-maxage=60, stale-while-revalidate=300' },
    });
  } catch (error) {
    console.error('Hourly threshold market read failed:', error);
    return NextResponse.json({ error: 'Hourly threshold market data is unavailable.' }, {
      status: 503, headers: { 'Cache-Control': 'no-store' },
    });
  }
}
