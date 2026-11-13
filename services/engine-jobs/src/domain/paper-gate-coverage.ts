// Verification of a PERSISTED gate coverage receipt against an independently
// enumerated candidate universe, from rows read inside ONE coherent database
// transaction. Pure: no SQL, store, network, clock or economic work here.
//
// What this proves, exactly: that the phase event the generation's head points at
// claims a universe, a cutoff and an input set which AGREE with the universe this
// snapshot actually contains. The claims come from persisted rows a previous run
// wrote under the schema's own CHECKs; the universe is enumerated separately in the
// same snapshot. Agreement is the proof. A caller cannot supply completeness,
// initialization, reset or authority, and no count taken from the selected rows is
// treated as evidence for itself.
//
// The universe is exactly the candidates VISIBLE IN THIS SNAPSHOT whose `created_at`
// is at or before the receipt's cutoff. It is not every row the table will ever hold,
// not every row visible now outside the transaction, and not candidates created after
// the cutoff — those are outside this receipt by the same cutoff rule the row decoder
// already applies.
//
// What this does NOT prove, and must never be read as proving: external or historical
// completeness beyond this snapshot, that no later row exists, current admission
// authority, provider or funding authority, or that a future write will replay or
// compare-and-set correctly. Coverage here means exactly "the persisted universe
// visible in that one transaction, bounded by the cutoff".
//
// A returned receipt is a HISTORICAL READ ATTESTATION. The caller receives it after the
// reading transaction has ended, so it attests what was true under a live fence during
// that transaction. It is NOT evidence that the lease is still held when the caller
// reads it, and it confers no write capability inside any transaction. Nothing may
// carry it into another transaction and treat it as that transaction's own fence.
//
// Clocks: every database instant arrives as exact signed epoch-microsecond TEXT,
// extracted in SQL before any driver Date, and is decoded with the existing
// qualified codec. Source instants stay source ISO. No Date truncation of a
// recorded or cutoff authority, and no lexical money rounding: this module reads no
// money column at all.
import { paperGateRowScopeIsValid, type PaperGateRowScope } from './paper-gate-row-codec.js';
import { decodePaperDbMicroseconds, paperDbTimeToSourceIso } from './paper-time-codec.js';
import {
  PAPER_REGIME_SAMPLE_BUY_POLICY,
  REGIME_GATE_POLICY_VERSION,
  PAPER_REGIME_EVIDENCE_CONTRACT,
  PAPER_RESTRICTIVE_REGIME_PROPOSAL,
  PAPER_HISTORICAL_REGIME_CONTRACT,
  type PaperRegimeLineage,
  type RegimeGatePhase,
} from './paper-regime.js';

export const PAPER_GATE_COVERAGE_PROTOCOL = 'paper-gate-persisted-coverage-receipt-v1';
/** The schema's own ceiling on captured counts and phase-input ordinals. */
export const PAPER_GATE_UNIVERSE_LIMIT = 5000;
const PHASES: readonly RegimeGatePhase[] = ['warming', 'disabled', 'open', 'closed'];
const MAX_REVISION = 9007199254740991n;

export type PaperGateCoverageRefusal =
  | 'scope'
  | 'lease-not-held'
  | 'lease-lost'
  | 'generation'
  | 'root'
  | 'head'
  | 'event'
  | 'event-clock'
  | 'lineage'
  | 'universe-overflow'
  | 'universe-drift'
  | 'input-mismatch'
  | 'control-malformed';

export interface PaperGateCoverageFence {
  capability: string;
  owner: string;
  /** bigint, matching the store's `fencing_token bigint`. A caller holding the cycle
   * store's `number` token must convert explicitly; no implicit narrowing happens
   * here, and that conversion is still to be wired when the two seams meet. */
  fencingToken: bigint;
}

export interface PaperGateCoverageReceipt {
  protocol: typeof PAPER_GATE_COVERAGE_PROTOCOL;
  scope: PaperGateRowScope;
  /** Head pointer, bound into the proof so a later head cannot inherit it. The head is
   * the generation's declared latest event; it is NOT proof that no higher revision row
   * exists, only that the head and the event it points at agree. */
  headEventKey: string;
  headRevision: bigint;
  eventKind: 'genesis' | 'evaluated';
  projectedPhase: RegimeGatePhase;
  /** The receipt label the persisted event carries. A label, never a proof by itself. */
  coverageReceiptId: string;
  /** Exact DB microseconds. NOT a completeness watermark and NOT proof no later row exists. */
  coverageCutoffMicroseconds: bigint;
  recordedAtMicroseconds: bigint;
  /** Source ISO; the schema pins this column to whole milliseconds. */
  evidenceObservedAtIso: string;
  /** Read from the CONSTRAINED PERSISTED genesis or evaluated row, never from absent
   * rows. A genesis row is evidence of a constrained persisted row bound to the
   * generation's own initialization run; it is not proof that a genuine initialization
   * or reset protocol was executed by whoever wrote it. */
  lineage: PaperRegimeLineage;
  /** Independently enumerated in this snapshot, ascending by window then candidate key. */
  universeCandidateKeys: readonly string[];
  resolvedCandidateKeys: readonly string[];
  unresolvedCandidateKeys: readonly string[];
  unresolvedCause: 'unknown';
  universeFirstWindowIso: string | null;
  universeLastWindowIso: string | null;
  /** Snapshot comparison only: NOT current admission or control authority. */
  recordedLatestIntentStillNewest: boolean;
  fence: PaperGateCoverageFence;
  /** The proof dies with its transaction; nothing may carry it across one. */
  validity: 'single-transaction-snapshot-only';
  completeness: 'persisted-universe-in-this-snapshot-only';
  /** Explicitly still unproved by a coherent read alone. */
  replayCompareAndSet: 'not-proved';
}

export type PaperGateCoverageResult =
  | { kind: 'refused'; reason: PaperGateCoverageRefusal; detail: string | null }
  | { kind: 'verified'; receipt: PaperGateCoverageReceipt };

/** One enumerated candidate plus the outcome recorded clock, if any outcome exists. */
export interface PaperGateUniverseRow {
  candidate_key: unknown;
  closes_at_us: unknown;
  created_at_us: unknown;
  outcome_recorded_at_us: unknown;
}

export interface PaperGateCoverageSnapshot {
  /** engine.job_lease row matched on capability+owner+token+live expiry, or null. */
  leaseHeld: boolean;
  /** Re-read under a row lock at the final boundary. */
  leaseStillHeld: boolean;
  generation: unknown;
  /** Existence of the funding and budget roots for this (funding_id, epoch, budget_id). */
  rootsPresent: unknown;
  head: unknown;
  event: unknown;
  inputs: readonly unknown[];
  universe: readonly unknown[];
  /** Newest engine.control_intent row for the capability by (epoch, recorded_at, id). */
  newestControlIntentId: unknown;
  newestControlIntentValid: unknown;
}

const text = (v: unknown, max = 120): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max && v.trim() === v;
const object = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
const count = (v: unknown): number | undefined =>
  typeof v === 'string' && /^(?:0|[1-9][0-9]{0,6})$/.test(v) ? Number(v) : undefined;
const revision = (v: unknown): bigint | undefined => {
  if (typeof v !== 'string' || !/^(?:0|[1-9][0-9]{0,18})$/.test(v)) return undefined;
  const parsed = BigInt(v);
  return parsed <= MAX_REVISION ? parsed : undefined;
};

/**
 * Verifies the persisted coverage receipt the head points at against the
 * independently enumerated universe in the same snapshot. Every failure is an
 * explicit closed refusal; nothing is inferred, defaulted or assumed present.
 */
export function verifyPaperGateCoverage(
  snapshot: PaperGateCoverageSnapshot,
  scope: PaperGateRowScope,
  fence: PaperGateCoverageFence,
): PaperGateCoverageResult {
  const refuse = (
    reason: PaperGateCoverageRefusal,
    detail: string | null,
  ): PaperGateCoverageResult => ({ kind: 'refused', reason, detail });
  if (!paperGateRowScopeIsValid(scope)) return refuse('scope', 'namespace');
  if (
    !text(fence.capability) ||
    !text(fence.owner) ||
    typeof fence.fencingToken !== 'bigint' ||
    fence.fencingToken < 1n
  )
    return refuse('scope', 'fence');
  const snap = object(snapshot);
  if (!snap) return refuse('scope', 'snapshot');
  // The lease is proved by the database at both boundaries, never by a caller flag
  // that the adapter did not obtain from engine.job_lease under the DB clock.
  if (snapshot.leaseHeld !== true) return refuse('lease-not-held', null);

  const namespace = [
    'generation_key',
    'funding_id',
    'epoch',
    'budget_id',
    'generation_config_intent_id',
    'sample_policy',
  ] as const;
  const matchesScope = (row: Record<string, unknown>): boolean =>
    namespace.every((k) => row[k] === scope[k]);

  const generation = object(snapshot.generation);
  if (!generation) return refuse('generation', 'missing');
  if (!matchesScope(generation)) return refuse('generation', 'namespace');
  if (
    generation.sample_policy !== PAPER_REGIME_SAMPLE_BUY_POLICY ||
    generation.gate_formula !== REGIME_GATE_POLICY_VERSION ||
    (generation.bundle_id !== PAPER_RESTRICTIVE_REGIME_PROPOSAL &&
      generation.bundle_id !== PAPER_HISTORICAL_REGIME_CONTRACT) ||
    generation.source_kind !== 'prospective-engine-run' ||
    !text(generation.actor, 114) ||
    generation.budget_id !== `${generation.actor as string}:paper` ||
    !text(generation.settings_descriptor, 256)
  )
    return refuse('generation', 'identity');

  const roots = object(snapshot.rootsPresent);
  if (!roots || roots.funding !== true || roots.budget !== true)
    return refuse('root', 'funding-or-budget-root-absent');

  const head = object(snapshot.head);
  if (!head) return refuse('head', 'missing');
  if (!matchesScope(head)) return refuse('head', 'namespace');
  const headRevision = revision(head.revision);
  if (headRevision === undefined || !text(head.latest_event_key)) return refuse('head', 'pointer');

  const event = object(snapshot.event);
  if (!event) return refuse('event', 'missing');
  if (!matchesScope(event)) return refuse('event', 'namespace');
  const eventRevision = revision(event.revision_after);
  if (
    event.event_key !== head.latest_event_key ||
    eventRevision === undefined ||
    eventRevision !== headRevision ||
    event.event_kind !== head.event_kind ||
    event.projected_phase !== head.projected_phase
  )
    return refuse('event', 'head-pointer-disagreement');
  if (
    (event.event_kind !== 'genesis' && event.event_kind !== 'evaluated') ||
    !PHASES.includes(event.projected_phase as RegimeGatePhase) ||
    event.source_kind !== 'prospective-engine-run' ||
    event.evidence_version !== PAPER_REGIME_EVIDENCE_CONTRACT ||
    !text(event.coverage_receipt_id) ||
    !text(event.run_id) ||
    !text(event.latest_intent_id) ||
    !text(event.current_effect_config_intent_id)
  )
    return refuse('event', 'identity');

  const cutoff = decodePaperDbMicroseconds(event.coverage_cutoff_at_us);
  const recorded = decodePaperDbMicroseconds(event.recorded_at_us);
  const observed = decodePaperDbMicroseconds(event.evidence_observed_at_us);
  const observedIso = paperDbTimeToSourceIso(event.evidence_observed_at_us);
  if (cutoff === undefined || recorded === undefined || observed === undefined || !observedIso)
    return refuse('event-clock', 'undecodable');
  // The schema's own ordering, re-checked here rather than trusted from the row.
  if (recorded < observed || recorded < cutoff) return refuse('event-clock', 'ordering');

  const captured = count(event.captured_candidate_count);
  const capturedResolved = count(event.captured_resolved_count);
  const capturedUnresolved = count(event.captured_unresolved_count);
  const inputCount = count(event.input_count);
  if (
    captured === undefined ||
    capturedResolved === undefined ||
    capturedUnresolved === undefined ||
    inputCount === undefined ||
    capturedResolved + capturedUnresolved !== captured ||
    inputCount !== capturedResolved ||
    captured > PAPER_GATE_UNIVERSE_LIMIT
  )
    return refuse('event', 'captured-counts');

  // Lineage is read from the constrained persisted row, never from absence of rows.
  // This establishes the row's shape and its binding, not writer genuineness.
  let lineage: PaperRegimeLineage;
  if (event.event_kind === 'genesis') {
    if (
      eventRevision !== 0n ||
      event.projected_phase !== 'warming' ||
      event.prior_event_key !== null ||
      event.revision_before !== null ||
      event.previous_phase !== null ||
      event.result_phase !== null ||
      captured !== 0 ||
      inputCount !== 0
    )
      return refuse('lineage', 'genesis');
    // A genesis event must be the generation's OWN declared initialization run, not
    // merely some run that wrote a genesis-shaped row. Only genesis is bound this way:
    // a later evaluated event legitimately carries a different write run.
    if (
      !text(generation.initialization_run_id) ||
      generation.initialization_run_id !== event.run_id
    )
      return refuse('lineage', 'genesis-run-binding');
    lineage = {
      kind: 'initialized',
      initializationRunId: event.run_id,
      priorGenerationState: 'none',
      revision: 0,
    };
  } else {
    const before = revision(event.revision_before);
    if (
      before === undefined ||
      eventRevision !== before + 1n ||
      !text(event.prior_event_key) ||
      !PHASES.includes(event.previous_phase as RegimeGatePhase) ||
      event.result_phase !== event.projected_phase ||
      eventRevision > BigInt(Number.MAX_SAFE_INTEGER)
    )
      return refuse('lineage', 'evaluated');
    lineage = { kind: 'persisted', stateRunId: event.run_id, revision: Number(eventRevision) };
  }

  // Independent enumeration. The adapter reads one row past the schema's own ceiling,
  // and the ceiling is applied to the TOTAL rows read before the cutoff filter below.
  // That is a deliberate fail-closed limit, not a query optimisation: a generation
  // holding more candidate rows than the schema's captured counts can describe is
  // refused outright rather than silently truncated, paginated or filtered down to a
  // plausible-looking subset.
  if (!Array.isArray(snapshot.universe)) return refuse('universe-overflow', 'not-enumerated');
  if (snapshot.universe.length > PAPER_GATE_UNIVERSE_LIMIT)
    return refuse('universe-overflow', 'above-schema-ceiling');
  const seen = new Set<string>();
  const inUniverse: { key: string; window: bigint; resolved: boolean }[] = [];
  for (const raw of snapshot.universe) {
    const row = object(raw);
    if (!row) return refuse('universe-drift', 'row-shape');
    const key = row.candidate_key;
    const window = decodePaperDbMicroseconds(row.closes_at_us);
    const created = decodePaperDbMicroseconds(row.created_at_us);
    if (!text(key) || window === undefined || created === undefined)
      return refuse('universe-drift', 'row-values');
    if (seen.has(key)) return refuse('universe-drift', 'duplicate-candidate-key');
    seen.add(key);
    // Candidates created after the receipt's cutoff are outside this receipt's
    // universe by the same rule the row decoder already applies to a cutoff.
    if (created > cutoff) continue;
    const outcomeRecorded =
      row.outcome_recorded_at_us === null
        ? null
        : decodePaperDbMicroseconds(row.outcome_recorded_at_us);
    if (outcomeRecorded === undefined) return refuse('universe-drift', 'outcome-clock');
    inUniverse.push({
      key,
      resolved: outcomeRecorded !== null && outcomeRecorded <= cutoff,
      window,
    });
  }
  inUniverse.sort((left, right) =>
    left.window === right.window
      ? left.key < right.key
        ? -1
        : 1
      : left.window < right.window
        ? -1
        : 1,
  );
  const universeCandidateKeys = inUniverse.map((row) => row.key);
  const resolvedCandidateKeys = inUniverse.filter((row) => row.resolved).map((row) => row.key);
  const unresolvedCandidateKeys = inUniverse.filter((row) => !row.resolved).map((row) => row.key);
  // THE coverage check: the persisted claims must agree with this enumeration.
  if (
    universeCandidateKeys.length !== captured ||
    resolvedCandidateKeys.length !== capturedResolved ||
    unresolvedCandidateKeys.length !== capturedUnresolved
  )
    return refuse('universe-drift', 'captured-counts-disagree');
  let first: string | null = null;
  let last: string | null = null;
  if (inUniverse.length > 0) {
    const firstIso = paperDbTimeToSourceIso(inUniverse[0]!.window.toString());
    const lastIso = paperDbTimeToSourceIso(inUniverse[inUniverse.length - 1]!.window.toString());
    if (firstIso === undefined || lastIso === undefined)
      return refuse('universe-drift', 'window-clock');
    first = firstIso;
    last = lastIso;
  }
  const firstClaim = event.universe_first_closes_at_us;
  const lastClaim = event.universe_last_closes_at_us;
  if (inUniverse.length === 0) {
    if (firstClaim !== null || lastClaim !== null)
      return refuse('universe-drift', 'empty-universe-bounds');
  } else if (
    decodePaperDbMicroseconds(firstClaim) !== inUniverse[0]!.window ||
    decodePaperDbMicroseconds(lastClaim) !== inUniverse[inUniverse.length - 1]!.window
  )
    return refuse('universe-drift', 'universe-bounds-disagree');

  // The persisted input set must be exactly the resolved universe, with contiguous
  // ordinals, so a receipt cannot cite a different or partial input set.
  if (!Array.isArray(snapshot.inputs)) return refuse('input-mismatch', 'not-enumerated');
  if (snapshot.inputs.length !== inputCount) return refuse('input-mismatch', 'count');
  const ordinals = new Set<number>();
  const inputKeys = new Set<string>();
  for (const raw of snapshot.inputs) {
    const row = object(raw);
    if (!row) return refuse('input-mismatch', 'row-shape');
    const ordinal = count(row.ordinal);
    if (!text(row.candidate_key) || ordinal === undefined || ordinal >= inputCount)
      return refuse('input-mismatch', 'row-values');
    if (row.event_key !== event.event_key || !matchesScope(row))
      return refuse('input-mismatch', 'binding');
    if (ordinals.has(ordinal) || inputKeys.has(row.candidate_key))
      return refuse('input-mismatch', 'duplicate');
    ordinals.add(ordinal);
    inputKeys.add(row.candidate_key);
  }
  if (ordinals.size !== inputCount) return refuse('input-mismatch', 'ordinals');
  if (
    inputKeys.size !== resolvedCandidateKeys.length ||
    resolvedCandidateKeys.some((key) => !inputKeys.has(key))
  )
    return refuse('input-mismatch', 'resolved-set-disagree');

  // A malformed newest control row fails closed; the comparison below is a snapshot
  // fact and is NOT treated as current admission or control authority.
  if (snapshot.newestControlIntentValid !== true) return refuse('control-malformed', null);
  if (!text(snapshot.newestControlIntentId)) return refuse('control-malformed', 'newest-id');

  // Final boundary: the lease must still be held, proved by the adapter's locked
  // re-read. Anything else discards the whole result.
  if (snapshot.leaseStillHeld !== true) return refuse('lease-lost', 'final-boundary');

  return {
    kind: 'verified',
    receipt: {
      completeness: 'persisted-universe-in-this-snapshot-only',
      coverageCutoffMicroseconds: cutoff,
      coverageReceiptId: event.coverage_receipt_id,
      evidenceObservedAtIso: observedIso,
      eventKind: event.event_kind,
      fence,
      headEventKey: head.latest_event_key,
      headRevision,
      lineage,
      projectedPhase: event.projected_phase as RegimeGatePhase,
      protocol: PAPER_GATE_COVERAGE_PROTOCOL,
      recordedAtMicroseconds: recorded,
      recordedLatestIntentStillNewest: snapshot.newestControlIntentId === event.latest_intent_id,
      replayCompareAndSet: 'not-proved',
      resolvedCandidateKeys,
      scope,
      universeCandidateKeys,
      universeFirstWindowIso: first,
      universeLastWindowIso: last,
      unresolvedCandidateKeys,
      unresolvedCause: 'unknown',
      validity: 'single-transaction-snapshot-only',
    },
  };
}
// A verified receipt is a read attestation for one snapshot, delivered after that
// transaction ended. It does not create, adopt, reset or initialise a generation, does
// not admit paper entries, does not grant provider or funding authority, does not
// remain true about lease liveness after delivery, and does not prove any future write
// will replay or compare-and-set correctly.
