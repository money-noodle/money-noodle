import 'server-only';
import {
  TASK_CADENCE, configuredReconciliationIntervalMs,
  type TaskCadenceDefinition, type TaskCadenceId, type TaskCadenceStatus,
} from './task-cadence';
import { formatCadence } from './freshness';

interface TaskRunState {
  activeRuns: number;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
}

interface TaskCadenceRuntime { tasks: Partial<Record<TaskCadenceId, TaskRunState>> }
const runtimeKey = Symbol.for('money-noodle.task-cadence');

function runtime(): TaskCadenceRuntime {
  const root = globalThis as typeof globalThis & { [runtimeKey]?: TaskCadenceRuntime };
  root[runtimeKey] ??= { tasks: {} };
  return root[runtimeKey]!;
}

function stateFor(id: TaskCadenceId): TaskRunState {
  return runtime().tasks[id] ??= { activeRuns: 0 };
}

function iso(atMs: number): string {
  return new Date(atMs).toISOString();
}

/** Synchronous, process-local instrumentation. It performs no I/O and is never awaited by a task. */
export function beginTaskCadenceRun(id: TaskCadenceId, startedAtMs = Date.now()): {
  succeed: (completedAtMs?: number) => void;
  fail: (error: unknown, completedAtMs?: number) => void;
} {
  const state = stateFor(id);
  state.activeRuns += 1;
  state.lastStartedAt = iso(startedAtMs);
  let completed = false;

  function finish(error: unknown | undefined, completedAtMs: number): void {
    if (completed) return;
    completed = true;
    const current = stateFor(id);
    current.activeRuns = Math.max(0, current.activeRuns - 1);
    current.lastCompletedAt = iso(completedAtMs);
    if (error === undefined) {
      current.lastSuccessAt = current.lastCompletedAt;
      current.lastError = undefined;
    } else {
      current.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  return {
    succeed: (completedAtMs = Date.now()) => finish(undefined, completedAtMs),
    fail: (error, completedAtMs = Date.now()) => finish(error, completedAtMs),
  };
}

export function recordTaskCadenceSuccess(id: TaskCadenceId, completedAt: string | number = Date.now()): void {
  const atMs = typeof completedAt === 'string' ? Date.parse(completedAt) : completedAt;
  const validAtMs = Number.isFinite(atMs) ? atMs : Date.now();
  const state = stateFor(id);
  state.lastStartedAt = iso(validAtMs);
  state.lastCompletedAt = iso(validAtMs);
  state.lastSuccessAt = iso(validAtMs);
  state.lastError = undefined;
}

function runtimeDefinition(definition: TaskCadenceDefinition, environment: Record<string, string | undefined>): TaskCadenceDefinition {
  if (definition.id !== 'reconciliation') return definition;
  const cadenceMs = configuredReconciliationIntervalMs(environment);
  return {
    ...definition,
    cadenceMs,
    cadenceLabel: `${formatCadence(cadenceMs)} plus startup, manual, and uncertainty events`,
  };
}

export function taskCadenceStatuses(options: {
  stateless?: boolean;
  nowMs?: number;
  environment?: Record<string, string | undefined>;
} = {}): TaskCadenceStatus[] {
  const nowMs = options.nowMs ?? Date.now();
  const environment = options.environment ?? process.env;
  return TASK_CADENCE.map((base) => {
    const definition = runtimeDefinition(base, environment);
    const state = runtime().tasks[definition.id];
    if (options.stateless && definition.workerOnly) return { ...definition, health: 'unavailable' };

    let health: TaskCadenceStatus['health'] = 'idle';
    if (state?.activeRuns) health = 'running';
    else if (state?.lastError) health = 'degraded';
    else if (state?.lastSuccessAt) {
      const lastSuccessMs = Date.parse(state.lastSuccessAt);
      health = definition.staleAfterMs && nowMs - lastSuccessMs > definition.staleAfterMs
        ? 'degraded' : 'healthy';
    }
    return {
      ...definition, health,
      lastStartedAt: state?.lastStartedAt,
      lastCompletedAt: state?.lastCompletedAt,
      lastSuccessAt: state?.lastSuccessAt,
      lastError: state?.lastError,
    };
  });
}

/** Test isolation only; production never clears operational health during a process lifetime. */
export function resetTaskCadenceRuntimeForTests(): void {
  runtime().tasks = {};
}
