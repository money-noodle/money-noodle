import { NextResponse } from 'next/server';
import { getPublicPaperPerformanceSummary } from '@/lib/public-paper-performance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CACHE_CONTROL = 'public, max-age=30, s-maxage=60, stale-while-revalidate=300';
let responseCache: {
  expiresAt: number;
  body: NonNullable<Awaited<ReturnType<typeof getPublicPaperPerformanceSummary>>>;
} | undefined;

/** Bounded homepage counters. The complete analytical record remains an on-demand resource. */
export async function GET() {
  try {
    if (responseCache && responseCache.expiresAt > Date.now()) {
      return NextResponse.json(responseCache.body, { headers: { 'Cache-Control': CACHE_CONTROL } });
    }
    const body = await getPublicPaperPerformanceSummary();
    if (!body) return NextResponse.json({
      error: 'The paper track projection is unavailable. No empty record was inferred.',
    }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
    responseCache = { expiresAt: Date.now() + 60_000, body };
    return NextResponse.json(body, { headers: { 'Cache-Control': CACHE_CONTROL } });
  } catch (error) {
    console.error('Public paper performance summary read failed:', error);
    return NextResponse.json({ error: 'Unable to read the paper track summary.' }, {
      status: 500,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
}
