// Readiness against a fake projection client.
//
// Provider-free by construction: the port is a literal object, so the hostile
// cases — a probe that throws, a role that is secretly a superuser — are as easy
// to produce as the happy one. That is the whole reason the privilege probe is
// part of the port rather than buried in the adapter.

import { describe, expect, it, vi } from 'vitest';

import type {
  PaperProjectionPort,
  ProjectionPrivilegeObservation,
} from '../domain/paper-projection.js';
import { createCheckProjectionReadiness } from './check-projection-readiness.js';

const TABLES = ['money_noodle_public_paper_budget', 'money_noodle_public_long_shot'];

const calm = {
  bypassRowLevelSecurity: false,
  createDatabase: false,
  createRole: false,
  replication: false,
  superuser: false,
};

/** A port that answers only the privilege probe; readers must not be reached. */
function fakeProjection(
  probePrivileges: () => Promise<ProjectionPrivilegeObservation>,
): PaperProjectionPort {
  const unreachable = () => {
    throw new Error('readiness must not read projection rows');
  };
  return {
    close: async () => undefined,
    probePrivileges,
    readBudget: unreachable,
    readExecutions: unreachable,
    readLongShot: unreachable,
    readPerformance: unreachable,
  } as unknown as PaperProjectionPort;
}

const selectOnly = async (): Promise<ProjectionPrivilegeObservation> => ({
  attributes: calm,
  grants: TABLES.map((table) => ({ privilege: 'SELECT', table })),
});

describe('createCheckProjectionReadiness', () => {
  it('is ready when the projection is reachable and SELECT-only', async () => {
    const check = createCheckProjectionReadiness({
      expectedTables: TABLES,
      projection: fakeProjection(selectOnly),
      readyWithoutProjection: true,
    });

    await expect(check()).resolves.toEqual({ ready: true, state: 'ready', violations: [] });
  });

  it('is not ready when the database is unreachable', async () => {
    const check = createCheckProjectionReadiness({
      expectedTables: TABLES,
      projection: fakeProjection(() => Promise.reject(new Error('whatever the driver said'))),
      readyWithoutProjection: true,
    });

    const verdict = await check();
    expect(verdict).toEqual({ ready: false, state: 'unreachable', violations: [] });
  });

  it('carries nothing from the failure into the verdict', async () => {
    // The driver message here is exactly the kind of string that must not travel.
    const leaky = new Error('connect ECONNREFUSED db.internal.example:5432 as role reader');
    const check = createCheckProjectionReadiness({
      expectedTables: TABLES,
      projection: fakeProjection(() => Promise.reject(leaky)),
      readyWithoutProjection: true,
    });

    const serialised = JSON.stringify(await check());
    for (const forbidden of ['ECONNREFUSED', 'db.internal.example', '5432', 'reader']) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it('is not ready when the role holds more than SELECT', async () => {
    const check = createCheckProjectionReadiness({
      expectedTables: TABLES,
      projection: fakeProjection(async () => ({
        attributes: calm,
        grants: [
          ...TABLES.map((table) => ({ privilege: 'SELECT', table })),
          { privilege: 'UPDATE', table: TABLES[0] as string },
        ],
      })),
      readyWithoutProjection: true,
    });

    const verdict = await check();
    expect(verdict.ready).toBe(false);
    expect(verdict.state).toBe('over-privileged');
    expect(verdict.violations.map(({ code }) => code)).toContain('excess-table-privilege');
  });

  it('is not ready when the role is elevated even with perfect grants', async () => {
    const check = createCheckProjectionReadiness({
      expectedTables: TABLES,
      projection: fakeProjection(async () => ({
        attributes: { ...calm, superuser: true },
        grants: TABLES.map((table) => ({ privilege: 'SELECT', table })),
      })),
      readyWithoutProjection: true,
    });

    const verdict = await check();
    expect(verdict.ready).toBe(false);
    expect(verdict.state).toBe('over-privileged');
  });

  it('judges the configured table names, not the defaults', async () => {
    // A deployment that renames a table must not pass readiness on grants that
    // only cover the default names.
    const check = createCheckProjectionReadiness({
      expectedTables: ['renamed_budget_projection'],
      projection: fakeProjection(selectOnly),
      readyWithoutProjection: true,
    });

    const verdict = await check();
    expect(verdict.ready).toBe(false);
    expect(verdict.violations.map(({ code }) => code)).toEqual(['no-select-privilege']);
  });

  it('never reads a projection row while deciding readiness', async () => {
    const probe = vi.fn(selectOnly);
    const check = createCheckProjectionReadiness({
      expectedTables: TABLES,
      projection: fakeProjection(probe),
      readyWithoutProjection: true,
    });

    await check();
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('reports not-configured, and the caller decides what that means', async () => {
    const permissive = createCheckProjectionReadiness({
      expectedTables: TABLES,
      projection: null,
      readyWithoutProjection: true,
    });
    const strict = createCheckProjectionReadiness({
      expectedTables: TABLES,
      projection: null,
      readyWithoutProjection: false,
    });

    await expect(permissive()).resolves.toMatchObject({ ready: true, state: 'not-configured' });
    await expect(strict()).resolves.toMatchObject({ ready: false, state: 'not-configured' });
  });
});
