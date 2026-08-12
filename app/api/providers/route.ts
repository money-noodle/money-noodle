import { NextRequest, NextResponse } from 'next/server';
import { isAuthenticatedRequest } from '@/lib/auth';
import { listProviders, updateProvider } from '@/lib/llm';
import { isStatelessDeployment, STATELESS_WORKER_MESSAGE } from '@/lib/runtime-environment';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  if (!isAuthenticatedRequest(request)) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  if (isStatelessDeployment()) return NextResponse.json({ error: STATELESS_WORKER_MESSAGE }, { status: 503 });
  return NextResponse.json(await listProviders(), { headers: { 'Cache-Control': 'private, no-store' } });
}

export async function PATCH(request: NextRequest) {
  if (!isAuthenticatedRequest(request)) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  if (isStatelessDeployment()) return NextResponse.json({ error: STATELESS_WORKER_MESSAGE }, { status: 503 });
  try {
    const body = await request.json() as { providerId?: string; enabled?: boolean; current?: boolean; model?: string };
    if (!body.providerId) return NextResponse.json({ error: 'Select an LLM provider.' }, { status: 400 });
    return NextResponse.json(await updateProvider({ providerId: body.providerId, enabled: body.enabled, current: body.current, model: body.model }));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to update LLM provider.' }, { status: 400 });
  }
}
