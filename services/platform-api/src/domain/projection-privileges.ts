// Is this role actually read-only?
//
// ADR-0012 admits a projection the API does not own, on one condition: the role
// it connects as can do nothing but SELECT. That condition is worth only as much
// as the check behind it, so the check is a pure function over what the database
// reported, separate from the adapter that asked. It can therefore be tested
// against hostile observations without a database.
//
// Two rules, both fail-closed:
//
//   * Any privilege other than SELECT on a projection table is a violation, and
//     an unrecognised privilege name is a violation too. A role with INSERT is
//     obviously wrong; a role with a privilege this code has never heard of is
//     not obviously right, and guessing in favour of the role is how a write
//     path arrives unnoticed.
//   * Any elevated role attribute is a violation on its own, because a
//     superuser's grant table says nothing about what it may do.
//
// Violation text names the table and the privilege and never the role, the
// database, the host or the connection. These strings reach logs and a readiness
// summary, both of which are read by people who should not learn credentials
// from them (SECURITY.md).

import type { ObservedRoleAttributes, ObservedTableGrant } from './paper-projection.js';

/** The only privilege a projection reader may hold. */
export const PERMITTED_PRIVILEGE = 'SELECT';

/** A violation, as a stable code plus a sentence safe to print. */
export interface PrivilegeViolation {
  readonly code: PrivilegeViolationCode;
  readonly detail: string;
}

export type PrivilegeViolationCode =
  'elevated-role-attribute' | 'excess-table-privilege' | 'no-select-privilege';

export interface PrivilegeVerdict {
  /** True only when every rule passed. Readiness depends on exactly this. */
  readonly selectOnly: boolean;
  readonly violations: readonly PrivilegeViolation[];
}

const ELEVATED_ATTRIBUTES: readonly (readonly [keyof ObservedRoleAttributes, string])[] =
  Object.freeze([
    ['superuser', 'the connected role is a superuser'],
    ['createRole', 'the connected role may create roles'],
    ['createDatabase', 'the connected role may create databases'],
    ['replication', 'the connected role holds replication'],
    ['bypassRowLevelSecurity', 'the connected role bypasses row-level security'],
  ]);

/**
 * Judges one privilege observation.
 *
 * `expectedTables` is the set the API intends to read. A grant on a table
 * outside that set is not this check's business — the role may legitimately read
 * something else — but every expected table must carry SELECT, or the adapter
 * would fail later at a less obvious moment.
 */
export function evaluateProjectionPrivileges(observation: {
  readonly attributes: ObservedRoleAttributes;
  readonly expectedTables: readonly string[];
  readonly grants: readonly ObservedTableGrant[];
}): PrivilegeVerdict {
  const violations: PrivilegeViolation[] = [];

  for (const [attribute, detail] of ELEVATED_ATTRIBUTES) {
    if (observation.attributes[attribute]) {
      violations.push({ code: 'elevated-role-attribute', detail });
    }
  }

  const expected = new Set(observation.expectedTables);
  const selectable = new Set<string>();

  for (const grant of observation.grants) {
    if (!expected.has(grant.table)) continue;
    // Normalised for comparison only; the message quotes what was reported, so
    // an operator reads the database's own word rather than this code's guess.
    if (grant.privilege.trim().toUpperCase() === PERMITTED_PRIVILEGE) {
      selectable.add(grant.table);
      continue;
    }
    violations.push({
      code: 'excess-table-privilege',
      detail: `"${grant.table}" grants "${grant.privilege}" beyond ${PERMITTED_PRIVILEGE}`,
    });
  }

  for (const table of observation.expectedTables) {
    if (!selectable.has(table)) {
      violations.push({
        code: 'no-select-privilege',
        detail: `"${table}" grants no ${PERMITTED_PRIVILEGE} privilege`,
      });
    }
  }

  return Object.freeze({
    selectOnly: violations.length === 0,
    violations: Object.freeze(violations),
  });
}
