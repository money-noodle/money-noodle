// The two budgets, and the only way anything is asked to change about them.
//
// ADR-0013 §4 fixes the shape: one account holds exactly two budget records,
// `paper` and `live`, with the same schema and the same controls. The difference
// between them is authority, not structure, so this file has no `if (live)`
// anywhere in it — the kind is data. What makes `live` inert is that nothing
// downstream of an intent row is wired to it, which is asserted by a test over
// the repository rather than by a branch here that a later edit could delete.
//
// ADR-0013 §3 fixes what a control *is*: a durable row that a job reads at the
// start of its next run. The API records intent and performs no effect, so there
// is no "apply" use case in this service and no code path from a request to an
// engine. An outcome row is appended by the job that acted, which is why
// `IntentOutcome` is modelled here as something read rather than written.

/** The two budget records an account holds. Exactly these, always both. */
export const BUDGET_KINDS = Object.freeze(['paper', 'live'] as const);
export type BudgetKind = (typeof BUDGET_KINDS)[number];

export function isBudgetKind(value: unknown): value is BudgetKind {
  return typeof value === 'string' && (BUDGET_KINDS as readonly string[]).includes(value);
}

/**
 * The controls, identical for both budgets.
 *
 * `provider-enable` is in the list because ADR-0013 §4 puts it there, and
 * recording it is all this platform does with it: there is no provider to enable
 * in M4, and an intent row asking for one is a durable request that no job will
 * act on until a funded-authority design exists. Recording a control the
 * platform cannot perform is better than refusing to record it, because the
 * refusal would not be audited.
 */
export const CONTROL_ACTIONS = Object.freeze([
  'configure',
  'pause',
  'resume',
  'reset',
  'provider-enable',
] as const);
export type ControlAction = (typeof CONTROL_ACTIONS)[number];

export function isControlAction(value: unknown): value is ControlAction {
  return typeof value === 'string' && (CONTROL_ACTIONS as readonly string[]).includes(value);
}

/**
 * The capability an intent row governs, derived from the budget it was recorded
 * against.
 *
 * ADR-0013 §3 keys intent by capability rather than by budget, because a
 * capability is what a job owns. Deriving the name here keeps the mapping in one
 * place and keeps it total: every budget kind has a capability, so no control can
 * be recorded against a capability nothing will ever read.
 */
export function capabilityFor(kind: BudgetKind): string {
  return `budget:${kind}`;
}

/**
 * A budget record.
 *
 * Deliberately thin. The record carries its identity and when it came into
 * existence, and nothing about what it is currently doing — the configured
 * limits and the running/paused state are *derived from the latest intent* for
 * its capability rather than stored twice. ADR-0013 §3 makes intent the
 * authority on desired state and the job's outcome row the authority on actual
 * state; a `state` column here would be a third copy to keep in step, and it is
 * exactly the copy that would drift.
 */
export interface BudgetRecord {
  readonly id: string;
  readonly accountId: string;
  readonly kind: BudgetKind;
  readonly createdAt: Date;
}

/** An intent row, as ADR-0013 §3 defines it. */
export interface IntentRow {
  readonly id: string;
  readonly capability: string;
  readonly action: ControlAction;
  /** The principal, agent or workload identity that recorded it. */
  readonly actor: string;
  readonly epoch: number;
  readonly recordedAt: Date;
  readonly runId: string;
  /** Bounded, schema-versioned control parameters. Absent for a bare control. */
  readonly parameters: Readonly<Record<string, string | number | boolean>> | null;
}

/** What a job appended after reading an intent row. */
export const INTENT_OUTCOMES = Object.freeze(['applied', 'refused', 'superseded'] as const);
export type IntentOutcomeState = (typeof INTENT_OUTCOMES)[number];

export interface IntentOutcome {
  readonly id: string;
  readonly intentId: string;
  readonly appliedRunId: string;
  readonly appliedAt: Date;
  readonly outcome: IntentOutcomeState;
  /** A fixed code from the job's own vocabulary. Never provider text. */
  readonly reason: string;
}

/** An intent row with whatever a job has said about it so far. */
export interface IntentHistoryEntry {
  readonly intent: IntentRow;
  readonly outcomes: readonly IntentOutcome[];
}

/**
 * The health of one engine job, as the engine store records it.
 *
 * `lastRunAt` being null is a real and expected answer in M4: no job exists yet
 * (ADR-0013 is a boundary, not an implementation), so the signed-in view shows a
 * job that has never run rather than inventing a healthy one.
 */
export interface JobHealth {
  readonly capability: string;
  readonly lastRunId: string | null;
  readonly lastRunAt: Date | null;
  readonly lastOutcome: IntentOutcomeState | null;
}

/**
 * The derived state of a budget, for the signed-in detail view.
 *
 * `desiredState` comes from the latest `pause`/`resume` intent and is what an
 * operator last asked for; `appliedState` comes from the latest outcome a job
 * appended and is what actually happened. In M4 the second is always `null`,
 * because no job has ever read an intent row — and showing that honestly is the
 * reason the two are separate fields rather than one.
 */
export interface BudgetDetail {
  readonly record: BudgetRecord;
  readonly capability: string;
  readonly desiredState: 'running' | 'paused' | 'unset';
  readonly appliedState: IntentOutcomeState | null;
  readonly epoch: number;
  readonly latestIntentAt: Date | null;
  /** True only for `paper`: `live` has no execution path in M4 (ADR-0013 §4). */
  readonly hasExecutionAuthority: boolean;
}

/**
 * Whether a budget kind is wired to anything that can act.
 *
 * One function, used by the detail view and asserted by the live-inertness test,
 * so "the live budget has no execution authority" is a single statement rather
 * than a convention spread across a page and a handler.
 */
export function hasExecutionAuthority(kind: BudgetKind): boolean {
  return kind === 'paper';
}

/**
 * Reduce an intent history into the derived state of one budget.
 *
 * Ordering is the caller's: the port returns rows newest first, ordered by
 * `(epoch, recorded_at, id)` as ADR-0013 §3 requires, and this function trusts
 * that order rather than re-sorting by a timestamp it did not produce.
 */
export function deriveBudgetDetail(
  record: BudgetRecord,
  history: readonly IntentHistoryEntry[],
): BudgetDetail {
  const capability = capabilityFor(record.kind);
  const latest = history[0];
  const latestPauseOrResume = history.find(
    (entry) => entry.intent.action === 'pause' || entry.intent.action === 'resume',
  );

  return Object.freeze({
    appliedState: latest?.outcomes[0]?.outcome ?? null,
    capability,
    desiredState:
      latestPauseOrResume === undefined
        ? 'unset'
        : latestPauseOrResume.intent.action === 'pause'
          ? 'paused'
          : 'running',
    epoch: latest?.intent.epoch ?? 0,
    hasExecutionAuthority: hasExecutionAuthority(record.kind),
    latestIntentAt: latest?.intent.recordedAt ?? null,
    record,
  });
}

/**
 * Records control intent. `INSERT` and nothing else.
 *
 * The port has one method for the same reason the role behind it has one grant
 * (ADR-0013 §2): the control path cannot read the engine, so there is nothing
 * for it to return beyond the identity of what it appended.
 */
export interface ControlRecorderPort {
  record(intent: Omit<IntentRow, 'id'>): Promise<{ readonly id: string }>;
}

/**
 * The signed-in reads over the engine's control table, as `engine_reader` sees
 * them. `SELECT` and nothing else.
 *
 * The budget records are deliberately *not* here. They are this service's own
 * records in the schema `overview.md` already reserves for it, not engine state,
 * and reading them through the engine's role would mean granting that role
 * something outside the engine schema — which ADR-0013 §2 forbids in as many
 * words.
 */
export interface EngineReadPort {
  readIntentHistory(capability: string, limit: number): Promise<readonly IntentHistoryEntry[]>;
  readJobHealth(): Promise<readonly JobHealth[]>;
}

/**
 * The account's own budget records, in this service's own schema.
 *
 * Read-only from the API's side even though the role behind it can write: the
 * two records are created by the migration the schema owner runs, because
 * "exactly two budget records, always both" is an invariant a `CHECK` and a
 * `UNIQUE` can hold and an application cannot.
 */
export interface BudgetRecordStore {
  readBudgets(accountId: string): Promise<readonly BudgetRecord[]>;
}
