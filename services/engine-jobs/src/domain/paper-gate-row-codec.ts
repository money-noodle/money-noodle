// Unwired row representation/association ONLY: IDs/FKs are not authentic receipts,
// completeness, genuine initialization, source qualification or current authority.
import { decodePaperDbMicroseconds, paperDbTimeToSourceIso } from './paper-time-codec.js';
import { decodePaperSourceBinary64 } from './paper-decimal-codec.js';
import {
  PAPER_REGIME_SAMPLE_BUY_POLICY,
  PAPER_REGIME_EVIDENCE_CONTRACT,
  type RegimeGateObservation,
} from './paper-regime.js';
export interface PaperGateRowScope {
  generation_key: string;
  funding_id: string;
  epoch: number;
  budget_id: string;
  generation_config_intent_id: string;
  sample_policy: typeof PAPER_REGIME_SAMPLE_BUY_POLICY;
}
const namespace = [
  'generation_key',
  'funding_id',
  'epoch',
  'budget_id',
  'generation_config_intent_id',
  'sample_policy',
] as const;
const candidateKeys = [
  ...namespace,
  'candidate_key',
  'candidate_id',
  'issuance_run_id',
  'source_kind',
  'symbol',
  'venue',
  'contract_id',
  'side',
  'created_at_us',
  'closes_at_us',
  'selected_side_probability',
  'ask_price',
  'estimated_fee_rate',
  'fee_model_version',
  'predicted_net_edge',
  'evidence_version',
  'qualification_receipt_id',
];
const outcomeKeys = [
  ...namespace,
  'outcome_key',
  'candidate_key',
  'closes_at_us',
  'contract_id',
  'side',
  'resolution_run_id',
  'current_effect_config_intent_id',
  'source_kind',
  'evidence_version',
  'resolution_receipt_id',
  'winner',
  'realized_edge',
  'resolved_at_us',
  'recorded_at_us',
];
const id = (v: unknown, max = 120): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max && v.trim() === v;
function record(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  return Object.keys(r).length === keys.length && keys.every((k) => Object.hasOwn(r, k))
    ? r
    : undefined;
}
export type PaperGateRowResult =
  | {
      kind: 'malformed';
      reason:
        | 'scope'
        | 'candidate'
        | 'candidate-time'
        | 'candidate-number'
        | 'outcome'
        | 'association'
        | 'outcome-time'
        | 'outcome-number';
    }
  | { kind: 'unavailable'; reason: 'no-persisted-valid-outcome'; candidateKey: string }
  | {
      kind: 'decoded';
      observation: RegimeGateObservation;
      candidateKey: string;
      outcomeKey: string;
      issuanceRunId: string;
      resolutionRunId: string;
      qualificationReceiptId: string;
      resolutionReceiptId: string;
      currentEffectConfigIntentId: string;
      recordedAtMicroseconds: bigint;
    };
/** Only null outcome means absent valid-only row; undefined/malformed is an error.
 * Absence has UNKNOWN cause, not pending/invalid/no-candidate/neutral-zero evidence.
 * Scope/cutoff are explicit caller inputs, not derived latest/lease/coverage authority.
 */
export function decodePaperGateSampleRows(
  candidate: unknown,
  outcome: unknown,
  scope: PaperGateRowScope,
  cutoff: unknown,
): PaperGateRowResult {
  const fail = (
    reason: Extract<PaperGateRowResult, { kind: 'malformed' }>['reason'],
  ): PaperGateRowResult => ({ kind: 'malformed', reason });
  const bound = decodePaperDbMicroseconds(cutoff);
  if (
    !record(scope, namespace) ||
    namespace.some((k) =>
      k === 'epoch'
        ? !Number.isSafeInteger(scope[k]) || scope[k] < 1 || scope[k] > 2147483647
        : !id(scope[k]),
    ) ||
    scope.sample_policy !== PAPER_REGIME_SAMPLE_BUY_POLICY ||
    bound === undefined
  )
    return fail('scope');
  const c = record(candidate, candidateKeys);
  if (
    !c ||
    namespace.some((k) => c[k] !== scope[k]) ||
    !['candidate_key', 'issuance_run_id', 'qualification_receipt_id', 'symbol'].every((k) =>
      id(c[k]),
    ) ||
    !id(c.candidate_id, 256) ||
    !id(c.contract_id, 256) ||
    c.venue !== 'kalshi' ||
    !['UP', 'DOWN'].includes(c.side as string) ||
    c.source_kind !== 'prospective-engine-run' ||
    c.evidence_version !== PAPER_REGIME_EVIDENCE_CONTRACT ||
    c.fee_model_version !== 'historical-kalshi-continuous-taker-0.07-v1'
  )
    return fail('candidate');
  const created = decodePaperDbMicroseconds(c.created_at_us),
    close = decodePaperDbMicroseconds(c.closes_at_us);
  const closeIso = paperDbTimeToSourceIso(c.closes_at_us);
  if (
    created === undefined ||
    close === undefined ||
    !closeIso ||
    !paperDbTimeToSourceIso(c.created_at_us) ||
    close % 900_000_000n !== 0n ||
    created > close ||
    created > bound
  )
    return fail('candidate-time');
  const probability = decodePaperSourceBinary64(c.selected_side_probability),
    ask = decodePaperSourceBinary64(c.ask_price),
    fee = decodePaperSourceBinary64(c.estimated_fee_rate),
    predicted = decodePaperSourceBinary64(c.predicted_net_edge);
  if (
    probability === undefined ||
    probability < 0 ||
    probability > 1 ||
    ask === undefined ||
    ask <= 0 ||
    ask >= 1 ||
    fee === undefined ||
    fee < 0 ||
    fee > 0.0175 ||
    ask + fee >= 1 ||
    predicted === undefined ||
    predicted < -1 ||
    predicted > 1 ||
    fee !== 0.07 * ask * (1 - ask)
  )
    return fail('candidate-number');
  // Predicted edge/receipt labels are shape only: upstream model/path/quote and
  // selected-first-window qualification remain unproved, never recomputed here.
  if (outcome === null)
    return {
      kind: 'unavailable',
      reason: 'no-persisted-valid-outcome',
      candidateKey: c.candidate_key as string,
    };
  const o = record(outcome, outcomeKeys);
  if (
    !o ||
    ![
      'outcome_key',
      'resolution_run_id',
      'current_effect_config_intent_id',
      'resolution_receipt_id',
    ].every((k) => id(o[k])) ||
    o.source_kind !== 'prospective-engine-run' ||
    o.evidence_version !== PAPER_REGIME_EVIDENCE_CONTRACT ||
    !['UP', 'DOWN'].includes(o.winner as string)
  )
    return fail('outcome');
  if (
    [...namespace, 'candidate_key', 'closes_at_us', 'contract_id', 'side'].some(
      (k) => o[k] !== c[k],
    )
  )
    return fail('association');
  const resolved = decodePaperDbMicroseconds(o.resolved_at_us),
    recorded = decodePaperDbMicroseconds(o.recorded_at_us),
    resolvedIso = paperDbTimeToSourceIso(o.resolved_at_us);
  if (
    resolved === undefined ||
    recorded === undefined ||
    !resolvedIso ||
    resolved < close ||
    recorded < resolved ||
    recorded > bound
  )
    return fail('outcome-time');
  const edge = decodePaperSourceBinary64(o.realized_edge);
  if (
    edge === undefined ||
    edge < -1 ||
    edge > 1 ||
    edge !== (o.winner === c.side ? 1 : 0) - ask - fee
  )
    return fail('outcome-number');
  return {
    kind: 'decoded',
    observation: {
      id: c.candidate_id as string,
      policyVersion: PAPER_REGIME_SAMPLE_BUY_POLICY,
      closesAt: closeIso,
      resolvedAt: resolvedIso,
      realizedEdge: edge,
    },
    candidateKey: c.candidate_key as string,
    outcomeKey: o.outcome_key as string,
    issuanceRunId: c.issuance_run_id as string,
    resolutionRunId: o.resolution_run_id as string,
    qualificationReceiptId: c.qualification_receipt_id as string,
    resolutionReceiptId: o.resolution_receipt_id as string,
    currentEffectConfigIntentId: o.current_effect_config_intent_id as string,
    recordedAtMicroseconds: recorded,
  };
}
