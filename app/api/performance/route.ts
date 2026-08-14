import { NextResponse } from 'next/server';
import { isAuthenticatedRequest } from '@/lib/auth';
import { isStatelessDeployment, STATELESS_WORKER_MESSAGE } from '@/lib/runtime-environment';
import { getCyclePathReport } from '@/lib/cycle-path-store';
import { buildMakerFillReport, buildProviderTradeRecords, buildTradeRecord } from '@/lib/execution-report';
import { epochResults, lifetimeRealizedPnlCents } from '@/lib/budget-epoch';
import { evaluateStakeExpansion } from '@/lib/stake-expansion-policy';
import { buildMakerShadow } from '@/lib/maker-shadow';
import { evaluatePromotionEligibility } from '@/lib/model-promotion';
import { readPromotionLedger } from '@/lib/model-promotion-store';
import { getTradingControl } from '@/lib/trading-control';
import { getForecastHistory, getPerformanceSummary } from '@/lib/forecast-tracker';
import { getExecutionOrders } from '@/lib/paper-execution';
import { getWalkForwardEvaluationHistory } from '@/lib/model-evaluation-store';
import { getPersistenceCandidateReport } from '@/lib/persistence-candidate-store';
import { BUY_POLICY_VERSION } from '@/lib/prediction-policy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

let responseCache: { expiresAt: number; body: Record<string, unknown> } | undefined;

export async function GET(request: Request) {
  if (!isAuthenticatedRequest(request as import('next/server').NextRequest)) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  if (isStatelessDeployment()) return NextResponse.json({ error: STATELESS_WORKER_MESSAGE }, { status: 503 });
  try {
    if (responseCache && responseCache.expiresAt > Date.now()) {
      return NextResponse.json(responseCache.body, { headers: { 'Cache-Control': 'private, no-store' } });
    }
    const [forecasts, summary, orders, cyclePaths, control, persistenceCandidate] = await Promise.all([
      getForecastHistory(), getPerformanceSummary(), getExecutionOrders(), getCyclePathReport(), getTradingControl(),
      getPersistenceCandidateReport(BUY_POLICY_VERSION),
    ]);
    const modelEvaluations = await getWalkForwardEvaluationHistory(summary.calibrationWindows);
    const promotionLedger = await readPromotionLedger();
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
      // Same orders split per provider, so fills, unfilled maker attempts, and rejections stay separable.
      paperProviderRecords: buildProviderTradeRecords(orders, 'paper'),
      liveProviderRecords: buildProviderTradeRecords(orders, 'live'),
      // Per-epoch results plus a lifetime total, so reconfiguring the budget restarts current-epoch P&L
      // without erasing what earlier epochs actually did.
      liveEpochs: epochResults(orders, 'live', control.control.epochId),
      liveLifetimePnlCents: lifetimeRealizedPnlCents(orders, 'live'),
      // Evaluation only. Raising the cap stays a manual, audited act; this states whether the stated
      // criteria are met and what a qualifying expansion would be.
      stakeExpansion: evaluateStakeExpansion(control.control, orders),
      // Observation only: what paper would have returned under maker execution instead of its
      // immediate-ask fill, separating price improvement from fill risk.
      paperMakerShadow: buildMakerShadow(orders, 'paper'),
      // Promotion stays manual. This reports whether the newest run may be cited, and the immutable
      // record of what has actually been promoted or rolled back.
      promotionEligibility: evaluatePromotionEligibility(modelEvaluations.runs.at(-1)),
      promotionLedger,
      cyclePaths,
      makerFillReport: buildMakerFillReport(orders, forecasts),
      persistenceCandidate,
      modelEvaluations,
    };
    responseCache = { expiresAt: Date.now() + 15_000, body };
    return NextResponse.json(body, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    console.error('Performance history failed:', error);
    return NextResponse.json({ error: 'Unable to read buy history.' }, { status: 500 });
  }
}
