import { describe, expect, it } from 'vitest';

import {
  AccountStoreError,
  createPostgresBudgetRecordStore,
  createPostgresSessionStore,
} from './postgres-account-store.js';
import type { AccountQueryClient, AccountRow } from './account-query-client.js';

const NOW = new Date('2026-10-06T12:00:00.000Z');
const LATER = new Date('2026-10-06T18:00:00.000Z');

function fakeClient(
  answers: readonly (readonly AccountRow[])[] | (() => never),
): AccountQueryClient & { statements: { text: string; parameters: readonly unknown[] }[] } {
  const statements: { text: string; parameters: readonly unknown[] }[] = [];
  let index = 0;
  return {
    close: async () => {},
    query: async (text: string, parameters: readonly unknown[]) => {
      statements.push({ parameters, text });
      if (typeof answers === 'function') return answers();
      return answers[index++] ?? [];
    },
    statements,
  };
}

const sessionRow = (overrides: Partial<AccountRow> = {}): AccountRow => ({
  account_id: 'account',
  created_at: NOW,
  expires_at: LATER,
  id: 'session-id',
  revoked_at: null,
  ...overrides,
});

describe('the session store', () => {
  it('inserts a session with no revocation time', async () => {
    const client = fakeClient([[]]);
    await createPostgresSessionStore({ client, schema: 'platform' }).create({
      accountId: 'account',
      createdAt: NOW,
      expiresAt: LATER,
      id: 'session-id',
      revokedAt: null,
    });

    const [statement] = client.statements;
    expect(statement?.text).toContain('insert into "platform"."session"');
    expect(statement?.parameters).toEqual(['session-id', 'account', NOW, LATER]);
  });

  it('reads a stored session and reports an unknown one as null', async () => {
    const found = await createPostgresSessionStore({
      client: fakeClient([[sessionRow()]]),
      schema: 'platform',
    }).read('session-id');
    expect(found).toEqual({
      accountId: 'account',
      createdAt: NOW,
      expiresAt: LATER,
      id: 'session-id',
      revokedAt: null,
    });

    expect(
      await createPostgresSessionStore({ client: fakeClient([[]]), schema: 'platform' }).read('x'),
    ).toBeNull();
  });

  it('revokes by setting a time, never by deleting, and keeps the first one', async () => {
    const client = fakeClient([[]]);
    await createPostgresSessionStore({ client, schema: 'platform' }).revoke('session-id', NOW);

    const [statement] = client.statements;
    expect(statement?.text).toContain('set revoked_at = $2');
    // A revoked session stays in the audit, and re-revoking does not rewrite when
    // access was actually withdrawn.
    expect(statement?.text).toContain('revoked_at is null');
    expect(statement?.text).not.toMatch(/\bdelete\b/u);
  });

  it('refuses a row whose shape this API does not understand', async () => {
    for (const row of [
      sessionRow({ id: '' }),
      sessionRow({ created_at: 'yesterday' }),
      sessionRow({ revoked_at: 'sometime' }),
      sessionRow({ expires_at: new Date('not a date') }),
    ]) {
      await expect(
        createPostgresSessionStore({ client: fakeClient([[row]]), schema: 'platform' }).read('x'),
      ).rejects.toBeInstanceOf(AccountStoreError);
    }
  });

  it('turns a driver failure into an unreachable store and carries no message', async () => {
    const client = fakeClient(() => {
      throw new Error('connection to host db.internal.example refused');
    });
    await expect(
      createPostgresSessionStore({ client, schema: 'platform' }).read('x'),
    ).rejects.toMatchObject({
      code: 'account-store-unreachable',
      message: 'account-store-unreachable',
    });
  });
});

describe('the budget record store', () => {
  it('reads the account’s records in a stable order', async () => {
    const client = fakeClient([
      [
        { account_id: 'account', created_at: NOW, id: 'account:live', kind: 'live' },
        { account_id: 'account', created_at: NOW, id: 'account:paper', kind: 'paper' },
      ],
    ]);
    const records = await createPostgresBudgetRecordStore({
      client,
      schema: 'platform',
    }).readBudgets('account');

    expect(records.map((record) => record.kind)).toEqual(['live', 'paper']);
    expect(client.statements[0]?.text).toContain('order by kind asc');
    // Read-only from here. The two rows are the migration's, so no statement in
    // this service could create a third.
    expect(client.statements[0]?.text).not.toMatch(/\binsert\b|\bupdate\b|\bdelete\b/u);
  });

  it('refuses a kind outside the two this platform has', async () => {
    const client = fakeClient([
      [{ account_id: 'account', created_at: NOW, id: 'x', kind: 'shadow' }],
    ]);
    await expect(
      createPostgresBudgetRecordStore({ client, schema: 'platform' }).readBudgets('account'),
    ).rejects.toMatchObject({ code: 'account-store-unexpected-shape' });
  });
});
