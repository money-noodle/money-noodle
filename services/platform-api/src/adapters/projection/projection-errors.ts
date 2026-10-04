// What a projection failure is allowed to say.
//
// A PostgreSQL driver error is one of the most leak-prone objects in this
// service: depending on the failure it carries the host, the port, the database
// name, the role, the SQL it was running, and sometimes a parameter value. None
// of that may reach a response, a log line, a span, or a job summary
// (SECURITY.md, and the ADR-0012 condition on this port existing at all).
//
// So the adapter never re-throws a driver error and never copies its message.
// Every failure becomes one of these, with a fixed sentence chosen from a closed
// set and a stable code for correlation. The original is dropped on purpose: a
// `cause` chain would travel with the error and defeat the whole point.
//
// The cost is honest and accepted — diagnosing a projection failure means
// reading the provider's own logs rather than this service's. That is the right
// trade when the alternative is a connection string in a public job summary.

export type ProjectionFailureCode =
  | 'projection-privilege-probe-failed'
  | 'projection-query-failed'
  | 'projection-unavailable'
  | 'projection-unexpected-shape';

const SAFE_MESSAGES: Readonly<Record<ProjectionFailureCode, string>> = Object.freeze({
  'projection-privilege-probe-failed': 'The projection privilege probe did not complete.',
  'projection-query-failed': 'A projection read did not complete.',
  'projection-unavailable': 'The projection is not reachable.',
  'projection-unexpected-shape': 'The projection returned a row this API does not understand.',
});

/**
 * A projection failure, safe to print anywhere this service prints.
 *
 * Carries no `cause`, by design. `name` and `code` are stable; `message` is one
 * of the fixed sentences above and never interpolates anything observed.
 */
export class ProjectionFailure extends Error {
  readonly code: ProjectionFailureCode;

  constructor(code: ProjectionFailureCode) {
    super(SAFE_MESSAGES[code]);
    this.name = 'ProjectionFailure';
    this.code = code;
  }
}

/**
 * Runs `work`, converting anything it throws into a safe failure.
 *
 * A `ProjectionFailure` passes through unchanged so a specific code set deeper
 * in the adapter is not flattened into a vaguer one.
 */
export async function withSafeFailure<T>(
  code: ProjectionFailureCode,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ProjectionFailure) throw error;
    throw new ProjectionFailure(code);
  }
}
