// The engine store, as the platform API is allowed to see it.
//
// Two adapters over two connections, mirroring the two roles ADR-0013 §2 defines.
// Neither knows about HTTP, and neither throws a driver error outward: a failure
// becomes this service's own `EngineStoreError`, whose message names no host, no
// role and no statement, so nothing a driver said can reach a response or a log.
//
// Table names are fixed rather than configurable, unlike the projection's. The
// projection is written by a system this API does not own, so its names could
// change under it; the engine schema is created by the migration in this
// repository, so a rename here is a migration and a release together.
//
// One thing deliberately absent: there is no `update`, no `delete` and no way to
// write an outcome row. The control table is append-only and the outcome is the
// job's to append (ADR-0013 §3), so the shape a future edit would need in order
// to make the API apply its own intent simply is not here.

import type {
  ControlRecorderPort,
  EngineReadPort,
  IntentHistoryEntry,
  IntentOutcome,
  IntentOutcomeState,
  IntentRow,
  JobHealth,
} from '../../domain/budget-control.js';
import { isControlAction, INTENT_OUTCOMES } from '../../domain/budget-control.js';
import type { EngineQueryClient, EngineRow } from './engine-query-client.js';

/** The engine schema's control tables, as the migration creates them. */
export const CONTROL_INTENT_TABLE = 'control_intent';
export const CONTROL_OUTCOME_TABLE = 'control_outcome';
export const JOB_RUN_TABLE = 'job_run';

export class EngineStoreError extends Error {
  readonly code: 'engine-unreachable' | 'engine-unexpected-shape';

  constructor(code: 'engine-unreachable' | 'engine-unexpected-shape') {
    // The code is the whole message. Nothing from the driver is carried, because
    // a driver message can contain a host, a role, or the statement text.
    super(code);
    this.code = code;
    this.name = 'EngineStoreError';
  }
}

function text(row: EngineRow, column: string): string {
  const value = row[column];
  if (typeof value !== 'string' || value.length === 0) {
    throw new EngineStoreError('engine-unexpected-shape');
  }
  return value;
}

function nullableText(row: EngineRow, column: string): string | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new EngineStoreError('engine-unexpected-shape');
  return value;
}

function time(row: EngineRow, column: string): Date {
  const value = row[column];
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new EngineStoreError('engine-unexpected-shape');
  }
  return value;
}

function nullableTime(row: EngineRow, column: string): Date | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new EngineStoreError('engine-unexpected-shape');
  }
  return value;
}

function integer(row: EngineRow, column: string): number {
  const value = row[column];
  const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : value;
  if (typeof parsed !== 'number' || !Number.isSafeInteger(parsed)) {
    throw new EngineStoreError('engine-unexpected-shape');
  }
  return parsed;
}

function parameters(row: EngineRow): IntentRow['parameters'] {
  const value = row['parameters'];
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new EngineStoreError('engine-unexpected-shape');
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (
    !entries.every(
      ([, item]) =>
        typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean',
    )
  ) {
    throw new EngineStoreError('engine-unexpected-shape');
  }
  return Object.freeze(Object.fromEntries(entries) as Record<string, string | number | boolean>);
}

function outcomeState(value: string): IntentOutcomeState {
  if (!(INTENT_OUTCOMES as readonly string[]).includes(value)) {
    throw new EngineStoreError('engine-unexpected-shape');
  }
  return value as IntentOutcomeState;
}

function toIntent(row: EngineRow): IntentRow {
  const action = text(row, 'action');
  if (!isControlAction(action)) throw new EngineStoreError('engine-unexpected-shape');
  return Object.freeze({
    action,
    actor: text(row, 'actor'),
    capability: text(row, 'capability'),
    epoch: integer(row, 'epoch'),
    id: text(row, 'id'),
    parameters: parameters(row),
    recordedAt: time(row, 'recorded_at'),
    runId: text(row, 'run_id'),
  });
}

function toOutcome(row: EngineRow): IntentOutcome {
  return Object.freeze({
    appliedAt: time(row, 'applied_at'),
    appliedRunId: text(row, 'applied_run_id'),
    id: text(row, 'id'),
    intentId: text(row, 'intent_id'),
    outcome: outcomeState(text(row, 'outcome')),
    reason: text(row, 'reason'),
  });
}

async function run(
  client: EngineQueryClient,
  statement: string,
  values: readonly unknown[],
): Promise<readonly EngineRow[]> {
  try {
    return await client.query(statement, values);
  } catch (error) {
    // An error this adapter raised about a row's shape keeps its meaning; anything
    // else is the driver's and becomes "unreachable" with nothing carried over.
    if (error instanceof EngineStoreError) throw error;
    throw new EngineStoreError('engine-unreachable');
  }
}

export interface EngineStoreOptions {
  readonly client: EngineQueryClient;
  readonly schema: string;
}

export function createPostgresEngineReader(options: EngineStoreOptions): EngineReadPort {
  const { client, schema } = options;
  return Object.freeze({
    async readIntentHistory(
      capability: string,
      limit: number,
    ): Promise<readonly IntentHistoryEntry[]> {
      // Ordered exactly as ADR-0013 §3 defines "latest": `(epoch, recorded_at, id)`
      // descending, so the first row is the one the staleness rule would pick.
      const intents = await run(
        client,
        `select id, capability, action, actor, epoch, recorded_at, run_id, parameters
           from "${schema}"."${CONTROL_INTENT_TABLE}"
          where capability = $1
          order by epoch desc, recorded_at desc, id desc
          limit $2`,
        [capability, Math.max(1, Math.min(limit, 200))],
      );
      if (intents.length === 0) return Object.freeze([]);

      const ids = intents.map((row) => text(row, 'id'));
      const outcomes = await run(
        client,
        `select id, intent_id, applied_run_id, applied_at, outcome, reason
           from "${schema}"."${CONTROL_OUTCOME_TABLE}"
          where intent_id = any($1)
          order by applied_at desc, id desc`,
        [ids],
      );

      const byIntent = new Map<string, IntentOutcome[]>();
      for (const row of outcomes) {
        const outcome = toOutcome(row);
        const bucket = byIntent.get(outcome.intentId);
        if (bucket === undefined) byIntent.set(outcome.intentId, [outcome]);
        else bucket.push(outcome);
      }

      return Object.freeze(
        intents.map((row) => {
          const intent = toIntent(row);
          return Object.freeze({
            intent,
            outcomes: Object.freeze(byIntent.get(intent.id) ?? []),
          });
        }),
      );
    },

    async readJobHealth(): Promise<readonly JobHealth[]> {
      const rows = await run(
        client,
        `select capability, last_run_id, last_run_at, last_outcome
           from "${schema}"."${JOB_RUN_TABLE}"
          order by capability asc`,
        [],
      );
      return Object.freeze(
        rows.map((row) => {
          const last = nullableText(row, 'last_outcome');
          return Object.freeze({
            capability: text(row, 'capability'),
            lastOutcome: last === null ? null : outcomeState(last),
            lastRunAt: nullableTime(row, 'last_run_at'),
            lastRunId: nullableText(row, 'last_run_id'),
          });
        }),
      );
    },
  });
}

export function createPostgresControlRecorder(options: EngineStoreOptions): ControlRecorderPort {
  const { client, schema } = options;
  return Object.freeze({
    async record(intent: Omit<IntentRow, 'id'>): Promise<{ readonly id: string }> {
      // `returning id` is the only thing this connection reads, and it reads its
      // own insert. The role holds no `SELECT`, so this cannot become a query.
      const rows = await run(
        client,
        `insert into "${schema}"."${CONTROL_INTENT_TABLE}"
           (capability, action, actor, epoch, recorded_at, run_id, parameters)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning id`,
        [
          intent.capability,
          intent.action,
          intent.actor,
          intent.epoch,
          intent.recordedAt,
          intent.runId,
          intent.parameters === null ? null : JSON.stringify(intent.parameters),
        ],
      );
      const first = rows[0];
      if (first === undefined) throw new EngineStoreError('engine-unexpected-shape');
      return Object.freeze({ id: text(first, 'id') });
    },
  });
}
