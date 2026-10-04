// The SELECT-only rule, read back as a specification.
//
// Provider-free by construction: nothing here opens a socket, starts a
// container, or reads a credential. Every observation is a literal, which is the
// point — the hostile cases are the ones a real database would not hand us on
// demand.

import { describe, expect, it } from 'vitest';

import { evaluateProjectionPrivileges } from './projection-privileges.js';

const TABLES = ['money_noodle_public_paper_budget', 'money_noodle_public_paper_executions'];

const calm = {
  bypassRowLevelSecurity: false,
  createDatabase: false,
  createRole: false,
  replication: false,
  superuser: false,
};

const selectOn = (tables: readonly string[]) =>
  tables.map((table) => ({ privilege: 'SELECT', table }));

describe('evaluateProjectionPrivileges', () => {
  it('passes a role with exactly SELECT on every expected table', () => {
    const verdict = evaluateProjectionPrivileges({
      attributes: calm,
      expectedTables: TABLES,
      grants: selectOn(TABLES),
    });

    expect(verdict.selectOnly).toBe(true);
    expect(verdict.violations).toEqual([]);
  });

  it.each(['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'])(
    'refuses a role holding %s on a projection table',
    (privilege) => {
      const verdict = evaluateProjectionPrivileges({
        attributes: calm,
        expectedTables: TABLES,
        grants: [...selectOn(TABLES), { privilege, table: TABLES[0] as string }],
      });

      expect(verdict.selectOnly).toBe(false);
      expect(verdict.violations).toContainEqual({
        code: 'excess-table-privilege',
        detail: `"${TABLES[0]}" grants "${privilege}" beyond SELECT`,
      });
    },
  );

  it('refuses a privilege name it has never heard of rather than assuming it is harmless', () => {
    const verdict = evaluateProjectionPrivileges({
      attributes: calm,
      expectedTables: TABLES,
      grants: [...selectOn(TABLES), { privilege: 'MAINTAIN', table: TABLES[1] as string }],
    });

    expect(verdict.selectOnly).toBe(false);
    expect(verdict.violations.map(({ code }) => code)).toContain('excess-table-privilege');
  });

  it('refuses a table that grants no SELECT at all', () => {
    const verdict = evaluateProjectionPrivileges({
      attributes: calm,
      expectedTables: TABLES,
      grants: selectOn([TABLES[0] as string]),
    });

    expect(verdict.selectOnly).toBe(false);
    expect(verdict.violations).toContainEqual({
      code: 'no-select-privilege',
      detail: `"${TABLES[1]}" grants no SELECT privilege`,
    });
  });

  it.each([
    ['superuser', 'the connected role is a superuser'],
    ['createRole', 'the connected role may create roles'],
    ['createDatabase', 'the connected role may create databases'],
    ['replication', 'the connected role holds replication'],
    ['bypassRowLevelSecurity', 'the connected role bypasses row-level security'],
  ] as const)('refuses an otherwise perfect role that holds %s', (attribute, detail) => {
    const verdict = evaluateProjectionPrivileges({
      attributes: { ...calm, [attribute]: true },
      expectedTables: TABLES,
      grants: selectOn(TABLES),
    });

    expect(verdict.selectOnly).toBe(false);
    expect(verdict.violations).toContainEqual({ code: 'elevated-role-attribute', detail });
  });

  it('ignores grants on tables outside the projection', () => {
    const verdict = evaluateProjectionPrivileges({
      attributes: calm,
      expectedTables: TABLES,
      grants: [...selectOn(TABLES), { privilege: 'INSERT', table: 'some_other_table' }],
    });

    expect(verdict.selectOnly).toBe(true);
  });

  it('accepts the privilege name in the case and spacing a server might report it', () => {
    const verdict = evaluateProjectionPrivileges({
      attributes: calm,
      expectedTables: TABLES,
      grants: TABLES.map((table) => ({ privilege: ' select ', table })),
    });

    expect(verdict.selectOnly).toBe(true);
  });

  it('names no role, host or connection in any violation it produces', () => {
    const verdict = evaluateProjectionPrivileges({
      attributes: { ...calm, superuser: true },
      expectedTables: TABLES,
      grants: [{ privilege: 'DELETE', table: TABLES[0] as string }],
    });

    expect(verdict.selectOnly).toBe(false);
    const text = verdict.violations.map(({ detail }) => detail).join(' ');
    for (const forbidden of ['postgres', 'postgresql://', '@', 'password', 'host', 'neon']) {
      expect(text.toLowerCase()).not.toContain(forbidden);
    }
  });

  it('refuses when nothing was granted at all', () => {
    const verdict = evaluateProjectionPrivileges({
      attributes: calm,
      expectedTables: TABLES,
      grants: [],
    });

    expect(verdict.selectOnly).toBe(false);
    expect(verdict.violations).toHaveLength(TABLES.length);
  });
});
