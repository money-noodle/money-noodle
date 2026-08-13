import { NextResponse } from 'next/server';
import { getPublicPaperPerformance } from '@/lib/public-paper-performance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Scoring the whole forecast log is the expensive part, so unauthenticated pollers share one result. */
let responseCache: { expiresAt: number; body: Awaited<ReturnType<typeof getPublicPaperPerformance>> } | undefined;

export async function GET() {
  try {
    if (responseCache && responseCache.expiresAt > Date.now()) {
      return NextResponse.json(responseCache.body, { headers: { 'Cache-Control': 'no-store' } });
    }
    const body = await getPublicPaperPerformance();
    responseCache = { expiresAt: Date.now() + 15_000, body };
    return NextResponse.json(body, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('Public paper performance read failed:', error);
    return NextResponse.json({ error: 'Unable to read the paper track record.' }, { status: 500 });
  }
}
