import { NextResponse } from 'next/server';
import { isAuthenticatedRequest } from '@/lib/auth';
import { isStatelessDeployment } from '@/lib/runtime-environment';
import { buildLongShotPayload } from '@/lib/long-shot-projection';
import { readPublicLongShotFromPostgres } from '@/lib/postgres-paper-projection';
import { saveAnalysisBands } from '@/lib/analysis-bands-store';

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

/**
 * Saves the operator's analysis bands.
 *
 * The only write on this surface, and it writes **analysis** bands: hypotheses to screen recorded data
 * against. It cannot change an entry mark, a ticket, arming, or a budget, and no module that can price,
 * size, gate, or trade may read what it stores — `lib/analysis-bands.test.ts` asserts that boundary so it
 * fails the build rather than quietly moving money. AGENTS §5.5: screening may filter an idea and may
 * never promote one.
 *
 * A stateless host has no durable state to write and no authority to write it, so it refuses (§3).
 */
export async function POST(request: Request) {
  if (!isAuthenticatedRequest(request as import('next/server').NextRequest)) {
    return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  }
  if (isStatelessDeployment()) {
    return NextResponse.json({ error: 'This deployment does not hold durable state and cannot save bands.' }, { status: 403 });
  }

  let body: { bands?: unknown };
  try {
    body = await request.json() as { bands?: unknown };
  } catch {
    return NextResponse.json({ error: 'Expected a JSON body with a bands array.' }, { status: 400 });
  }

  const result = await saveAnalysisBands(body.bands);
  // A rejected band is reported rather than repaired: silently widening what an operator typed would
  // attribute results to a band they never defined.
  if ('error' in result) return NextResponse.json({ error: result.error }, { status: 400 });

  try {
    const payload = await buildLongShotPayload();
    return NextResponse.json(
      { durable: false, generatedAt: new Date().toISOString(), ...payload },
      { headers: { 'Cache-Control': 'private, no-store' } },
    );
  } catch (error) {
    console.error('Long-shot report failed after saving bands:', error);
    return NextResponse.json({ error: 'Bands were saved but the report could not be rebuilt.' }, { status: 500 });
  }
}
