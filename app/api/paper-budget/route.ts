import { NextResponse } from 'next/server';
import { getPublicPaperBudget } from '@/lib/paper-execution';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    return NextResponse.json(await getPublicPaperBudget(), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('Paper budget read failed:', error);
    return NextResponse.json({ error: 'Unable to read paper budget.' }, { status: 500 });
  }
}