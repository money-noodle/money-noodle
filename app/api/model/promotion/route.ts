import { NextRequest, NextResponse } from 'next/server';
import { isAuthenticatedRequest } from '@/lib/auth';
import { MODEL_VERSION } from '@/lib/dashboard';
import { getExecutionDrainStatus } from '@/lib/execution-drain-state';
import { getWalkForwardEvaluationHistory } from '@/lib/model-evaluation-store';
import {
  evaluatePromotionEligibility, promotionRefusal, PROMOTION_CONFIRMATION, ROLLBACK_CONFIRMATION,
  type PromotionRequest,
} from '@/lib/model-promotion';
import { readPromotionLedger, recordModelPromotion } from '@/lib/model-promotion-store';
import { isStatelessDeployment, STATELESS_WORKER_MESSAGE } from '@/lib/runtime-environment';
import { getTradingControl } from '@/lib/trading-control';
import { PRODUCTION_BASELINE_PARAMETERS } from '@/lib/walk-forward';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Manual model promotion and rollback.
 *
 * The evaluator cannot promote anything and this route does not change it: production parameters are
 * compile-time constants, so a promotion is recorded after a deploy, never instead of one. What the
 * route adds is the missing write path to the immutable ledger, behind the same guards as any other
 * real-money control — authenticated, same-origin, and only while execution is quiescent.
 */
async function state() {
  const [ledger, history] = await Promise.all([readPromotionLedger(), getWalkForwardEvaluationHistory()]);
  const latestRun = [...history.runs].sort((a, b) => a.generatedAt.localeCompare(b.generatedAt)).at(-1);
  return { ledger, latestRun, eligibility: evaluatePromotionEligibility(latestRun) };
}

const runningModel = { modelVersion: MODEL_VERSION, parameters: PRODUCTION_BASELINE_PARAMETERS };

export async function GET(request: NextRequest) {
  if (!isAuthenticatedRequest(request)) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  if (isStatelessDeployment()) return NextResponse.json({ error: STATELESS_WORKER_MESSAGE }, { status: 503 });
  try {
    const { ledger, latestRun, eligibility } = await state();
    return NextResponse.json({
      running: runningModel, ledger, eligibility, latestRunId: latestRun?.id,
      confirmations: { promoted: PROMOTION_CONFIRMATION, 'rolled-back': ROLLBACK_CONFIRMATION },
    }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    console.error('Promotion ledger read failed:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to read the promotion ledger.' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  if (!isAuthenticatedRequest(request)) return NextResponse.json({ error: 'Authentication required.' }, { status: 401 });
  if (isStatelessDeployment()) return NextResponse.json({ error: STATELESS_WORKER_MESSAGE }, { status: 503 });
  try {
    const origin = request.headers.get('origin');
    if (!origin || origin !== request.nextUrl.origin) return NextResponse.json({ error: 'Invalid request origin.' }, { status: 403 });

    const control = await getTradingControl();
    const drain = getExecutionDrainStatus();
    if (control.control.state === 'active') return NextResponse.json({ error: 'Pause automation before recording a model decision.' }, { status: 409 });
    if (!drain.restartSafe || drain.phase !== 'quiescent') return NextResponse.json({ error: 'Model promotion requires a quiescent, restart-safe execution drain.' }, { status: 409 });
    if (control.control.reservedBudgetCents > 0) return NextResponse.json({ error: 'Resolve open exposure before recording a model decision.' }, { status: 409 });

    const body = await request.json() as Partial<PromotionRequest>;
    const { ledger, latestRun, eligibility } = await state();
    const promotionRequest: PromotionRequest = {
      action: body.action!, modelVersion: body.modelVersion!, parameters: body.parameters!,
      reason: body.reason ?? '', confirmation: body.confirmation ?? '',
      evidenceRunId: body.evidenceRunId, supersedesId: body.supersedesId,
    };
    const refusal = promotionRefusal(promotionRequest, { running: runningModel, eligibility, latestRunId: latestRun?.id, ledger });
    if (refusal) return NextResponse.json({ error: refusal }, { status: 409 });

    const entry = await recordModelPromotion({
      action: promotionRequest.action, modelVersion: promotionRequest.modelVersion,
      parameters: promotionRequest.parameters, reason: promotionRequest.reason,
      run: promotionRequest.action === 'promoted' ? latestRun : undefined,
      supersedesId: promotionRequest.supersedesId,
    });
    return NextResponse.json({ entry, ledger: await readPromotionLedger() }, { status: 201 });
  } catch (error) {
    console.error('Model promotion failed:', error);
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Unable to record the model decision.' }, { status: 409 });
  }
}
