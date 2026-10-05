// The three paper-dashboard reads.
//
// One capability, three bounded queries over the read-only projection port
// (ADR-0012). They are in one file because they share the thing worth getting
// right: what happens when the answer is not there.
//
// v1 answered all three failures identically — one 503 with a fixed sentence, so
// "the database is down", "nothing has been published yet" and "the stored record
// is not readable" were indistinguishable to a client, and to whoever was paged.
// Here they are three outcomes:
//
//   * `unreachable`    — the port could not answer. Why stays inside the adapter.
//   * `not-published`  — the port answered, and there is no such record yet.
//   * `invalid`        — there is a record and this API cannot read it. The field
//                        path comes with it; no value from it ever does.
//
// What none of them is: a zero balance, an empty record, or a fabricated number.
// A missing row is reported as missing (v1 open question 8, resolved for #210).
//
// No cache. Each call reads through the port's bounded pool, so a source time in
// a response is the source time of the record just read rather than of one a
// previous caller got. v1 kept a sixty-second in-process cache on two of these
// routes, which meant a serving instance could answer 200 for up to a minute after
// the projection became unreachable, and two instances could disagree. That is the
// one v1 behaviour this slice deliberately does not reproduce.

import {
  PUBLISHED_EXECUTION_LIMIT,
  type PublishedBudget,
  type PublishedPerformance,
  type PublishedPerformanceSummary,
} from '../domain/paper-dashboard.js';
import { projectionFailureCode, type PaperProjectionPort } from '../domain/paper-projection.js';
import { readPaperBudget } from '../domain/read-paper-budget.js';
import {
  readPaperPerformance,
  readPaperPerformanceSummary,
} from '../domain/read-paper-performance.js';
import { RecordShapeError } from '../domain/read-record.js';

export type PaperReadFailure = 'invalid' | 'not-published' | 'unreachable';

export type PaperReadOutcome<T> =
  | { readonly ok: false; readonly detail?: string; readonly failure: PaperReadFailure }
  | { readonly ok: true; readonly value: T };

export interface PaperReadDependencies {
  /**
   * The port, or `null` when this revision has no projection configured.
   *
   * `null` reads as `unreachable` rather than as its own outcome: from a caller's
   * side there is no difference between a projection this revision cannot reach
   * and one it was never given, and inventing a third answer would only invite a
   * client to handle it. Since #210 a revision in that state never becomes ready,
   * so it should not be serving these routes at all.
   */
  readonly projection: PaperProjectionPort | null;
}

const failed = <T>(failure: PaperReadFailure, detail?: string): PaperReadOutcome<T> =>
  Object.freeze(detail === undefined ? { failure, ok: false } : { detail, failure, ok: false });

const succeeded = <T>(value: T): PaperReadOutcome<T> => Object.freeze({ ok: true, value });

/**
 * Classifies anything thrown while reading.
 *
 * A shape error names its path, which is this API's own field vocabulary and safe
 * to publish. A port failure contributes its code and nothing else — the adapter
 * has already reduced whatever the driver said, and re-reading it here would risk
 * carrying a host or a connection string into a response.
 */
function classify<T>(error: unknown): PaperReadOutcome<T> {
  if (error instanceof RecordShapeError) return failed('invalid', error.path);

  const code = projectionFailureCode(error);
  if (code === 'projection-unexpected-shape') return failed('invalid', 'the stored record');
  // Includes anything that is not a port failure at all. An unclassifiable throw is
  // not a reason to claim the record is published and readable.
  return failed('unreachable');
}

export type GetPaperBudget = () => Promise<PaperReadOutcome<PublishedBudget>>;

/**
 * The budget row and the executions recorded beside it.
 *
 * Two reads, deliberately in that order and deliberately not in a transaction,
 * which is what the source does. The executions are read only when a budget row
 * exists, and a failure on either leaves the whole read unavailable: half a budget
 * is not a budget.
 */
export function createGetPaperBudget(dependencies: PaperReadDependencies): GetPaperBudget {
  return async () => {
    const { projection } = dependencies;
    if (projection === null) return failed('unreachable');

    try {
      const budget = await projection.readBudget();
      if (budget === null) return failed('not-published');
      const executions = await projection.readExecutions(PUBLISHED_EXECUTION_LIMIT);
      return succeeded(readPaperBudget(budget, executions));
    } catch (error) {
      return classify(error);
    }
  };
}

export type GetPaperPerformanceSummary = () => Promise<
  PaperReadOutcome<PublishedPerformanceSummary>
>;

export function createGetPaperPerformanceSummary(
  dependencies: PaperReadDependencies,
): GetPaperPerformanceSummary {
  return async () => {
    const { projection } = dependencies;
    if (projection === null) return failed('unreachable');

    try {
      const row = await projection.readPerformance();
      if (row === null) return failed('not-published');
      return succeeded(readPaperPerformanceSummary(row));
    } catch (error) {
      return classify(error);
    }
  };
}

export type GetPaperPerformance = () => Promise<PaperReadOutcome<PublishedPerformance>>;

export function createGetPaperPerformance(
  dependencies: PaperReadDependencies,
): GetPaperPerformance {
  return async () => {
    const { projection } = dependencies;
    if (projection === null) return failed('unreachable');

    try {
      const row = await projection.readPerformance();
      if (row === null) return failed('not-published');
      return succeeded(readPaperPerformance(row));
    } catch (error) {
      return classify(error);
    }
  };
}
