import { NextRequest, NextResponse } from 'next/server';
import { isAuthenticatedRequest } from '@/lib/auth';
import { getDashboard, publicDashboardData } from '@/lib/dashboard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const refresh = request.nextUrl.searchParams.get('refresh');
    const force = refresh === '1' || refresh === 'live';
    const dashboard = await getDashboard(force, refresh === 'live');
    return NextResponse.json(isAuthenticatedRequest(request) ? dashboard : publicDashboardData(dashboard), {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    console.error(error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Unable to load market data' },
      { status: 503 },
    );
  }
}
