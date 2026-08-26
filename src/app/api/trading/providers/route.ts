import { NextRequest, NextResponse } from 'next/server';
import { isAuthenticatedRequest } from '@/lib/auth';
import { isStatelessDeployment, STATELESS_WORKER_MESSAGE } from '@/lib/runtime-environment';
import { getExecutionDrainStatus } from '@/lib/execution-drain-state';
import { getEnabledTradingVenues, getTradingControl, syncLegacyVenuesFromProviderRegistry } from '@/lib/trading-control';
import {
  getTradingProviderConfiguration, legacyEnabledVenues, updateTradingProviderConfiguration,
} from '@/lib/trading-provider-config-store';
import { tradingProviderRegistry } from '@/lib/trading-provider-registry';
import type { TradingProviderId } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function response() {
  const enabledVenues = await getEnabledTradingVenues();
  const configuration = await getTradingProviderConfiguration(enabledVenues);
  return { configuration, providers: tradingProviderRegistry(configuration) };
}

/** Trading-provider registry. LLM providers remain under /api/providers. */
export async function GET(request: NextRequest) {
  if (!isAuthenticatedRequest(request)) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  if (isStatelessDeployment()) return NextResponse.json({ error: STATELESS_WORKER_MESSAGE }, { status: 503 });
  try {
    return NextResponse.json(await response(), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    console.error('Trading-provider registry read failed:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to read trading providers.' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  if (!isAuthenticatedRequest(request)) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  if (isStatelessDeployment()) return NextResponse.json({ error: STATELESS_WORKER_MESSAGE }, { status: 503 });
  try {
    const origin = request.headers.get('origin');
    if (!origin || origin !== request.nextUrl.origin) return NextResponse.json({ error: 'Invalid request origin.' }, { status: 403 });
    const body = await request.json() as {
      providerId?: TradingProviderId; researchEnabled?: boolean; paperEnabled?: boolean; liveEnabled?: boolean;
      selectedVariantId?: string; confirmation?: string; reason?: string;
    };
    const control = await getTradingControl();
    const drain = getExecutionDrainStatus();
    if (control.control.state === 'active') return NextResponse.json({ error: 'Pause automation before changing trading providers.' }, { status: 409 });
    if (!drain.restartSafe || drain.phase !== 'quiescent') return NextResponse.json({ error: 'Trading-provider changes require a quiescent, restart-safe execution drain.' }, { status: 409 });
    if (body.selectedVariantId !== undefined && control.control.reservedBudgetCents > 0) return NextResponse.json({ error: 'Resolve open exposure before changing a provider variant.' }, { status: 409 });
    if (!body.providerId) return NextResponse.json({ error: 'Select a trading provider.' }, { status: 400 });
    if (body.liveEnabled === true && body.confirmation !== `ENABLE LIVE ${body.providerId.toUpperCase()}`) {
      return NextResponse.json({ error: `Type ENABLE LIVE ${body.providerId.toUpperCase()} exactly to enable real-money execution.` }, { status: 400 });
    }
    const current = await getTradingProviderConfiguration(control.control.enabledVenues);
    const updated = await updateTradingProviderConfiguration({
      providerId: body.providerId,
      researchEnabled: body.researchEnabled,
      paperEnabled: body.paperEnabled,
      liveEnabled: body.liveEnabled,
      selectedVariantId: body.selectedVariantId,
      reason: body.reason ?? 'Provider configuration updated from the operator UI.',
    }, legacyEnabledVenues(current));
    await syncLegacyVenuesFromProviderRegistry(legacyEnabledVenues(updated));
    return NextResponse.json({ configuration: updated, providers: tradingProviderRegistry(updated) });
  } catch (error) {
    console.error('Trading-provider update failed:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to update trading provider.' }, { status: 409 });
  }
}
