import { NextRequest, NextResponse } from 'next/server';
import { listProviders, updateProvider } from '@/lib/llm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(await listProviders(), { headers: { 'Cache-Control': 'no-store' } });
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json() as { providerId?: string; enabled?: boolean; current?: boolean; model?: string };
    if (!body.providerId) return NextResponse.json({ error: 'Select an LLM provider.' }, { status: 400 });
    return NextResponse.json(await updateProvider({ providerId: body.providerId, enabled: body.enabled, current: body.current, model: body.model }));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to update LLM provider.' }, { status: 400 });
  }
}
