import { NextRequest, NextResponse } from 'next/server';
import { configureTradingBudget, getTradingControl, resumeTrading, setEnabledTradingVenues, setTradingMode } from '@/lib/trading-control';
import { getExecutionSummaries, pauseAndDrainLiveExecution, reconcileLiveExecution, resetPaperBudget } from '@/lib/paper-execution';
import type { TradingControlData } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function withExecution(data: Promise<TradingControlData>): Promise<TradingControlData> {
  const control = await data;
  return {
    ...control,
    ...await getExecutionSummaries({
      state: control.control.state, mode: control.control.mode,
      startingBudgetCents: control.control.startingBudgetCents,
      workingEquityCents: control.workingEquityCents,
      availableBudgetCents: control.control.availableBudgetCents,
      reservedBudgetCents: control.control.reservedBudgetCents,
      proposedStakeCents: control.proposedStakeCents,
      perTradeCents: control.control.perTradeCents,
    }),
  };
}

export async function GET() {
  try {
    return NextResponse.json(await withExecution(getTradingControl()), { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    console.error('Trading control read failed:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to read trading control' }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const origin = request.headers.get('origin');
    if (!origin || origin !== request.nextUrl.origin) return NextResponse.json({ error: 'Invalid request origin.' }, { status: 403 });
    const body = await request.json() as { action?: string; budgetDollars?: number; perTradeDollars?: number; enabledVenues?: Array<'polymarket' | 'kalshi'>; mode?: 'paper' | 'live'; confirmation?: string; paperBankrollDollars?: number };
    if (body.action === 'configure') {
      return NextResponse.json(await withExecution(configureTradingBudget({ budgetDollars: Number(body.budgetDollars), perTradeDollars: Number(body.perTradeDollars), enabledVenues: body.enabledVenues ?? [] })));
    }
    if (body.action === 'venues') return NextResponse.json(await withExecution(setEnabledTradingVenues(body.enabledVenues ?? [])));
    if (body.action === 'mode') return NextResponse.json(await withExecution(setTradingMode(body.mode === 'live' ? 'live' : 'paper', body.confirmation)));
    if (body.action === 'paper-reset') {
      await resetPaperBudget(Math.round(Number(body.paperBankrollDollars) * 100));
      return NextResponse.json(await withExecution(getTradingControl()));
    }
    if (body.action === 'pause') {
      await pauseAndDrainLiveExecution('Paused by user · paper shadow continues');
      return NextResponse.json(await withExecution(getTradingControl()));
    }
    if (body.action === 'reconcile') {
      await reconcileLiveExecution({ trigger: 'manual' });
      return NextResponse.json(await withExecution(getTradingControl()));
    }
    if (body.action === 'resume') return NextResponse.json(await withExecution(resumeTrading()));
    return NextResponse.json({ error: 'Unknown trading-control action.' }, { status: 400 });
  } catch (error) {
    console.error('Trading control update failed:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Trading control update failed' }, { status: 409 });
  }
}
