import { NextResponse } from 'next/server';
import { getCyclePathReport } from '@/lib/cycle-path-store';
import { buildMakerFillReport, buildTradeRecord } from '@/lib/execution-report';
import { getForecastHistory, getPerformanceSummary } from '@/lib/forecast-tracker';
import { getExecutionOrders } from '@/lib/paper-execution';
import { getWalkForwardEvaluationHistory } from '@/lib/model-evaluation-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

let responseCache: { expiresAt: number; body: Record<string, unknown> } | undefined;

export async function GET() {
  try {
    if (responseCache && responseCache.expiresAt > Date.now()) {
      return NextResponse.json(responseCache.body, { headers: { 'Cache-Control': 'private, no-store' } });
    }
    const [forecasts, summary, orders, cyclePaths] = await Promise.all([
      getForecastHistory(), getPerformanceSummary(), getExecutionOrders(), getCyclePathReport(),
    ]);
    const modelEvaluations = await getWalkForwardEvaluationHistory(summary.calibrationWindows);
    // Signal quality comes from the calculation log; executed money comes from the order ledger, kept
    // separate per mode so a paper shadow can never be mistaken for a live result.
    const body = {
      summary,
      forecasts: forecasts.filter((forecast) => forecast.qualified !== false).slice(0, 500).map((forecast) => ({
        id: forecast.id, symbol: forecast.symbol, direction: forecast.direction,
        directionalLikelihood: forecast.directionalLikelihood, issuedAt: forecast.issuedAt,
        modelVersion: forecast.modelVersion, policyVersion: forecast.policyVersion,
        confidence: forecast.confidence, outcome: forecast.outcome,
        status: forecast.status, correct: forecast.correct,
      })),
      paperRecord: buildTradeRecord(orders, 'paper'),
      liveRecord: buildTradeRecord(orders, 'live'),
      cyclePaths,
      makerFillReport: buildMakerFillReport(orders, forecasts),
      modelEvaluations,
    };
    responseCache = { expiresAt: Date.now() + 15_000, body };
    return NextResponse.json(body, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    console.error('Performance history failed:', error);
    return NextResponse.json({ error: 'Unable to read buy history.' }, { status: 500 });
  }
}
