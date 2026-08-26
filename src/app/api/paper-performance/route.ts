import { NextResponse } from 'next/server';
import { getPublicPaperPerformance } from '@/lib/public-paper-performance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Scoring the whole forecast log is the expensive part, so on-demand readers share one result. */
let responseCache: { expiresAt: number; body: NonNullable<Awaited<ReturnType<typeof getPublicPaperPerformance>>> } | undefined;
const CACHE_CONTROL = 'public, max-age=60, s-maxage=60, stale-while-revalidate=300';

export async function GET() {
  try {
    if (responseCache && responseCache.expiresAt > Date.now()) {
      return NextResponse.json(responseCache.body, { headers: { 'Cache-Control': CACHE_CONTROL } });
    }
    const body = await getPublicPaperPerformance();
    if (!body) return NextResponse.json({
      error: 'The paper track projection is unavailable. No empty record was inferred.',
    }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    responseCache = { expiresAt: Date.now() + 60_000, body };
    return NextResponse.json(body, { headers: { 'Cache-Control': CACHE_CONTROL } });
  } catch (error) {
    console.error('Public paper performance read failed:', error);
    return NextResponse.json({ error: 'Unable to read the paper track record.' }, { status: 500 });
  }
}
