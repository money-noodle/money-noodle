import { NextResponse } from 'next/server';
import { isAuthenticatedRequest } from '@/lib/auth';
import { isStatelessDeployment, STATELESS_WORKER_MESSAGE } from '@/lib/runtime-environment';
import { getCyclePathReport, getCyclePaths } from '@/lib/cycle-path-store';
import { getContractProvenanceRegistry } from '@/lib/contract-provenance-store';
import { buildContractComparabilityReport } from '@/lib/contract-comparability';
import { getCalendarEvaluationReport } from '@/lib/calendar-evaluation-store';
import { buildAttributedTradeRecords, buildMakerFillReport, buildProviderTradeRecords, buildTradeRecord } from '@/lib/execution-report';
import { buildPositiveEdgeFundingReport } from '@/lib/performance-read-model';
import { evaluateStakeExpansion } from '@/lib/stake-expansion-policy';
import { buildMakerShadow } from '@/lib/maker-shadow';
import { evaluatePromotionEligibility } from '@/lib/model-promotion';
import { readPromotionLedger } from '@/lib/model-promotion-store';
import { getTradingControl } from '@/lib/trading-control';
import { getForecastHistory, getForecastStorageHealth, getPerformanceSummary } from '@/lib/forecast-tracker';
import { getExecutionOrders, getPaperBankrollFunding } from '@/lib/paper-execution';
import { getWalkForwardEvaluationHistory } from '@/lib/model-evaluation-store';
import {
  buildOrderAttributionFacets, orderMatchesAttribution, parseOrderAttributionFilters,
  unknownOrderAttributionFilters,
} from '@/lib/order-attribution';
import { getPersistenceCandidateReport } from '@/lib/persistence-candidate-store';
import { BUY_POLICY_VERSION } from '@/lib/prediction-policy';
import { getMakerRestrictionSentinelReport } from '@/lib/maker-restriction-sentinel-store';
import { getExitPolicySentinelReport } from '@/lib/exit-policy-sentinel-store';
import { buildBoundedTakerExperimentReport } from '@/lib/bounded-taker-experiment';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

let responseCache: { expiresAt: number; body: Record<string, unknown> } | undefined;

export async function GET(request: Request) {
  if (!isAuthenticatedRequest(request as import('next/server').NextRequest)) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  if (isStatelessDeployment()) return NextResponse.json({ error: STATELESS_WORKER_MESSAGE }, { status: 503 });
  try {
    let attributionFilters;
    try { attributionFilters = parseOrderAttributionFilters(new URL(request.url).searchParams); }
    catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : 'Invalid attribution filters.' }, { status: 400 });
    }
    const filteredRequest = Object.values(attributionFilters).some((values) => values.length > 0);
    if (!filteredRequest && responseCache && responseCache.expiresAt > Date.now()) {
      return NextResponse.json(responseCache.body, { headers: { 'Cache-Control': 'private, no-store' } });
    }
    const [forecasts, summary, orders, cyclePaths, cyclePathRecords, provenance, control, persistenceCandidate, calendarEvaluation] = await Promise.all([
      getForecastHistory(), getPerformanceSummary(), getExecutionOrders(), getCyclePathReport(), getCyclePaths(),
      getContractProvenanceRegistry(), getTradingControl(), getPersistenceCandidateReport(BUY_POLICY_VERSION),
      getCalendarEvaluationReport(BUY_POLICY_VERSION),
    ]);
    const paperFunding = await getPaperBankrollFunding();
    const funding = buildPositiveEdgeFundingReport(orders, control.control.epochId, paperFunding);
    const attributionFacets = buildOrderAttributionFacets(funding.edgeOrders);
    const unknownAttribution = unknownOrderAttributionFilters(attributionFilters, attributionFacets);
    if (unknownAttribution.length) {
      return NextResponse.json({ error: `Unknown attribution filter ${unknownAttribution[0].key}: ${unknownAttribution[0].value}.` }, { status: 400 });
    }
    const attributedOrders = funding.edgeOrders.filter((order) => orderMatchesAttribution(order, attributionFilters));
    const [makerRestrictionSentinel, exitPolicySentinel] = await Promise.all([
      getMakerRestrictionSentinelReport(funding.edgeOrders), getExitPolicySentinelReport(funding.edgeOrders),
    ]);
    // Whether the lifetime figures above were computed from complete shard statistics.
    const forecastStorage = await getForecastStorageHealth();
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
      paperRecord: buildTradeRecord(attributedOrders, 'paper'),
      liveRecord: buildTradeRecord(attributedOrders, 'live'),
      // Same positive-edge orders split per provider, so fills, unfilled maker attempts, and rejections stay separable.
      paperProviderRecords: buildProviderTradeRecords(attributedOrders, 'paper'),
      liveProviderRecords: buildProviderTradeRecords(attributedOrders, 'live'),
      paperAttributionRecords: buildAttributedTradeRecords(attributedOrders, 'paper'),
      liveAttributionRecords: buildAttributedTradeRecords(attributedOrders, 'live'),
      attribution: { filters: attributionFilters, facets: attributionFacets, matchedOrders: attributedOrders.length },
      // Per-funding results plus lifetime totals, all re-narrowed to the strategy this report names.
      liveEpochs: funding.liveEpochs,
      liveLifetimePnlCents: funding.liveLifetimePnlCents,
      // Paper applies its durable whole-cent corrections to the current funding only. Exact order P&L stays separate.
      paperEpochs: funding.paperEpochs,
      paperLifetimePnlCents: funding.paperLifetimePnlCents,
      paperFunding,
      // Evaluation only. Raising the cap stays a manual, audited act; this states whether the stated
      // criteria are met and what a qualifying expansion would be.
      stakeExpansion: evaluateStakeExpansion(control.control, funding.edgeOrders),
      // Observation only: what paper would have returned under maker execution instead of its
      // immediate-ask fill, separating price improvement from fill risk.
      paperMakerShadow: buildMakerShadow(funding.edgeOrders, 'paper'),
      // Promotion stays manual. This reports whether the newest run may be cited, and the immutable
      // record of what has actually been promoted or rolled back.
      promotionEligibility: evaluatePromotionEligibility(modelEvaluations.runs.at(-1)),
      promotionLedger,
      cyclePaths,
      forecastStorage,
      contractComparability: buildContractComparabilityReport(forecasts, cyclePathRecords, provenance.records),
      makerFillReport: buildMakerFillReport(attributedOrders, forecasts),
      // Prospective evaluation only. Both reports are track-separated and have no production mutation path.
      makerRestrictionSentinel,
      exitPolicySentinel,
      boundedTakerExperiment: buildBoundedTakerExperimentReport(attributedOrders),
      persistenceCandidate,
      calendarEvaluation,
      modelEvaluations,
    };
    if (!filteredRequest) responseCache = { expiresAt: Date.now() + 15_000, body };
    return NextResponse.json(body, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    console.error('Performance history failed:', error);
    return NextResponse.json({ error: 'Unable to read buy history.' }, { status: 500 });
  }
}
