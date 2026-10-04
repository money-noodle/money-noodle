import { describe, expect, it } from 'vitest';

import { ProjectionFailure, withSafeFailure } from './projection-errors.js';

/** The shape of a real driver error, built here so no database is needed. */
const driverError = Object.assign(
  new Error('connection to server at "db.example.invalid" (10.0.0.4), port 5432 failed'),
  {
    code: '28P01',
    routine: 'auth_failed',
    // Drivers really do attach these.
    query: 'select * from money_noodle_public_paper_budget',
    parameters: ['reader-role'],
  },
);

describe('withSafeFailure', () => {
  it('passes a successful result through untouched', async () => {
    await expect(withSafeFailure('projection-query-failed', async () => 7)).resolves.toBe(7);
  });

  it('replaces a driver error with a fixed safe failure', async () => {
    const failure = await withSafeFailure('projection-unavailable', async () => {
      throw driverError;
    }).catch((error: unknown) => error as ProjectionFailure);

    expect(failure).toBeInstanceOf(ProjectionFailure);
    expect(failure.code).toBe('projection-unavailable');
    expect(failure.message).toBe('The projection is not reachable.');
  });

  it('carries no host, port, SQL, parameter or driver code anywhere on the failure', async () => {
    const failure = await withSafeFailure('projection-query-failed', async () => {
      throw driverError;
    }).catch((error: unknown) => error as ProjectionFailure);

    // Everything reachable from the thrown object, including a cause chain.
    const reachable = [
      failure.message,
      failure.name,
      failure.code,
      String(failure.stack),
      JSON.stringify(failure, Object.getOwnPropertyNames(failure)),
    ].join(' ');

    for (const forbidden of [
      'db.example.invalid',
      '10.0.0.4',
      '5432',
      '28P01',
      'auth_failed',
      'reader-role',
      'money_noodle_public_paper_budget',
    ]) {
      expect(reachable).not.toContain(forbidden);
    }
    // A `cause` would travel with the error and defeat the whole point.
    expect((failure as { cause?: unknown }).cause).toBeUndefined();
  });

  it('does not flatten a more specific failure raised deeper in the adapter', async () => {
    const failure = await withSafeFailure('projection-unavailable', async () => {
      throw new ProjectionFailure('projection-unexpected-shape');
    }).catch((error: unknown) => error as ProjectionFailure);

    expect(failure.code).toBe('projection-unexpected-shape');
  });

  it('converts a thrown non-error just as safely', async () => {
    const failure = await withSafeFailure('projection-query-failed', async () => {
      // Structurally not a credential — no userinfo — and still exactly the
      // kind of string that must not survive into an error.
      throw 'postgresql://db.example.invalid/example';
    }).catch((error: unknown) => error as ProjectionFailure);

    expect(failure).toBeInstanceOf(ProjectionFailure);
    expect(`${failure.message} ${String(failure.stack)}`).not.toContain('db.example.invalid');
  });
});
