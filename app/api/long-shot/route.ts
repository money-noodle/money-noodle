import { NextResponse } from 'next/server';
import { isAuthenticatedRequest } from '@/lib/auth';
import { isStatelessDeployment } from '@/lib/runtime-environment';
import { buildLongShotPayload } from '@/lib/long-shot-projection';
import { readPublicLongShotFromPostgres } from '@/lib/postgres-paper-projection';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Read-only long-shot policy surface.
 *
 * On the persistent worker this is assembled from the live stores. On a stateless host it is served from
 * the replicated **paper-only** projection: a hosted deployment has no execution authority, no way to
 * reconcile a venue position, and no business reporting live money, so the live track is never published.
 *
 * Authenticated in both places. This is evaluation evidence for a policy still collecting its first sixty
 * attempts, not a published track record, and nothing here can arm, fund, size, or trade.
 */
export async function GET(request: Request) {
  if (!isAuthenticatedRequest(request as import('next/server').NextRequest)) {
    return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  }

  try {
    if (isStatelessDeployment()) {
      const projected = await readPublicLongShotFromPostgres();
      // An absent projection is reported as such rather than as an empty policy: "nothing replicated yet"
      // and "the policy has done nothing" look identical in a payload and mean very different things.
      if (!projected) {
        return NextResponse.json({
          error: 'The desk has not published a long-shot record yet.',
        }, { status: 503 });
      }
      return NextResponse.json(projected, { headers: { 'Cache-Control': 'private, no-store' } });
    }

    const payload = await buildLongShotPayload();
    return NextResponse.json(
      { durable: false, generatedAt: new Date().toISOString(), ...payload },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    console.error('Long-shot report failed:', error);
    return NextResponse.json({ error: 'Long-shot report unavailable.' }, { status: 500 });
  }
}
