import { NextResponse } from 'next/server';
import { getPublicPaperBudget } from '@/lib/paper-execution';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const budget = await getPublicPaperBudget();
    if (!budget) return NextResponse.json({
      error: 'The paper budget projection is unavailable. No zero balance was inferred.',
    }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    return NextResponse.json(budget, {
      headers: { 'Cache-Control': 'public, max-age=5, s-maxage=15, stale-while-revalidate=30' },
    });
  } catch (error) {
    console.error('Paper budget read failed:', error);
    return NextResponse.json({ error: 'Unable to read paper budget.' }, { status: 500 });
  }
}