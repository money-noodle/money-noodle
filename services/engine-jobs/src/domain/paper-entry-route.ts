// Historical route rule only. Live-cohort reporting seam removed, not gated.
export const ENTRY_EXECUTION_POLICY_VERSION = 'maker-then-positive-edge-taker2-terminal-refusal-v9';

export const HIGH_EDGE_TAKER_THRESHOLD = 0.3;

export const MAX_ENTRY_EPISODES_PER_WINDOW = 3;
export type EntryExecutionMode = 'maker' | 'adaptive' | 'taker';
export type EntryExecutionStyle = 'maker' | 'taker';

export interface MakerCohortEvidence {
  label: string;
  accepted: number;
  fills: number;
  fillRate: number | null;
}

export interface EntryExecutionPolicyInput {
  mode: EntryExecutionMode;
  currentNetEdge: number;
  medianNetEdge: number;
  confidence: number;
  spread: number;
  makerNetEdge: number;

  minimumMedianNetEdge: number;
  minimumConfidence: number;
  maximumSpread: number;

  makerMissFallback?: boolean;
  fallbackFromOrderId?: string | undefined;
}

export interface EntryExecutionDecision {
  policyVersion: typeof ENTRY_EXECUTION_POLICY_VERSION;
  configuredMode: EntryExecutionMode;
  executedStyle: EntryExecutionStyle;
  recommendedStyle: EntryExecutionStyle;
  route:
    'ordinary-maker' | 'high-edge-taker' | 'maker-miss-taker-fallback' | 'bounded-taker-experiment';
  reason: string;
  takerNetEdge: number;
  medianNetEdge: number;
  makerNetEdge: number;
  makerExpectedCapturedEdge: number | null;
  takerAdvantage: number | null;
  makerCohort: string;
  makerSamples: number;
  makerFillRate: number | null;
  makerMissFallback: boolean;
  fallbackFromOrderId?: string | undefined;
}

export function adaptiveContinuationRefusal(
  requiresTaker: boolean,
  decision: Pick<EntryExecutionDecision, 'configuredMode' | 'executedStyle' | 'route' | 'reason'>,
): string | undefined {
  if (!requiresTaker) return undefined;
  if (
    decision.configuredMode === 'adaptive' &&
    decision.executedStyle === 'taker' &&
    decision.route === 'maker-miss-taker-fallback'
  )
    return undefined;
  return decision.reason || 'Adaptive continuation did not authorize the required taker IOC.';
}

export function evaluateEntryExecutionPolicy(
  input: EntryExecutionPolicyInput,
): EntryExecutionDecision {
  if (
    !['maker', 'adaptive', 'taker'].includes(input.mode) ||
    ![
      input.currentNetEdge,
      input.medianNetEdge,
      input.confidence,
      input.spread,
      input.makerNetEdge,
      input.minimumMedianNetEdge,
      input.minimumConfidence,
      input.maximumSpread,
    ].every(Number.isFinite)
  )
    throw new Error('Invalid paper entry policy inputs.');
  const fillRate = null as number | null;
  const makerExpectedCapturedEdge =
    fillRate === null ? null : Math.max(0, input.makerNetEdge) * fillRate;
  const takerAdvantage =
    makerExpectedCapturedEdge === null ? null : input.currentNetEdge - makerExpectedCapturedEdge;
  const failures: string[] = [];
  if (input.makerMissFallback) {
    if (!(input.currentNetEdge > 1e-12))
      failures.push(
        `fresh taker edge ${(input.currentNetEdge * 100).toFixed(1)}pp is not positive`,
      );
    if (input.confidence + 1e-12 < input.minimumConfidence)
      failures.push(
        `quality ${(input.confidence * 100).toFixed(1)}% < ${(input.minimumConfidence * 100).toFixed(1)}%`,
      );
    if (input.spread > input.maximumSpread + 1e-12)
      failures.push(
        `spread ${(input.spread * 100).toFixed(1)}c > ${(input.maximumSpread * 100).toFixed(1)}c`,
      );
  }
  const recommendedStyle: EntryExecutionStyle =
    input.makerMissFallback && !failures.length ? 'taker' : 'maker';
  const executedStyle: EntryExecutionStyle = input.mode === 'maker' ? 'maker' : recommendedStyle;
  const route = recommendedStyle === 'taker' ? 'maker-miss-taker-fallback' : 'ordinary-maker';
  const reason =
    recommendedStyle === 'taker'
      ? `Authoritative zero-spend predecessor permits one bounded fresh-quote IOC.${input.mode === 'maker' ? ' Shadow only; paper maker mode remains unchanged.' : ''}`
      : input.makerMissFallback
        ? `Taker fallback withheld: ${failures.join('; ')}.`
        : 'First intent uses the managed maker route.';
  return {
    policyVersion: ENTRY_EXECUTION_POLICY_VERSION,
    configuredMode: input.mode,
    executedStyle,
    recommendedStyle,
    route,
    reason,
    takerNetEdge: input.currentNetEdge,
    medianNetEdge: input.medianNetEdge,
    makerNetEdge: input.makerNetEdge,
    makerExpectedCapturedEdge,
    takerAdvantage,
    makerCohort: 'unavailable-no-live-cohort',
    makerSamples: 0,
    makerFillRate: fillRate,
    makerMissFallback: Boolean(input.makerMissFallback),
    fallbackFromOrderId: input.fallbackFromOrderId,
  };
}
