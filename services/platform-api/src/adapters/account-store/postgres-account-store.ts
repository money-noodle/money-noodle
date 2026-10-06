// This service's own schema: sessions, and the account's two budget records.
//
// The session store is the half that makes "revocable server-side" true rather
// than claimed. `revoke` is an `UPDATE` that sets `revoked_at` and nothing else;
// there is no delete, so a revoked session stays in the audit, and there is no
// "extend" or "touch", so a session cannot renew itself on use.
//
// The budget store is read-only from here even though the role can write, for the
// reason the migration exists: "exactly two records, always both" is an invariant
// a `CHECK` and a `UNIQUE` hold and an application cannot. The two rows are
// created by the migration the schema owner runs, so there is no code path in
// this service that could create a third.
//
// Driver errors never travel. Each becomes `AccountStoreError`, whose message is
// its own code, so no host, role or statement can reach a response or a log.

import type { BudgetRecord, BudgetRecordStore } from '../../domain/budget-control.js';
import { isBudgetKind } from '../../domain/budget-control.js';
import type { Session, SessionStore } from '../../domain/identity.js';
import type { AccountQueryClient, AccountRow } from './account-query-client.js';

export const SESSION_TABLE = 'session';
export const BUDGET_TABLE = 'budget';

export class AccountStoreError extends Error {
  readonly code: 'account-store-unreachable' | 'account-store-unexpected-shape';

  constructor(code: 'account-store-unreachable' | 'account-store-unexpected-shape') {
    super(code);
    this.code = code;
    this.name = 'AccountStoreError';
  }
}

function text(row: AccountRow, column: string): string {
  const value = row[column];
  if (typeof value !== 'string' || value.length === 0) {
    throw new AccountStoreError('account-store-unexpected-shape');
  }
  return value;
}

function time(row: AccountRow, column: string): Date {
  const value = row[column];
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new AccountStoreError('account-store-unexpected-shape');
  }
  return value;
}

function nullableTime(row: AccountRow, column: string): Date | null {
  const value = row[column];
  if (value === null || value === undefined) return null;
  return time(row, column);
}

async function run(
  client: AccountQueryClient,
  statement: string,
  values: readonly unknown[],
): Promise<readonly AccountRow[]> {
  try {
    return await client.query(statement, values);
  } catch (error) {
    if (error instanceof AccountStoreError) throw error;
    throw new AccountStoreError('account-store-unreachable');
  }
}

export interface AccountStoreOptions {
  readonly client: AccountQueryClient;
  readonly schema: string;
}

export function createPostgresSessionStore(options: AccountStoreOptions): SessionStore {
  const { client, schema } = options;
  return Object.freeze({
    async create(session: Session): Promise<void> {
      await run(
        client,
        `insert into "${schema}"."${SESSION_TABLE}"
           (id, account_id, created_at, expires_at, revoked_at)
         values ($1, $2, $3, $4, null)`,
        [session.id, session.accountId, session.createdAt, session.expiresAt],
      );
    },

    async read(id: string): Promise<Session | null> {
      const rows = await run(
        client,
        `select id, account_id, created_at, expires_at, revoked_at
           from "${schema}"."${SESSION_TABLE}"
          where id = $1`,
        [id],
      );
      const row = rows[0];
      if (row === undefined) return null;
      return Object.freeze({
        accountId: text(row, 'account_id'),
        createdAt: time(row, 'created_at'),
        expiresAt: time(row, 'expires_at'),
        id: text(row, 'id'),
        revokedAt: nullableTime(row, 'revoked_at'),
      });
    },

    async revoke(id: string, revokedAt: Date): Promise<void> {
      // `is null` keeps the first revocation's time. Re-revoking is a no-op rather
      // than a rewrite of when access was actually withdrawn.
      await run(
        client,
        `update "${schema}"."${SESSION_TABLE}"
            set revoked_at = $2
          where id = $1 and revoked_at is null`,
        [id, revokedAt],
      );
    },
  });
}

export function createPostgresBudgetRecordStore(options: AccountStoreOptions): BudgetRecordStore {
  const { client, schema } = options;
  return Object.freeze({
    async readBudgets(accountId: string): Promise<readonly BudgetRecord[]> {
      const rows = await run(
        client,
        `select id, account_id, kind, created_at
           from "${schema}"."${BUDGET_TABLE}"
          where account_id = $1
          order by kind asc`,
        [accountId],
      );
      return Object.freeze(
        rows.map((row) => {
          const kind = text(row, 'kind');
          if (!isBudgetKind(kind)) {
            throw new AccountStoreError('account-store-unexpected-shape');
          }
          return Object.freeze({
            accountId: text(row, 'account_id'),
            createdAt: time(row, 'created_at'),
            id: text(row, 'id'),
            kind,
          });
        }),
      );
    },
  });
}
