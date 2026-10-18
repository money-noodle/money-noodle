// Validates the persisted control and funding representations that the pure paper
// authority reducer consumes, and assembles them into a `PaperAuthoritySnapshot`.
//
// Everything that DECIDES lives here; everything that EXECUTES lives in the
// PostgreSQL adapter. The adapter supplies only what PostgreSQL computed — ordering,
// reset barrier, clock validity and conservation are SQL facts, not caller claims and
// not JS `Date` arithmetic — and this module refuses anything it cannot recognise in
// the driver's actual representation.
//
// **Lifetime.** The evidence returned for a successful read is HISTORICAL: it is handed
// back after its transaction has ended, so it attests what the persisted record said
// under a live fence during that one snapshot. It is not live write-admission, not a
// capability, and not a claim that the lease is still held when the caller reads it.
//
// **Bundle availability is never widened here.** The production decision carried in the
// evidence is computed with `evaluatePaperAuthority`'s own default, which is
// `COMPILED_PAPER_BUNDLE_AVAILABLE` — currently `false`, so paper admission refuses
// `bundle-unavailable`. No function in this module or in the adapter accepts an
// audited-bundle override; a test that wants the positive reducer path takes the
// returned `snapshot` and calls the pure reducer itself.

import { CONTROL_ACTIONS, MAX_INTENT_CLOCK_SKEW_MS } from './intent.js';
import {
  evaluatePaperAuthority,
  type PaperAuthorityDecision,
  type PaperAuthorityIntent,
  type PaperAuthoritySnapshot,
} from './paper-authority.js';

export const PAPER_AUTHORITY_EVIDENCE_PROTOCOL = 'paper-authority-persisted-snapshot-evidence-v1';

/** `control_intent.epoch` is a PostgreSQL `integer` with `check (epoch >= 1)`. */
const MAX_EPOCH = 2_147_483_647;

export interface PaperAuthorityScope {
  capability: string;
  epoch: number;
}

export interface PaperAuthorityFence {
  capability: string;
  owner: string;
  fencingToken: bigint;
}

/** The sub-facts behind `funding.conserved`, kept for audit. They are NOT reducer
 * inputs: the reducer sees only the single conjunction, so no individual flag can be
 * read as authority on its own. */
export interface PaperAuthorityFundingFacts {
  /** Exact arbitrary-precision SQL arithmetic over the whole-cent columns. Also a
   * schema CHECK on `paper_budget_root`, so a row that exists satisfies it; computed
   * anyway so the adapter does not depend on that CHECK staying there, and so no money
   * column is ever converted to a JS float. */
  identityHolds: boolean;
  revisionValid: boolean;
  /** Budget root and funding root name the same birth configuration. Also a composite
   * foreign key, with the same caveat as `identityHolds`. */
  birthBound: boolean;
  /** NOT schema-enforced, and 0006 says so in its own comments: the birth-config
   * foreign key establishes that SOME intent exists, never that it is a `configure`
   * with this capability, epoch and actor. 0006 assigns those four facts to the
   * adapter, and this is them. */
  birthIntentBound: boolean;
  /** Whether a funding root for this identity exists at some OTHER epoch. Audit only,
   * never a reducer input: no epoch policy is invented here. */
  otherEpochRootExists: boolean;
  startingCents: string;
  availableCents: string;
  reservedCents: string;
  realizedCents: string;
  correctionCents: string;
  revision: string;
}

export interface PaperAuthorityEvidence {
  protocol: typeof PAPER_AUTHORITY_EVIDENCE_PROTOCOL;
  /** One repeatable-read transaction; nothing here spans two states. */
  validity: 'single-transaction-snapshot-only';
  /** Handed back after commit: evidence of a historical read, never admission. */
  lifetime: 'historical-read-evidence-after-commit';
  /** This read grants no write capability in any transaction. */
  admission: 'none';
  scope: PaperAuthorityScope;
  fence: { capability: string; owner: string; fencingToken: bigint };
  /** Exactly what the pure reducer consumes, with every derived fact computed by
   * PostgreSQL. Exposed so an audit — or a test with a known-audited fixture — can
   * re-run the pure reducer without the adapter offering a bundle override. */
  snapshot: PaperAuthoritySnapshot;
  /** `evaluatePaperAuthority(snapshot)` with its own default availability, which is
   * `COMPILED_PAPER_BUNDLE_AVAILABLE === false`. */
  decisionUnderProductionBundle: PaperAuthorityDecision;
  /** The clock-skew allowance is the existing approved `MAX_INTENT_CLOCK_SKEW_MS`
   * (ADR-0013 §3), applied by PostgreSQL against `clock_timestamp()`. No freshness
   * tolerance is invented here. */
  clockSkewAllowanceMs: typeof MAX_INTENT_CLOCK_SKEW_MS;
  /** Database clock at the read, as exact signed epoch microseconds. */
  observedAtMicroseconds: bigint;
  latestRecordedAtMicroseconds: bigint | undefined;
  configureRecordedAtMicroseconds: bigint | undefined;
  newestResetIntentId: string | undefined;
  fundingFacts: PaperAuthorityFundingFacts | undefined;
}

export type PaperAuthorityReadRefusal = 'scope' | 'lease-not-held' | 'lease-lost';

export type PaperAuthorityReadResult =
  | { kind: 'refused'; reason: PaperAuthorityReadRefusal; detail: string }
  | { kind: 'read'; evidence: PaperAuthorityEvidence };

/** One source of truth for the scope predicate, applied before any statement runs. */
export function paperAuthorityScopeIsValid(scope: PaperAuthorityScope): boolean {
  return (
    typeof scope === 'object' &&
    scope !== null &&
    typeof scope.capability === 'string' &&
    scope.capability.length > 0 &&
    scope.capability.length <= 120 &&
    scope.capability.trim() === scope.capability &&
    typeof scope.epoch === 'number' &&
    Number.isSafeInteger(scope.epoch) &&
    scope.epoch >= 1 &&
    scope.epoch <= MAX_EPOCH
  );
}

export function paperAuthorityFenceIsValid(fence: PaperAuthorityFence): boolean {
  return (
    typeof fence === 'object' &&
    fence !== null &&
    typeof fence.capability === 'string' &&
    fence.capability.length > 0 &&
    typeof fence.owner === 'string' &&
    fence.owner.length > 0 &&
    typeof fence.fencingToken === 'bigint' &&
    fence.fencingToken >= 1n
  );
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/** Exact signed epoch microseconds as extracted by SQL. `null` means the source
 * timestamp was not finite, which the adapter leaves as `null` rather than letting a
 * cast raise. */
const micro = (value: unknown): bigint | undefined => {
  const raw = text(value);
  if (raw === undefined || !/^-?[0-9]{1,25}$/.test(raw)) return undefined;
  return BigInt(raw);
};

const epochFromText = (value: unknown): number | undefined => {
  const raw = text(value);
  if (raw === undefined || !/^[1-9][0-9]{0,9}$/.test(raw)) return undefined;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= MAX_EPOCH ? parsed : undefined;
};

const strictBoolean = (value: unknown): boolean | undefined =>
  value === true ? true : value === false ? false : undefined;

const cents = (value: unknown): string | undefined => {
  const raw = text(value);
  return raw !== undefined && /^-?[0-9]{1,19}$/.test(raw) ? raw : undefined;
};

interface DecodedIntent {
  intent: PaperAuthorityIntent;
  recordedAtMicroseconds: bigint;
  timeValid: boolean;
}

/** Recognises one `control_intent` row in the driver's actual representation. A row
 * that cannot be recognised yields `undefined`, which the caller turns into an
 * incomplete snapshot rather than a guess. `parameters` is passed through untouched:
 * recognising a row is never recognising its configuration. */
function decodeIntentRow(
  row: Record<string, unknown> | null,
  capability: string,
): DecodedIntent | undefined {
  if (row === null) return undefined;
  const id = text(row.id);
  const actor = text(row.actor);
  const rowCapability = text(row.capability);
  const action = text(row.action);
  // `epoch_text`: the adapter must not name this output column `epoch`, because that
  // shadows the table column in its own `order by epoch desc` and orders the
  // authoritative epoch as text.
  const epoch = epochFromText(row.epoch_text);
  const recordedAtMicroseconds = micro(row.recorded_at_us);
  const timeValid = strictBoolean(row.time_valid);
  if (
    id === undefined ||
    actor === undefined ||
    rowCapability !== capability ||
    action === undefined ||
    !CONTROL_ACTIONS.includes(action as never) ||
    epoch === undefined ||
    recordedAtMicroseconds === undefined ||
    timeValid === undefined
  )
    return undefined;
  return {
    intent: {
      action: action as PaperAuthorityIntent['action'],
      actor,
      capability: rowCapability,
      epoch,
      id,
      parameters: row.parameters,
    },
    recordedAtMicroseconds,
    // A non-finite or future-beyond-allowance timestamp is already false here: the
    // comparison was made by PostgreSQL against its own clock.
    timeValid,
  };
}

function decodeFundingFacts(
  row: Record<string, unknown> | null,
): PaperAuthorityFundingFacts | undefined {
  if (row === null) return undefined;
  const identityHolds = strictBoolean(row.identity_holds);
  const revisionValid = strictBoolean(row.revision_valid);
  const birthBound = strictBoolean(row.birth_bound);
  const birthIntentBound = strictBoolean(row.birth_intent_bound);
  const otherEpochRootExists = strictBoolean(row.other_epoch_root_exists);
  const startingCents = cents(row.starting_cents);
  const availableCents = cents(row.available_cents);
  const reservedCents = cents(row.reserved_cents);
  const realizedCents = cents(row.realized_cents);
  const correctionCents = cents(row.correction_cents);
  const revision = cents(row.revision);
  if (
    identityHolds === undefined ||
    revisionValid === undefined ||
    birthBound === undefined ||
    birthIntentBound === undefined ||
    otherEpochRootExists === undefined ||
    startingCents === undefined ||
    availableCents === undefined ||
    reservedCents === undefined ||
    realizedCents === undefined ||
    correctionCents === undefined ||
    revision === undefined
  )
    return undefined;
  return {
    availableCents,
    birthBound,
    birthIntentBound,
    correctionCents,
    identityHolds,
    otherEpochRootExists,
    realizedCents,
    reservedCents,
    revision,
    revisionValid,
    startingCents,
  };
}

/** What the adapter read, before any of it is trusted. */
export interface PaperAuthorityRawReads {
  leaseHeld: boolean;
  leaseStillHeld: boolean;
  observedAtMicroseconds: unknown;
  latest: Record<string, unknown> | null;
  configure: Record<string, unknown> | null;
  /** Ordering facts PostgreSQL computed by row comparison over `(epoch, recorded_at,
   * id)`; `null` when there was no pair to compare. */
  ordering: Record<string, unknown> | null;
  /** The funding and budget root pair, joined on the full primary key; `null` when no
   * such pair exists. Identity is read from the ROWS, never from the configuration. */
  funding: Record<string, unknown> | null;
}

export function buildPaperAuthorityEvidence(
  raw: PaperAuthorityRawReads,
  scope: PaperAuthorityScope,
  fence: PaperAuthorityFence,
): PaperAuthorityReadResult {
  if (!paperAuthorityScopeIsValid(scope))
    return { detail: 'scope', kind: 'refused', reason: 'scope' };
  if (!paperAuthorityFenceIsValid(fence))
    return { detail: 'fence', kind: 'refused', reason: 'scope' };
  if (scope.capability !== fence.capability)
    return { detail: 'capability-mismatch', kind: 'refused', reason: 'scope' };
  if (raw.leaseHeld !== true)
    return { detail: 'start-boundary', kind: 'refused', reason: 'lease-not-held' };
  if (raw.leaseStillHeld !== true)
    return { detail: 'final-boundary', kind: 'refused', reason: 'lease-lost' };

  const observedAtMicroseconds = micro(raw.observedAtMicroseconds);
  const latest = decodeIntentRow(raw.latest, fence.capability);
  const configure = decodeIntentRow(raw.configure, fence.capability);
  const fundingFacts = decodeFundingFacts(raw.funding);

  // A row that was present but unrecognisable makes the snapshot INCOMPLETE. It is
  // never dropped so an older well-formed row can take its place: the newest row for a
  // capability is the one that governs, malformed or not.
  const latestWellFormed = raw.latest === null || latest !== undefined;
  const configureWellFormed = raw.configure === null || configure !== undefined;
  const fundingWellFormed = raw.funding === null || fundingFacts !== undefined;

  let configureAtOrBeforeLatest = false;
  let configureAfterReset = false;
  let orderingWellFormed = true;
  let newestResetIntentId: string | undefined;
  if (raw.ordering !== null) {
    const atOrBefore = strictBoolean(raw.ordering.configure_at_or_before_latest);
    const afterReset = strictBoolean(raw.ordering.configure_after_reset);
    newestResetIntentId = text(raw.ordering.newest_reset_id);
    if (atOrBefore === undefined || afterReset === undefined) orderingWellFormed = false;
    else {
      configureAtOrBeforeLatest = atOrBefore;
      configureAfterReset = afterReset;
    }
  } else if (latest !== undefined && configure !== undefined) {
    // Both rows were recognised, so a comparison was owed and did not arrive.
    orderingWellFormed = false;
  }

  const complete =
    observedAtMicroseconds !== undefined &&
    latestWellFormed &&
    configureWellFormed &&
    fundingWellFormed &&
    orderingWellFormed;

  const snapshot: PaperAuthoritySnapshot = {
    complete,
    configure: configure?.intent,
    configureAfterReset,
    configureAtOrBeforeLatest,
    configureTimeValid: configure?.timeValid === true,
    epoch: scope.epoch,
    funding:
      fundingFacts === undefined
        ? undefined
        : {
            budgetId: text(raw.funding?.budget_id) ?? '',
            // Every flag must hold. The reducer sees ONE boolean, so no sub-fact can
            // be mistaken for authority by itself.
            conserved:
              fundingFacts.identityHolds &&
              fundingFacts.revisionValid &&
              fundingFacts.birthBound &&
              fundingFacts.birthIntentBound,
            epoch: epochFromText(raw.funding?.epoch_text) ?? 0,
            id: text(raw.funding?.funding_id) ?? '',
          },
    latest: latest?.intent,
    latestTimeValid: latest?.timeValid === true,
  };

  return {
    evidence: {
      admission: 'none',
      clockSkewAllowanceMs: MAX_INTENT_CLOCK_SKEW_MS,
      configureRecordedAtMicroseconds: configure?.recordedAtMicroseconds,
      decisionUnderProductionBundle: evaluatePaperAuthority(snapshot),
      fence: { capability: fence.capability, owner: fence.owner, fencingToken: fence.fencingToken },
      fundingFacts,
      latestRecordedAtMicroseconds: latest?.recordedAtMicroseconds,
      lifetime: 'historical-read-evidence-after-commit',
      newestResetIntentId,
      observedAtMicroseconds: observedAtMicroseconds ?? 0n,
      protocol: PAPER_AUTHORITY_EVIDENCE_PROTOCOL,
      scope: { capability: scope.capability, epoch: scope.epoch },
      snapshot,
      validity: 'single-transaction-snapshot-only',
    },
    kind: 'read',
  };
}
