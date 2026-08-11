import { NextResponse } from 'next/server';
import { getCyclePathReport } from '@/lib/cycle-path-store';
import { buildMakerFillReport, buildTradeRecord } from '@/lib/execution-report';
import { getForecastHistory } from '@/lib/forecast-tracker';
import { getExecutionOrders } from '@/lib/paper-execution';
import { summarizePerformance } from '@/lib/performance';
import { getWalkForwardEvaluationHistory } from '@/lib/model-evaluation-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const [forecasts, orders, cyclePaths] = await Promise.all([getForecastHistory(), getExecutionOrders(), getCyclePathReport()]);
    const summary = summarizePerformance(forecasts);
    const modelEvaluations = await getWalkForwardEvaluationHistory(summary.calibrationWindows);
    // Signal quality comes from the calculation log; executed money comes from the order ledger, kept
    // separate per mode so a paper shadow can never be mistaken for a live result.
    return NextResponse.json({
      summary,
      forecasts: forecasts.filter((forecast) => forecast.qualified !== false).slice(0, 500),
      paperRecord: buildTradeRecord(orders, 'paper'),
      liveRecord: buildTradeRecord(orders, 'live'),
      cyclePaths,
      makerFillReport: buildMakerFillReport(orders, forecasts),
      modelEvaluations,
    }, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    console.error('Performance history failed:', error);
    return NextResponse.json({ error: 'Unable to read buy history.' }, { status: 500 });
  }
}
