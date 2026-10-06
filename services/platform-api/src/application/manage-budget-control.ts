// The signed-in budget surface: record a control, read a budget, read what the
// engine has said about it.
//
// The recording use case is the one that matters, and what matters about it is
// everything it does *not* do. It validates, it appends one intent row, and it
// returns the identity of that row. There is no branch on budget kind, no call to
// a job, no engine connection on the write path, and no state mutated anywhere —
// ADR-0013 §3 makes the row the whole of the effect, and a job reads it at the
// start of its next run.
//
// The reads are ordinary reads through `engine_reader`, with the same
// outcome-not-exception shape the paper dashboard already uses, so a signed-in
// page degrades the same way a public one does.

import {
  capabilityFor,
  deriveBudgetDetail,
  type BudgetDetail,
  type BudgetKind,
  type BudgetRecord,
  type BudgetRecordStore,
  type ControlAction,
  type ControlRecorderPort,
  type EngineReadPort,
  type IntentHistoryEntry,
  type JobHealth,
} from '../domain/budget-control.js';

/** How much intent history a signed-in read returns. Bounded, never "all". */
export const INTENT_HISTORY_LIMIT = 50;

export const CONTROL_REFUSALS = Object.freeze([
  'not-configured',
  'unknown-budget',
  'invalid-parameters',
  'store-unavailable',
] as const);
export type ControlRefusal = (typeof CONTROL_REFUSALS)[number];

export const CONTROL_READ_FAILURES = Object.freeze([
  'not-configured',
  'unknown-budget',
  'unreachable',
] as const);
export type ControlReadFailure = (typeof CONTROL_READ_FAILURES)[number];

export type ControlOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: ControlReadFailure };

export type RecordControlOutcome =
  | { readonly ok: true; readonly intentId: string; readonly capability: string }
  | { readonly ok: false; readonly refusal: ControlRefusal };

export interface BudgetControlDependencies {
  readonly budgets: BudgetRecordStore | null;
  readonly clock: { now(): Date };
  readonly engine: EngineReadPort | null;
  /** Monotonic control epoch for new intent. Supplied by configuration (ADR-0013 §3). */
  readonly epoch: number;
  readonly newRunId: () => string;
  readonly recorder: ControlRecorderPort | null;
}

export interface RecordControlRequest {
  readonly accountId: string;
  readonly action: ControlAction;
  /** The session's account, which is the actor. Never a provider subject. */
  readonly actor: string;
  readonly kind: BudgetKind;
  readonly parameters: Readonly<Record<string, string | number | boolean>> | null;
}

/**
 * Bounds on what a control may carry.
 *
 * Deliberately narrow and structural: a control parameter is a short key with a
 * scalar value, because an intent row is an audit record a person reads, not a
 * document store. Anything richer than this belongs in a schema of its own with
 * its own version, and refusing it now is cheaper than migrating it later.
 */
const PARAMETER_KEY = /^[a-z][a-z0-9_]{0,38}$/u;
const MAX_PARAMETERS = 12;
const MAX_PARAMETER_TEXT = 120;

export function validateParameters(
  parameters: Readonly<Record<string, unknown>> | null,
): parameters is Readonly<Record<string, string | number | boolean>> | null {
  if (parameters === null) return true;
  const entries = Object.entries(parameters);
  if (entries.length > MAX_PARAMETERS) return false;
  return entries.every(([key, value]) => {
    if (!PARAMETER_KEY.test(key)) return false;
    if (typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_PARAMETER_TEXT;
  });
}

export type RecordBudgetControl = (request: RecordControlRequest) => Promise<RecordControlOutcome>;

export function createRecordBudgetControl(
  dependencies: BudgetControlDependencies,
): RecordBudgetControl {
  return async (request: RecordControlRequest): Promise<RecordControlOutcome> => {
    const { budgets, clock, epoch, newRunId, recorder } = dependencies;
    if (recorder === null || budgets === null) return { ok: false, refusal: 'not-configured' };
    if (!validateParameters(request.parameters)) {
      return { ok: false, refusal: 'invalid-parameters' };
    }

    // The budget must exist for this account before intent is recorded against
    // its capability. Recording intent for a capability no record backs would put
    // an unanswerable row in an append-only table.
    let records: readonly BudgetRecord[];
    try {
      records = await budgets.readBudgets(request.accountId);
    } catch {
      return { ok: false, refusal: 'store-unavailable' };
    }
    if (!records.some((record) => record.kind === request.kind)) {
      return { ok: false, refusal: 'unknown-budget' };
    }

    const capability = capabilityFor(request.kind);
    try {
      const { id } = await recorder.record({
        action: request.action,
        actor: request.actor,
        capability,
        epoch,
        parameters: request.parameters,
        recordedAt: clock.now(),
        runId: newRunId(),
      });
      return { capability, intentId: id, ok: true };
    } catch {
      return { ok: false, refusal: 'store-unavailable' };
    }
  };
}

export type ListBudgets = (accountId: string) => Promise<ControlOutcome<readonly BudgetRecord[]>>;

export function createListBudgets(dependencies: BudgetControlDependencies): ListBudgets {
  return async (accountId: string): Promise<ControlOutcome<readonly BudgetRecord[]>> => {
    const { budgets } = dependencies;
    if (budgets === null) return { failure: 'not-configured', ok: false };
    try {
      return { ok: true, value: await budgets.readBudgets(accountId) };
    } catch {
      return { failure: 'unreachable', ok: false };
    }
  };
}

export type ReadBudgetDetail = (
  accountId: string,
  kind: BudgetKind,
) => Promise<ControlOutcome<BudgetDetail>>;

export function createReadBudgetDetail(dependencies: BudgetControlDependencies): ReadBudgetDetail {
  return async (accountId: string, kind: BudgetKind): Promise<ControlOutcome<BudgetDetail>> => {
    const { budgets, engine } = dependencies;
    if (budgets === null || engine === null) return { failure: 'not-configured', ok: false };

    try {
      const records = await budgets.readBudgets(accountId);
      const record = records.find((candidate) => candidate.kind === kind);
      if (record === undefined) return { failure: 'unknown-budget', ok: false };

      const history = await engine.readIntentHistory(capabilityFor(kind), INTENT_HISTORY_LIMIT);
      return { ok: true, value: deriveBudgetDetail(record, history) };
    } catch {
      return { failure: 'unreachable', ok: false };
    }
  };
}

export type ReadIntentHistory = (
  kind: BudgetKind,
) => Promise<ControlOutcome<readonly IntentHistoryEntry[]>>;

export function createReadIntentHistory(
  dependencies: BudgetControlDependencies,
): ReadIntentHistory {
  return async (kind: BudgetKind): Promise<ControlOutcome<readonly IntentHistoryEntry[]>> => {
    const { engine } = dependencies;
    if (engine === null) return { failure: 'not-configured', ok: false };
    try {
      return {
        ok: true,
        value: await engine.readIntentHistory(capabilityFor(kind), INTENT_HISTORY_LIMIT),
      };
    } catch {
      return { failure: 'unreachable', ok: false };
    }
  };
}

export type ReadJobHealth = () => Promise<ControlOutcome<readonly JobHealth[]>>;

export function createReadJobHealth(dependencies: BudgetControlDependencies): ReadJobHealth {
  return async (): Promise<ControlOutcome<readonly JobHealth[]>> => {
    const { engine } = dependencies;
    if (engine === null) return { failure: 'not-configured', ok: false };
    try {
      return { ok: true, value: await engine.readJobHealth() };
    } catch {
      return { failure: 'unreachable', ok: false };
    }
  };
}
