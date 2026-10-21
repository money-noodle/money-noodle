// Everything the persisted gate writer DECIDES. The adapter executes; this module
// validates the request, derives the event payload from state the adapter actually read,
// and compares a replay. No store, no clock, no network.
//
// **Contract inputs versus claimed evidence.** A request carries two different kinds of
// field and they are treated differently:
//
//   * *Contract inputs* are values the record has no opinion about until they are
//     written — the generation's settings, its bundle and profile labels, the event key,
//     the run id, the reset barrier intent. Every one is bounded here against the exact
//     domain migration 0006 declares, and the adapter re-checks the ones that are
//     foreign keys by reading the rows.
//   * *Claimed evidence* is a caller's assertion about the world — the coverage receipt
//     id and the observed/cutoff boundary. These are bounded and ordered, never
//     believed: all counts, the universe bounds, the ordered input set, the lineage and
//     the resulting phase are DERIVED from persisted rows at that boundary. A false
//     boundary can only move the boundary; it cannot inflate a count or invent a phase.
//
// Nothing here chooses a cap, a default, an economic parameter or a policy. The phase
// transition comes from the qualified `paper-regime` arithmetic, fed from persisted
// outcome columns, and this module refuses rather than persisting an evaluation whose
// own shape does not match what it derived.

import {
  PAPER_HISTORICAL_REGIME_CONTRACT,
  PAPER_REGIME_EVIDENCE_CONTRACT,
  PAPER_REGIME_SAMPLE_BUY_POLICY,
  PAPER_RESTRICTIVE_REGIME_PROPOSAL,
  REGIME_GATE_POLICY_VERSION,
  evaluateHistoricalPaperRegime,
  paperRegimeSettingsIdentity,
  type RegimeGateEvaluation,
  type RegimeGateObservation,
  type RegimeGatePhase,
  type RegimeGateSettings,
} from './paper-regime.js';
import { paperExactRegimeSourceWithinDomains } from './paper-bound-decimal.js';
import { PAPER_GATE_UNIVERSE_LIMIT } from './paper-gate-coverage.js';
import { paperGateRowScopeIsValid, type PaperGateRowScope } from './paper-gate-row-codec.js';

export const PAPER_GATE_WRITE_PROTOCOL = 'paper-gate-persisted-write-result-v1';
export const PAPER_GATE_SOURCE_KIND = 'prospective-engine-run';
/** Genesis is revision EXACTLY 0: migration 0006 checks it and the coverage reader
 * requires it. An earlier reviewer sketch suggesting 1 is not propagated. */
export const PAPER_GATE_GENESIS_REVISION = 0n;
/** `paper_gate_phase_event.revision_after` tops out here in 0006. */
const MAX_REVISION = 9007199254740991n;
/** `epoch integer not null check (epoch >= 1)`: the full PostgreSQL `integer` domain. */
export const MAX_PAPER_GATE_EPOCH = 2147483647;

/** The canonical epoch parser. A count parser bounded to a handful of digits is NOT a
 * substitute: it would reject legitimate epochs above its digit budget. */
export function paperGateEpochFromText(value: unknown): number | undefined {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,9}$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= MAX_PAPER_GATE_EPOCH
    ? parsed
    : undefined;
}

export type PaperGateWriteRefusal =
  | 'scope'
  | 'request'
  | 'lease-not-held'
  | 'lease-lost'
  | 'authority'
  | 'run-record'
  | 'generation'
  | 'generation-exists'
  | 'reset-barrier'
  | 'head'
  | 'stale-revision'
  | 'universe'
  | 'evidence-rejected'
  | 'evidence-producer-unavailable'
  | 'replay-mismatch'
  | 'conflict';

export interface PaperGateFence {
  capability: string;
  owner: string;
  fencingToken: bigint;
}

/** Decimal strings, never JS floats: `numeric` columns are exact and these cross as
 * text with an explicit cast, so no binary rounding is introduced on the way in. */
export interface PaperGateGenerationInputs {
  bundleId: typeof PAPER_RESTRICTIVE_REGIME_PROPOSAL | typeof PAPER_HISTORICAL_REGIME_CONTRACT;
  profileClaim: string;
  enabled: boolean;
  minimumPolicyWindows: number;
  evidenceHalfLifeWindows: string;
  pauseConfidence: string;
  resumeConfidence: string;
}

interface CommonRequest {
  scope: PaperGateRowScope;
  eventKey: string;
  runId: string;
  /** Claimed evidence: an opaque receipt label, bounded, never believed. */
  coverageReceiptId: string;
  /** Claimed evidence boundary. Millisecond-aligned, because 0006 requires it and the
   * regime arithmetic reads it as whole milliseconds. */
  evidenceObservedAtIso: string;
  coverageCutoffAtIso: string;
}

export type PaperGateWriteRequest =
  | (CommonRequest & { kind: 'initialize'; generation: PaperGateGenerationInputs })
  | (CommonRequest & {
      kind: 'reset';
      generation: PaperGateGenerationInputs;
      resetBarrierIntentId: string;
      priorGenerationKey: string;
    })
  | (CommonRequest & { kind: 'evaluate'; expectedRevision: bigint });

export interface PaperGateDerivedUniverse {
  capturedCandidateCount: number;
  capturedResolvedCount: number;
  capturedUnresolvedCount: number;
  firstClosesAtMicroseconds: bigint | undefined;
  lastClosesAtMicroseconds: bigint | undefined;
}

export interface PaperGateWriteReceipt {
  protocol: typeof PAPER_GATE_WRITE_PROTOCOL;
  validity: 'single-transaction-snapshot-only';
  /** A write result is history the moment its transaction commits. It is not standing
   * authority and confers no capability on a later transaction. */
  lifetime: 'committed-write-record-not-standing-authority';
  admission: 'none';
  /** `validated-in-this-transaction` on a write; a replay deliberately does not read
   * present authority, so it can never be mistaken for present write admission. */
  authority: 'validated-in-this-transaction' | 'not-evaluated-on-replay';
  scope: PaperGateRowScope;
  eventKey: string;
  eventKind: 'genesis' | 'evaluated';
  revisionBefore: bigint | undefined;
  revisionAfter: bigint;
  previousPhase: RegimeGatePhase | undefined;
  projectedPhase: RegimeGatePhase;
  generationCreated: boolean;
  headMoved: boolean;
  derived: PaperGateDerivedUniverse;
  inputCandidateKeys: readonly string[];
  /** What the control record said in this same transaction, for audit. Never a
   * substitute for re-reading it. */
  boundConfigureIntentId: string;
  boundLatestIntentId: string;
}

export type PaperGateWriteResult =
  | { kind: 'refused'; reason: PaperGateWriteRefusal; detail: string }
  | { kind: 'written'; receipt: PaperGateWriteReceipt }
  | { kind: 'replayed'; receipt: PaperGateWriteReceipt };

const identity = (value: unknown, max = 120): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value;

/** A plain unsigned decimal with an optional fraction: no exponent, no sign, no spaces,
 * so the text handed to `::numeric` is exactly what a reviewer reads. */
const decimal = (value: unknown, max = 24): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  /^[0-9]+(\.[0-9]+)?$/.test(value);

/** Strict round-trip ISO at millisecond precision, ending in `Z`. 0006 requires the
 * observed boundary to be millisecond-aligned and the regime arithmetic reads whole
 * milliseconds, so anything else is refused rather than silently truncated. */
export function paperGateIsoMilliseconds(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length !== 24) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed)) return undefined;
  return new Date(parsed).toISOString() === value ? parsed : undefined;
}

export function paperGateGenerationInputsAreValid(inputs: PaperGateGenerationInputs): boolean {
  if (!inputs || typeof inputs !== 'object') return false;
  if (
    inputs.bundleId !== PAPER_RESTRICTIVE_REGIME_PROPOSAL &&
    inputs.bundleId !== PAPER_HISTORICAL_REGIME_CONTRACT
  )
    return false;
  if (!identity(inputs.profileClaim, 256)) return false;
  if (typeof inputs.enabled !== 'boolean') return false;
  if (
    !Number.isSafeInteger(inputs.minimumPolicyWindows) ||
    inputs.minimumPolicyWindows < 4 ||
    inputs.minimumPolicyWindows > 500
  )
    return false;
  // Exactly the 0006 domains, as decimal text, and decided on that text. The bounds and
  // the margin are the column's own; what changed is only HOW they are decided. Deciding
  // them through `Number` disagreed with `numeric` in both directions: it refused legal
  // pairs (`0.94`/`0.93`, `0.9007`/`0.8907`, where the subtraction rounds) and admitted
  // values the column rejects, because excess digits round away before the comparison.
  // Spelling is still the writer's: `'2.50'`, `'2.5'`, `'08'` and `'0.970'` all pass.
  if (!decimal(inputs.evidenceHalfLifeWindows)) return false;
  if (!decimal(inputs.pauseConfidence)) return false;
  if (!decimal(inputs.resumeConfidence)) return false;
  // The domains and the margin, from the one place that owns those literals, so the
  // request validator, the row mapping and the evaluator cannot drift apart.
  return paperExactRegimeSourceWithinDomains({
    evidenceHalfLifeWindows: inputs.evidenceHalfLifeWindows,
    pauseConfidence: inputs.pauseConfidence,
    resumeConfidence: inputs.resumeConfidence,
  });
}

/** Validated BEFORE any statement runs, so a malformed request never reaches the driver
 * as parameters and never opens a transaction that could mutate. */
export function paperGateWriteRequestIsValid(
  request: PaperGateWriteRequest,
  fence: PaperGateFence,
): PaperGateWriteRefusal | undefined {
  if (!request || typeof request !== 'object') return 'request';
  if (!paperGateRowScopeIsValid(request.scope)) return 'scope';
  if (
    typeof fence !== 'object' ||
    fence === null ||
    !identity(fence.capability) ||
    !identity(fence.owner) ||
    typeof fence.fencingToken !== 'bigint' ||
    fence.fencingToken < 1n
  )
    return 'scope';
  if (
    !Number.isSafeInteger(request.scope.epoch) ||
    request.scope.epoch < 1 ||
    request.scope.epoch > MAX_PAPER_GATE_EPOCH
  )
    return 'scope';
  if (!identity(request.eventKey) || !identity(request.runId)) return 'request';
  if (!identity(request.coverageReceiptId)) return 'request';
  const observed = paperGateIsoMilliseconds(request.evidenceObservedAtIso);
  const cutoff = paperGateIsoMilliseconds(request.coverageCutoffAtIso);
  if (observed === undefined || cutoff === undefined) return 'request';
  if (request.kind === 'evaluate') {
    if (
      typeof request.expectedRevision !== 'bigint' ||
      request.expectedRevision < 0n ||
      request.expectedRevision >= MAX_REVISION
    )
      return 'request';
    return undefined;
  }
  if (request.kind === 'initialize') {
    return paperGateGenerationInputsAreValid(request.generation) ? undefined : 'request';
  }
  if (request.kind === 'reset') {
    if (!identity(request.resetBarrierIntentId) || !identity(request.priorGenerationKey))
      return 'request';
    if (request.priorGenerationKey === request.scope.generation_key) return 'request';
    return paperGateGenerationInputsAreValid(request.generation) ? undefined : 'request';
  }
  return 'request';
}

/** One persisted candidate, with its outcome when it has one. Microseconds as exact
 * text from SQL; `realized_edge` as exact decimal text. */
export interface PaperGateUniverseEntry {
  candidateKey: string;
  closesAtMicroseconds: bigint;
  outcomeResolvedAtMicroseconds: bigint | undefined;
  outcomeRecordedAtMicroseconds: bigint | undefined;
  realizedEdge: string | undefined;
  contractId: string;
  side: string;
}

export function derivePaperGateUniverse(
  entries: readonly PaperGateUniverseEntry[],
): PaperGateDerivedUniverse | undefined {
  if (entries.length > PAPER_GATE_UNIVERSE_LIMIT) return undefined;
  let resolved = 0;
  let first: bigint | undefined;
  let last: bigint | undefined;
  const seen = new Set<string>();
  const windows = new Set<string>();
  for (const entry of entries) {
    if (!identity(entry.candidateKey) || seen.has(entry.candidateKey)) return undefined;
    seen.add(entry.candidateKey);
    // 0006 makes `(generation_key, sample_policy, closes_at)` unique, so two entries on
    // one window inside a single generation cannot be a legitimate read.
    const window = entry.closesAtMicroseconds.toString();
    if (windows.has(window)) return undefined;
    windows.add(window);
    if (first === undefined || entry.closesAtMicroseconds < first)
      first = entry.closesAtMicroseconds;
    if (last === undefined || entry.closesAtMicroseconds > last) last = entry.closesAtMicroseconds;
    if (entry.outcomeResolvedAtMicroseconds !== undefined) resolved += 1;
  }
  return {
    capturedCandidateCount: entries.length,
    capturedResolvedCount: resolved,
    capturedUnresolvedCount: entries.length - resolved,
    firstClosesAtMicroseconds: first,
    lastClosesAtMicroseconds: last,
  };
}

export interface PaperGateGenerationRow {
  bundleId: string;
  gateFormula: string;
  samplePolicy: string;
  settingsDescriptor: string;
  enabled: boolean;
  minimumPolicyWindows: number;
  evidenceHalfLifeWindows: string;
  pauseConfidence: string;
  resumeConfidence: string;
  initializationRunId: string;
  configIntentId: string;
  epoch: number;
}

/** The settings the generation ROW carries, and the descriptor it must agree with.
 * `settings_descriptor` is `paperRegimeSettingsIdentity(...)`, so a row whose columns
 * and descriptor disagree is not a coherent generation and is refused. */
export function paperGateSettingsFromRow(
  row: PaperGateGenerationRow,
): RegimeGateSettings | undefined {
  // The 0006 domains, decided on the persisted TEXT and BEFORE the `Number` conversions
  // below, because that conversion is lossy: a column value such as
  // `0.99990000000000000001` is outside `pause_confidence between 0.9 and 0.9999`, yet
  // `Number` makes it exactly `0.9999` and no later check could tell the difference.
  const exactSource = {
    evidenceHalfLifeWindows: row.evidenceHalfLifeWindows,
    pauseConfidence: row.pauseConfidence,
    resumeConfidence: row.resumeConfidence,
  };
  if (
    typeof row.enabled !== 'boolean' ||
    !Number.isSafeInteger(row.minimumPolicyWindows) ||
    !paperExactRegimeSourceWithinDomains(exactSource)
  )
    return undefined;
  // The numbers are the ones the arithmetic has always used, converted exactly as
  // before, and the number-based descriptor they are compared against is unchanged. The
  // persisted TEXT travels with them so the evaluator can decide validity on the digits
  // the column holds: a profile `numeric` accepts has to stay evaluable, and the
  // projection alone cannot prove its margin.
  const settings: RegimeGateSettings = {
    enabled: row.enabled,
    evidenceHalfLifeWindows: Number(row.evidenceHalfLifeWindows),
    exactSource,
    minimumPolicyWindows: row.minimumPolicyWindows,
    pauseConfidence: Number(row.pauseConfidence),
    resumeConfidence: Number(row.resumeConfidence),
  };
  return paperRegimeSettingsIdentity(settings) === row.settingsDescriptor ? settings : undefined;
}

const isoFromMicroseconds = (micro: bigint): string | undefined => {
  // Lossless only when the instant is millisecond-aligned, which 0006 enforces for every
  // column read here. Anything else refuses rather than rounding.
  if (micro % 1000n !== 0n) return undefined;
  const ms = Number(micro / 1000n);
  if (!Number.isSafeInteger(ms)) return undefined;
  const iso = new Date(ms).toISOString();
  return Date.parse(iso) === ms ? iso : undefined;
};

export interface PaperGateEvaluationDerivation {
  evaluation: RegimeGateEvaluation;
  observations: readonly RegimeGateObservation[];
  inputs: readonly PaperGateUniverseEntry[];
}

/** Maps persisted outcome columns onto the qualified regime observation DTO and runs the
 * qualified arithmetic. The mapping is mechanical — `candidate_key`, the generation's own
 * `sample_policy`, `closes_at`, `resolved_at`, `realized_edge` — and no economic value is
 * invented. `realizedEdge` is a dimensionless edge in [-1,1] that the qualified domain
 * defines as a JS number; no money or cent column is converted here. */
export function derivePaperGateEvaluation(
  generation: PaperGateGenerationRow,
  entries: readonly PaperGateUniverseEntry[],
  previousPhase: RegimeGatePhase,
  lineage:
    | {
        kind: 'initialized';
        initializationRunId: string;
        priorGenerationState: 'none';
        revision: 0;
      }
    | { kind: 'persisted'; stateRunId: string; revision: number },
  observedAtMilliseconds: number,
  nowMilliseconds: number,
): PaperGateEvaluationDerivation | { refusal: PaperGateWriteRefusal; detail: string } {
  // Only the historical warm-lineage contract is reachable: the restrictive proposal's
  // entry point takes a maximum-evidence-age, and choosing one would be inventing a
  // freshness tolerance this batch has no authority to pick.
  if (generation.bundleId !== PAPER_HISTORICAL_REGIME_CONTRACT)
    return {
      detail: 'restrictive-bundle-max-age-undecided',
      refusal: 'evidence-producer-unavailable',
    };
  if (generation.gateFormula !== REGIME_GATE_POLICY_VERSION)
    return { detail: 'gate-formula', refusal: 'generation' };
  if (generation.samplePolicy !== PAPER_REGIME_SAMPLE_BUY_POLICY)
    return { detail: 'sample-policy', refusal: 'generation' };
  const settings = paperGateSettingsFromRow(generation);
  if (settings === undefined) return { detail: 'settings-descriptor', refusal: 'generation' };
  const inputs = entries
    .filter((entry) => entry.outcomeResolvedAtMicroseconds !== undefined)
    // Deterministic, database-precision order: window then candidate key, exactly the
    // order the coverage reader enumerates and the order the inputs are persisted in.
    .slice()
    .sort((left, right) =>
      left.closesAtMicroseconds === right.closesAtMicroseconds
        ? left.candidateKey < right.candidateKey
          ? -1
          : left.candidateKey > right.candidateKey
            ? 1
            : 0
        : left.closesAtMicroseconds < right.closesAtMicroseconds
          ? -1
          : 1,
    );
  const observations: RegimeGateObservation[] = [];
  for (const entry of inputs) {
    const closesAt = isoFromMicroseconds(entry.closesAtMicroseconds);
    const resolvedAt =
      entry.outcomeResolvedAtMicroseconds === undefined
        ? undefined
        : isoFromMicroseconds(entry.outcomeResolvedAtMicroseconds);
    if (closesAt === undefined || resolvedAt === undefined || entry.realizedEdge === undefined)
      return { detail: 'outcome-representation', refusal: 'universe' };
    const realizedEdge = Number(entry.realizedEdge);
    if (!Number.isFinite(realizedEdge)) return { detail: 'realized-edge', refusal: 'universe' };
    observations.push({
      closesAt,
      id: entry.candidateKey,
      policyVersion: generation.samplePolicy,
      realizedEdge,
      resolvedAt,
    });
  }
  const settingsIdentity = paperRegimeSettingsIdentity(settings);
  const regimeIdentity = {
    bundleId: PAPER_HISTORICAL_REGIME_CONTRACT as typeof PAPER_HISTORICAL_REGIME_CONTRACT,
    configIntentId: generation.configIntentId,
    epoch: generation.epoch,
    evidenceGenerationId: generation.initializationRunId,
    gateFormula: REGIME_GATE_POLICY_VERSION as typeof REGIME_GATE_POLICY_VERSION,
    settingsIdentity,
  };
  const evaluation = evaluateHistoricalPaperRegime(
    {
      complete: true,
      identity: regimeIdentity,
      observations,
      observedAtMs: observedAtMilliseconds,
      policyVersion: generation.samplePolicy,
      previousPhase,
      previousPhasePolicyVersion: generation.samplePolicy,
      sourceId: generation.initializationRunId,
      sourceKind: PAPER_GATE_SOURCE_KIND,
    },
    settings,
    nowMilliseconds,
    regimeIdentity,
    lineage,
  );
  // The evaluation must match what was derived, or it is not an evaluation OF this
  // universe and must not be persisted. 0006's own branch checks would reject most of
  // these; they are refused here so the reason is the real one rather than a constraint
  // violation.
  if (evaluation.resolvedWindows !== observations.length)
    return {
      detail: 'resolved-window-mismatch:' + evaluation.reason,
      refusal: 'evidence-rejected',
    };
  const hasNumbers =
    evaluation.weightedMeanEdge !== null &&
    evaluation.standardError !== null &&
    evaluation.negativeReturnConfidence !== null;
  if (observations.length === 0) {
    if (evaluation.phase !== 'warming' || evaluation.effectiveWindows !== 0 || hasNumbers)
      return { detail: 'empty-universe-shape:' + evaluation.reason, refusal: 'evidence-rejected' };
  } else if (!hasNumbers || !(evaluation.effectiveWindows > 0))
    return { detail: 'incomplete-evaluation:' + evaluation.reason, refusal: 'evidence-rejected' };
  return { evaluation, inputs, observations };
}

/** `evidence_version` is fixed by 0006 and by the qualified evidence contract. */
export const PAPER_GATE_EVIDENCE_VERSION = PAPER_REGIME_EVIDENCE_CONTRACT;

/** The persisted event as the adapter read it back, for replay comparison. Every field
 * the request or the derivation determines is compared; nothing is compared as parsed
 * JSON or by property order. */
export interface PaperGatePersistedEvent {
  generationKey: string;
  fundingId: string;
  epoch: number;
  budgetId: string;
  configIntentId: string;
  samplePolicy: string;
  eventKind: string;
  revisionAfter: bigint;
  priorEventKey: string | undefined;
  revisionBefore: bigint | undefined;
  previousPhase: string | undefined;
  resultPhase: string | undefined;
  projectedPhase: string;
  currentEffectConfigIntentId: string;
  latestIntentId: string;
  runId: string;
  sourceKind: string;
  evidenceVersion: string;
  coverageReceiptId: string;
  evidenceObservedAtMicroseconds: bigint;
  coverageCutoffAtMicroseconds: bigint;
  capturedCandidateCount: number;
  capturedResolvedCount: number;
  capturedUnresolvedCount: number;
  inputCount: number;
  universeFirstClosesAtMicroseconds: bigint | undefined;
  universeLastClosesAtMicroseconds: bigint | undefined;
  inputCandidateKeys: readonly string[];
}

/** What a fresh write WOULD have persisted, derived in this transaction. */
export interface PaperGateIntendedEvent {
  eventKind: 'genesis' | 'evaluated';
  revisionAfter: bigint;
  revisionBefore: bigint | undefined;
  priorEventKey: string | undefined;
  previousPhase: RegimeGatePhase | undefined;
  projectedPhase: RegimeGatePhase;
  capturedCandidateCount: number;
  capturedResolvedCount: number;
  capturedUnresolvedCount: number;
  inputCount: number;
  universeFirstClosesAtMicroseconds: bigint | undefined;
  universeLastClosesAtMicroseconds: bigint | undefined;
  inputCandidateKeys: readonly string[];
}

/** The generation row as the adapter read it back for a genesis or reset replay. The
 * three `numeric` settings are compared BY POSTGRESQL against the request's decimal text,
 * so the flags below are exact numeric equality and no JS `Number` coercion is introduced
 * where exactness is required. */
export interface PaperGatePersistedGeneration {
  bundleId: string;
  profileClaim: string;
  enabled: boolean;
  minimumPolicyWindows: string;
  evidenceHalfLifeMatches: boolean;
  pauseConfidenceMatches: boolean;
  resumeConfidenceMatches: boolean;
  initializationRunId: string;
  resetOrigin: string;
  resetBarrierIntentId: string | undefined;
  /** Whether the claimed prior generation is a real generation in this namespace whose
   * configure intent orders strictly before the PERSISTED reset barrier — the same
   * predicate the write path applied. `undefined` when the request made no such claim. */
  priorGenerationVerified: boolean | undefined;
}

/** A genesis or reset replay compares the GENERATION too, not only the event: settings,
 * labels, the initialization run and the reset provenance are all accepted semantic
 * fields, so a request differing in any of them is a different request and is refused.
 *
 * **Two kinds of provenance, labelled rather than blurred.** `resetOrigin` and
 * `resetBarrierIntentId` are DERIVED: read from the persisted generation row. The prior
 * generation is a VALIDATED CLAIM: `priorGenerationKey` is not a persisted column, so the
 * caller's claim is checked against real history with the same predicate the write path
 * applies, against the PERSISTED barrier. This module does not silently pick a "newest
 * plausible" prior generation in place of the claim; an unverifiable differing claim is
 * rejected. Tightening that to a derived selection would change the request contract and
 * is left as a proposal, not done here. */
export function comparePaperGateGenerationReplay(
  persisted: PaperGatePersistedGeneration,
  request: PaperGateWriteRequest,
): string | undefined {
  if (request.kind === 'evaluate') return undefined;
  const generation = request.generation;
  const expectedOrigin = request.kind === 'reset' ? 'post-reset' : 'none';
  const expectedBarrier = request.kind === 'reset' ? request.resetBarrierIntentId : undefined;
  const checks: readonly (readonly [string, boolean])[] = [
    ['bundle_id', persisted.bundleId === generation.bundleId],
    ['profile_claim', persisted.profileClaim === generation.profileClaim],
    ['enabled', persisted.enabled === generation.enabled],
    [
      'minimum_policy_windows',
      persisted.minimumPolicyWindows === String(generation.minimumPolicyWindows),
    ],
    ['evidence_half_life_windows', persisted.evidenceHalfLifeMatches],
    ['pause_confidence', persisted.pauseConfidenceMatches],
    ['resume_confidence', persisted.resumeConfidenceMatches],
    ['initialization_run_id', persisted.initializationRunId === request.runId],
    ['reset_origin', persisted.resetOrigin === expectedOrigin],
    ['reset_barrier_intent_id', persisted.resetBarrierIntentId === expectedBarrier],
  ];
  for (const [field, ok] of checks) if (!ok) return field;
  // The claimed prior generation must be verifiable against the persisted barrier and
  // real history. An unverifiable claim is a refusal, never a silent success.
  if (request.kind === 'reset' && persisted.priorGenerationVerified !== true)
    return 'prior_generation_key';
  return undefined;
}

/** Field-by-field, exact: microseconds as bigints, counts as integers, keys and the
 * ordered input list in order. Any difference is a refusal, never an upsert. */
export function comparePaperGateReplay(
  persisted: PaperGatePersistedEvent,
  intended: PaperGateIntendedEvent,
  request: PaperGateWriteRequest,
): string | undefined {
  const scope = request.scope;
  const checks: readonly (readonly [string, boolean])[] = [
    ['generation_key', persisted.generationKey === scope.generation_key],
    ['funding_id', persisted.fundingId === scope.funding_id],
    ['epoch', persisted.epoch === scope.epoch],
    ['budget_id', persisted.budgetId === scope.budget_id],
    ['generation_config_intent_id', persisted.configIntentId === scope.generation_config_intent_id],
    ['sample_policy', persisted.samplePolicy === scope.sample_policy],
    ['run_id', persisted.runId === request.runId],
    ['source_kind', persisted.sourceKind === PAPER_GATE_SOURCE_KIND],
    ['evidence_version', persisted.evidenceVersion === PAPER_GATE_EVIDENCE_VERSION],
    ['coverage_receipt_id', persisted.coverageReceiptId === request.coverageReceiptId],
    [
      'evidence_observed_at',
      persisted.evidenceObservedAtMicroseconds ===
        BigInt(paperGateIsoMilliseconds(request.evidenceObservedAtIso) ?? -1) * 1000n,
    ],
    [
      'coverage_cutoff_at',
      persisted.coverageCutoffAtMicroseconds ===
        BigInt(paperGateIsoMilliseconds(request.coverageCutoffAtIso) ?? -1) * 1000n,
    ],
    ['event_kind', persisted.eventKind === intended.eventKind],
    ['revision_after', persisted.revisionAfter === intended.revisionAfter],
    ['revision_before', persisted.revisionBefore === intended.revisionBefore],
    ['prior_event_key', persisted.priorEventKey === intended.priorEventKey],
    ['previous_phase', persisted.previousPhase === intended.previousPhase],
    ['projected_phase', persisted.projectedPhase === intended.projectedPhase],
    [
      'captured_candidate_count',
      persisted.capturedCandidateCount === intended.capturedCandidateCount,
    ],
    ['captured_resolved_count', persisted.capturedResolvedCount === intended.capturedResolvedCount],
    [
      'captured_unresolved_count',
      persisted.capturedUnresolvedCount === intended.capturedUnresolvedCount,
    ],
    ['input_count', persisted.inputCount === intended.inputCount],
    [
      'universe_first_closes_at',
      persisted.universeFirstClosesAtMicroseconds === intended.universeFirstClosesAtMicroseconds,
    ],
    [
      'universe_last_closes_at',
      persisted.universeLastClosesAtMicroseconds === intended.universeLastClosesAtMicroseconds,
    ],
    [
      'ordered_inputs',
      persisted.inputCandidateKeys.length === intended.inputCandidateKeys.length &&
        persisted.inputCandidateKeys.every((key, i) => key === intended.inputCandidateKeys[i]),
    ],
    // There is no capability column on a phase event, so a capability cannot be compared
    // here and no pseudo-check pretends otherwise. The capability binding is enforced
    // where it actually lives: the adapter requires `run_id` to name a real
    // `engine.job_run_record` whose `capability` equals the fence capability BEFORE it
    // reaches this comparison, and `run_id` itself is compared above. A replay under a
    // different capability therefore fails on the run record, not here.
  ];
  for (const [field, ok] of checks) if (!ok) return field;
  // On replay the caller's expected revision describes a DIFFERENT intent when it does
  // not match the revision this event was actually recorded against. It is compared
  // against the recorded `revision_before`, NOT against the present head, so a replay
  // neither depends on nor reports present state.
  if (request.kind === 'evaluate' && request.expectedRevision !== (persisted.revisionBefore ?? -1n))
    return 'expected_revision';
  if (request.kind !== 'evaluate' && persisted.revisionAfter !== PAPER_GATE_GENESIS_REVISION)
    return 'genesis_revision';
  return undefined;
}
