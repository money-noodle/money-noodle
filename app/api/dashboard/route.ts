import { NextRequest, NextResponse } from 'next/server';
import { getDashboard } from '@/lib/dashboard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const refresh = request.nextUrl.searchParams.get('refresh');
    const force = refresh === '1' || refresh === 'live';
    return NextResponse.json(await getDashboard(force, refresh === 'live'), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to load market data' },
      { status: 503 },
    );
  }
}
