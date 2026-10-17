// Unwired retained-history SELECTION, CHRONOLOGY and DECLARED-COVERAGE reconciliation
// over persisted rows a caller already read. No store, SQL, network, receipt, clock or
// economic work happens here: every field decision stays in the qualified row decoder,
// ordering uses the qualified source ISO timestamp codec, and no edge/fee/price
// arithmetic or rounding is performed or replaced.
//
// Selection proves NOTHING about completeness, genuine initialization, generation or
// current authority, funding/genesis origin, or source qualification. The retained
// window list is CALLER evidence: it is never derived from the rows it is checked
// against, and its absence refuses rather than assuming the history is whole. This
// module therefore emits no completeness boolean and no coverage count, and it cannot
// build regime evidence; a `complete: true` snapshot still needs a real coverage
// receipt that remains unimplemented.
//
// Absent outcome keeps the decoder's valid-only semantics: that candidate is retained
// as unresolved with UNKNOWN cause, never as zero-neutral, pending or invalid evidence,
// and never silently dropped.
//
// One settlement window holds at most one candidate. 0006 declares UNIQUE
// (generation_key, sample_policy, closes_at) on the candidate table and a scope pins
// both of those columns, so a scoped read cannot contain two distinct candidates for one
// window. Such input is refused as a contradiction instead of being resolved into a
// winner: picking one would synthesise a first-qualified source fact the rows and the
// schema do not contain, and would make the emitted chronology depend on the caller's
// read order. The refusal covers unresolved candidates as well as resolved ones.
//
// Display-id acceptance is the row decoder's JS raw-length/trim subset of the SQL
// candidate_id domain, not a universal lossless SQL domain claim; a stored id outside
// that subset is refused by the decoder rather than narrowed here.
//
// The DB cutoff (exact signed epoch microseconds) and the source observed instant
// (exact source ISO) are separate explicit inputs. Neither is derived from the other:
// the cutoff bounds persisted record clocks inside the decoder, while the observed
// instant bounds source resolution times of SELECTED samples only.
import {
  decodePaperGateSampleRows,
  paperGateRowScopeIsValid,
  type PaperGateRowResult,
  type PaperGateRowScope,
} from './paper-gate-row-codec.js';
import {
  decodePaperDbMicroseconds,
  paperDbTimeToSourceIso,
  paperSourceIsoToDbMicroseconds,
} from './paper-time-codec.js';
import type { RegimeGateObservation } from './paper-regime.js';

export const PAPER_GATE_RETENTION_CONTRACT = 'paper-gate-declared-resolved-window-retention-v1';

/** Explicit caller-declared retained coverage; not proof that the declaration is true. */
export interface PaperGateDeclaredCoverage {
  retention: typeof PAPER_GATE_RETENTION_CONTRACT;
  /** Exact source ISO close instants the caller claims are retained AND resolved. */
  resolvedWindows: readonly string[];
}

export interface PaperGateHistoryEntry {
  candidate: unknown;
  outcome: unknown;
}

export type PaperGateHistoryResult =
  | {
      kind: 'malformed';
      reason:
        | 'entries'
        | 'coverage'
        | 'observed-time'
        | 'cutoff'
        | 'scope'
        | 'row'
        | 'duplicate-candidate-key'
        | 'duplicate-window-candidate'
        | 'duplicate-display-id'
        | 'observed-time-bound'
        | 'coverage-mismatch';
      /** Offending input position, or null when the refusal is not row-specific. */
      rowIndex: number | null;
    }
  | {
      kind: 'unavailable';
      reason: 'declared-resolved-window-missing';
      /** Declared windows with no selected resolved sample, in declared order. */
      missingWindows: readonly string[];
    }
  | {
      kind: 'selected';
      retention: typeof PAPER_GATE_RETENTION_CONTRACT;
      /** Never 'complete': declared coverage is reconciled, never established. */
      completeness: 'declared-not-proved';
      /** Source chronology, ties by original input order, one window at most once. */
      observations: readonly RegimeGateObservation[];
      /** Parallel to `observations`. */
      selectedCandidateKeys: readonly string[];
      /** Always empty, kept for result-shape compatibility. A scoped read cannot
       * contain two distinct candidates for one window (0006 UNIQUE on
       * `(generation_key, sample_policy, closes_at)`), so there is no within-window
       * contest to resolve and no first-qualified source fact is synthesised here. */
      supersededCandidateKeys: readonly string[];
      /** Valid-only absent outcome. */
      unresolvedCandidateKeys: readonly string[];
      unresolvedCause: 'unknown';
      /** Max DB recorded microsecond among SELECTED rows; null when none were selected.
       * NOT a watermark, fence, lease, coverage bound or proof no later row exists. */
      selectedMaxRecordedAtMicroseconds: bigint | null;
    };

/** The regime contract's own observation ceiling; longer input refuses, never truncates. */
const MAX_RETAINED_ROWS = 5000;
const SOURCE_WINDOW_MICROSECONDS = 900_000_000n;
const entryKeys = ['candidate', 'outcome'] as const;
type Decoded = Extract<PaperGateRowResult, { kind: 'decoded' }>;
type Malformed = Extract<PaperGateHistoryResult, { kind: 'malformed' }>;

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === keys.length && keys.every((k) => Object.hasOwn(record, k))
    ? record
    : undefined;
}

/**
 * The candidate row's settlement window as an exact source instant, read with the row
 * decoder's OWN qualified codec (`paperDbTimeToSourceIso`) rather than a second domain.
 * Only ever called on a candidate the decoder has already accepted, so this adds no
 * validation of its own and cannot narrow, widen or round what the decoder admits; it
 * exists solely because the decoder's `unavailable` result does not carry the window.
 */
function closesAtSourceIso(candidate: unknown): string | undefined {
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate))
    return undefined;
  return paperDbTimeToSourceIso((candidate as Record<string, unknown>).closes_at_us);
}

/** Exact source instant that is also an aligned settlement window; no flooring. */
function sourceWindow(value: unknown): bigint | undefined {
  const microseconds = paperSourceIsoToDbMicroseconds(value);
  return microseconds === undefined || microseconds % SOURCE_WINDOW_MICROSECONDS !== 0n
    ? undefined
    : microseconds;
}

/**
 * Orders already-persisted candidate/outcome rows by original source chronology,
 * retains unresolved candidate keys, and reconciles the caller's declared retained
 * coverage. Coverage, cutoff, scope and the source observed instant are all validated
 * before any row is read, so an empty entry list cannot report a bad input as success.
 *
 * A missing declared window is `unavailable` with UNKNOWN cause, not an invented
 * zero sample; a declared window that contradicts the rows is malformed; and two
 * distinct candidates for one window are refused rather than ranked.
 */
export function selectPaperGateRetainedHistory(
  entries: unknown,
  scope: PaperGateRowScope,
  dbCutoffMicroseconds: unknown,
  sourceObservedAtIso: unknown,
  coverage: unknown,
): PaperGateHistoryResult {
  const fail = (reason: Malformed['reason'], rowIndex: number | null): Malformed => ({
    kind: 'malformed',
    reason,
    rowIndex,
  });
  const declared = exact(coverage, ['retention', 'resolvedWindows']);
  if (
    !declared ||
    declared.retention !== PAPER_GATE_RETENTION_CONTRACT ||
    !Array.isArray(declared.resolvedWindows) ||
    declared.resolvedWindows.length > MAX_RETAINED_ROWS
  )
    return fail('coverage', null);
  const declaredWindows = new Set<string>();
  for (const window of declared.resolvedWindows as readonly unknown[]) {
    if (typeof window !== 'string' || sourceWindow(window) === undefined)
      return fail('coverage', null);
    if (declaredWindows.has(window)) return fail('coverage', null);
    declaredWindows.add(window);
  }
  // Source-side guard, deliberately not the DB cutoff and never derived from it.
  const observedAt = paperSourceIsoToDbMicroseconds(sourceObservedAtIso);
  if (observedAt === undefined) return fail('observed-time', null);
  // Cutoff and scope are validated here as well as inside the row decoder, because an
  // empty entry list would otherwise never reach the decoder and an invalid cutoff or
  // scope would be reported as a successful empty selection. Both reuse the decoder's
  // own qualified domain — the exact signed epoch-microsecond codec and the extracted
  // scope predicate — so neither narrows, widens nor rounds what the decoder accepts.
  if (decodePaperDbMicroseconds(dbCutoffMicroseconds) === undefined) return fail('cutoff', null);
  if (!paperGateRowScopeIsValid(scope)) return fail('scope', null);
  if (!Array.isArray(entries) || entries.length > MAX_RETAINED_ROWS) return fail('entries', null);
  const list: readonly unknown[] = entries;
  const candidateKeys = new Set<string>();
  /** Window to the candidate key that occupies it, for the uniqueness refusal below. */
  const windowOwners = new Map<string, string>();
  const resolved: { window: bigint; index: number; row: Decoded }[] = [];
  const unresolvedCandidateKeys: string[] = [];
  for (const [index, entry] of list.entries()) {
    const pair = exact(entry, entryKeys);
    if (!pair) return fail('entries', index);
    const row = decodePaperGateSampleRows(
      pair.candidate,
      pair.outcome,
      scope,
      dbCutoffMicroseconds,
    );
    if (row.kind === 'malformed') return fail('row', index);
    // candidate_key is the persisted primary key: a repeat means the same row twice,
    // and it is checked first so an identical row never reports as a window contest.
    if (candidateKeys.has(row.candidateKey)) return fail('duplicate-candidate-key', index);
    candidateKeys.add(row.candidateKey);
    // Read the window from the already-decoded candidate with the decoder's own
    // qualified codec, so an unresolved row is covered by the uniqueness refusal too.
    const windowIso = closesAtSourceIso(pair.candidate);
    if (windowIso === undefined) return fail('row', index);
    const owner = windowOwners.get(windowIso);
    // 0006 declares UNIQUE (generation_key, sample_policy, closes_at) and this scope
    // pins both of those columns, so two DISTINCT candidates for one window cannot come
    // from a scoped read of that table. Refuse the contradiction rather than invent a
    // winner: choosing one would manufacture a first-qualified source fact that neither
    // the rows nor the schema contain, and would depend on the caller's read order.
    if (owner !== undefined && owner !== row.candidateKey)
      return fail('duplicate-window-candidate', index);
    windowOwners.set(windowIso, row.candidateKey);
    if (row.kind === 'unavailable') {
      unresolvedCandidateKeys.push(row.candidateKey);
      continue;
    }
    if (windowIso !== row.observation.closesAt) return fail('row', index);
    const window = sourceWindow(windowIso);
    if (window === undefined) return fail('row', index);
    resolved.push({ index, row, window });
  }
  // Windows are unique per the refusal above, so this comparator never sees a tie and
  // no caller read order can change the emitted chronology.
  const ordered = [...resolved].sort((left, right) => (left.window < right.window ? -1 : 1));
  const displayIds = new Set<string>();
  const observations: RegimeGateObservation[] = [];
  const selectedCandidateKeys: string[] = [];
  /** Always empty; see the result type. No within-window contest can exist. */
  const supersededCandidateKeys: string[] = [];
  let selectedMaxRecordedAtMicroseconds: bigint | null = null;
  // Every resolved row reaches both guards below. There is no superseded branch that
  // could skip the source observed bound or the display-id uniqueness check.
  for (const item of ordered) {
    const { id, resolvedAt } = item.row.observation;
    const resolvedMicroseconds = paperSourceIsoToDbMicroseconds(resolvedAt);
    if (resolvedMicroseconds === undefined) return fail('row', item.index);
    if (resolvedMicroseconds > observedAt) return fail('observed-time-bound', item.index);
    if (displayIds.has(id)) return fail('duplicate-display-id', item.index);
    displayIds.add(id);
    observations.push(item.row.observation);
    selectedCandidateKeys.push(item.row.candidateKey);
    if (
      selectedMaxRecordedAtMicroseconds === null ||
      item.row.recordedAtMicroseconds > selectedMaxRecordedAtMicroseconds
    )
      selectedMaxRecordedAtMicroseconds = item.row.recordedAtMicroseconds;
  }
  const selectedWindows = new Set(observations.map((observation) => observation.closesAt));
  // A selected window outside the declaration means the declaration is wrong, which is
  // a contradiction rather than a gap; report it before any missing-window gap.
  if (observations.some((observation) => !declaredWindows.has(observation.closesAt)))
    return fail('coverage-mismatch', null);
  const missingWindows = [...declaredWindows].filter((window) => !selectedWindows.has(window));
  if (missingWindows.length > 0)
    return { kind: 'unavailable', missingWindows, reason: 'declared-resolved-window-missing' };
  return {
    completeness: 'declared-not-proved',
    kind: 'selected',
    observations,
    retention: PAPER_GATE_RETENTION_CONTRACT,
    selectedCandidateKeys,
    selectedMaxRecordedAtMicroseconds,
    supersededCandidateKeys,
    unresolvedCandidateKeys,
    unresolvedCause: 'unknown',
  };
}
// An empty declaration with no rows returns an empty selection. That is NOT warming,
// an initialized generation, a disabled gate or proof that no history exists.
