export interface ExecutionLedgerMutation<T> {
  working?: T;
  successfulWrites: number;
  writeFailed: boolean;
}

export interface ExecutionLedgerRuntime<T> {
  queue: Promise<void>;
  committed?: T;
  loading?: Promise<T>;
  activeMutation?: ExecutionLedgerMutation<T>;
}

const runtimeKey = Symbol.for('money-noodle.execution-ledger-runtime');
const globals = globalThis as typeof globalThis & { [runtimeKey]?: ExecutionLedgerRuntime<unknown> };

export function getExecutionLedgerRuntime<T>(): ExecutionLedgerRuntime<T> {
  globals[runtimeKey] ??= { queue: Promise.resolve() };
  return globals[runtimeKey] as ExecutionLedgerRuntime<T>;
}

/** One serializer shared by every independently emitted server bundle in this process. */
export function serializeExecutionLedgerOperation<Result>(operation: () => Promise<Result>): Promise<Result> {
  const runtime = getExecutionLedgerRuntime<unknown>();
  const scheduled = runtime.queue.then(operation);
  runtime.queue = scheduled.then(() => undefined, () => undefined);
  return scheduled;
}

/** A barrier over every operation queued before this call. */
export function waitForExecutionLedger(): Promise<void> {
  return serializeExecutionLedgerOperation(async () => undefined);
}
