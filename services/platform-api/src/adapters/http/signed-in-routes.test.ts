// The signed-in surface, through a real server.
//
// These are the assertions that cannot be made one layer down: that an
// unauthenticated request never reaches a handler, that a control answers 202 and
// a recorded row rather than a performed action, and that the response carries a
// cookie with every attribute that makes it safe.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { createHttpServer } from './create-http-server.js';
import { createPlatformApiContract } from '../contract/platform-api-contract.js';
import {
  createListBudgets,
  createReadBudgetDetail,
  createReadIntentHistory,
  createReadJobHealth,
  createRecordBudgetControl,
  type BudgetControlDependencies,
} from '../../application/manage-budget-control.js';
import {
  createAuthenticateSession,
  createRevokeSession,
  createSignIn,
  type SessionDependencies,
} from '../../application/manage-session.js';
import type { BudgetRecord, IntentRow } from '../../domain/budget-control.js';
import type { Session, VerifiedIdentity } from '../../domain/identity.js';
import { SESSION_COOKIE_NAME } from '../identity/session-cookie.js';
import type {
  GetPaperBudget,
  GetPaperPerformance,
  GetPaperPerformanceSummary,
} from '../../application/read-paper-dashboard.js';

const ACCOUNT = 'account-under-test';
const NOW = new Date('2026-10-06T12:00:00.000Z');
const CONTRACT = createPlatformApiContract(
  readFileSync(
    path.join(process.cwd(), 'services/platform-api/openapi/platform-api.v1.yaml'),
    'utf8',
  ),
);

const budget = (kind: 'paper' | 'live'): BudgetRecord => ({
  accountId: ACCOUNT,
  createdAt: NOW,
  id: `${ACCOUNT}:${kind}`,
  kind,
});

const unavailable = async () =>
  ({ failure: 'unreachable', ok: false }) as Awaited<ReturnType<GetPaperBudget>>;

function harness(options: { identity?: VerifiedIdentity | null; recorderFails?: boolean } = {}): {
  appended: Omit<IntentRow, 'id'>[];
  rows: Map<string, Session>;
  server: ReturnType<typeof createHttpServer>;
} {
  const rows = new Map<string, Session>();
  const appended: Omit<IntentRow, 'id'>[] = [];
  let counter = 0;

  const sessionDependencies: SessionDependencies = {
    accountId: ACCOUNT,
    clock: { now: () => new Date() },
    newSessionId: () => `${'s'.repeat(30)}${(counter += 1)}`,
    sessions: {
      create: async (session) => {
        rows.set(session.id, session);
      },
      read: async (id) => rows.get(id) ?? null,
      revoke: async (id, revokedAt) => {
        const existing = rows.get(id);
        if (existing !== undefined) rows.set(id, { ...existing, revokedAt });
      },
    },
    verifier: {
      verify: async () =>
        options.identity === undefined
          ? {
              expiresAt: new Date(Date.now() + 3_600_000),
              secondFactorUsed: true,
              subject: 'provider-subject',
            }
          : options.identity,
    },
  };

  const budgetDependencies: BudgetControlDependencies = {
    budgets: { readBudgets: async () => [budget('paper'), budget('live')] },
    clock: { now: () => NOW },
    engine: {
      readIntentHistory: async () => [],
      readJobHealth: async () => [
        { capability: 'budget:live', lastOutcome: null, lastRunAt: null, lastRunId: null },
      ],
    },
    epoch: 4,
    newRunId: () => 'run-identifier',
    recorder: {
      record: async (intent) => {
        if (options.recorderFails === true) throw new Error('unavailable');
        appended.push(intent);
        return { id: `intent-${appended.length}` };
      },
    },
  };

  const server = createHttpServer({
    contract: CONTRACT,
    getHourlyThresholdMarkets: (async () => {
      throw new Error('not used');
    }) as never,
    getMarketOverview: (async () => {
      throw new Error('not used');
    }) as never,
    getPaperBudget: unavailable as GetPaperBudget,
    getPaperPerformance: unavailable as unknown as GetPaperPerformance,
    getPaperPerformanceSummary: unavailable as unknown as GetPaperPerformanceSummary,
    getPlatformStatus: () => ({
      asOf: NOW,
      service: { name: 'platform-api', version: '1.0.0' },
      state: 'available',
    }),
    service: { name: 'platform-api', version: '1.0.0' },
    signedIn: {
      authenticateSession: createAuthenticateSession(sessionDependencies),
      listBudgets: createListBudgets(budgetDependencies),
      readBudgetDetail: createReadBudgetDetail(budgetDependencies),
      readIntentHistory: createReadIntentHistory(budgetDependencies),
      readJobHealth: createReadJobHealth(budgetDependencies),
      recordBudgetControl: createRecordBudgetControl(budgetDependencies),
      revokeSession: createRevokeSession(sessionDependencies),
      signIn: createSignIn(sessionDependencies),
    },
  });

  return { appended, rows, server };
}

async function signIn(server: ReturnType<typeof createHttpServer>): Promise<string> {
  const response = await server.inject({
    method: 'POST',
    payload: { idToken: 'a-token' },
    url: '/v1/identity/session',
  });
  expect(response.statusCode).toBe(201);
  const cookie = response.headers['set-cookie'];
  const value = Array.isArray(cookie) ? cookie[0] : cookie;
  return (value ?? '').split(';')[0] ?? '';
}

const SIGNED_IN_ROUTES = [
  { method: 'GET' as const, url: '/v1/identity/session' },
  { method: 'GET' as const, url: '/v1/budgets' },
  { method: 'GET' as const, url: '/v1/budgets/paper' },
  { method: 'GET' as const, url: '/v1/budgets/paper/intents' },
  { method: 'GET' as const, url: '/v1/engine/jobs' },
];

describe('sign-in over HTTP', () => {
  it('returns the session in a cookie and never in the body', async () => {
    const { server } = harness();
    const response = await server.inject({
      method: 'POST',
      payload: { idToken: 'a-token' },
      url: '/v1/identity/session',
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as Record<string, unknown>;
    expect(body['accountId']).toBe(ACCOUNT);
    // The identifier is nowhere a script or a log could pick it up.
    expect(JSON.stringify(body)).not.toContain('sssss');

    const cookie = String(response.headers['set-cookie']);
    expect(cookie).toContain(SESSION_COOKIE_NAME);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Strict');
  });

  it('refuses a sign-in without a second factor, and says only that', async () => {
    const { server } = harness({
      identity: {
        expiresAt: new Date(Date.now() + 3_600_000),
        secondFactorUsed: false,
        subject: 'provider-subject',
      },
    });
    const response = await server.inject({
      method: 'POST',
      payload: { idToken: 'a-token' },
      url: '/v1/identity/session',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ errorCode: 'MN-SECOND-FACTOR-REQUIRED' });
    expect(response.headers['set-cookie']).toBeUndefined();
  });

  it('refuses a rejected identity without publishing why it was rejected', async () => {
    const { server } = harness({ identity: null });
    const response = await server.inject({
      method: 'POST',
      payload: { idToken: 'a-token' },
      url: '/v1/identity/session',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ errorCode: 'MN-IDENTITY-REJECTED' });
  });

  it('refuses a request body that carries no token', async () => {
    const { server } = harness();
    for (const payload of [{}, { idToken: '' }, { idToken: 42 }]) {
      const response = await server.inject({
        method: 'POST',
        payload,
        url: '/v1/identity/session',
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ errorCode: 'MN-REQUEST-INVALID' });
    }
  });
});

describe('the session guard', () => {
  it('refuses every signed-in route without a session', async () => {
    const { server } = harness();
    for (const route of SIGNED_IN_ROUTES) {
      const response = await server.inject(route);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ errorCode: 'MN-SESSION-REQUIRED' });
    }

    const control = await server.inject({
      method: 'POST',
      payload: { action: 'pause' },
      url: '/v1/budgets/paper/controls',
    });
    expect(control.statusCode).toBe(401);
  });

  it('refuses a session identifier that was never issued', async () => {
    const { server } = harness();
    const response = await server.inject({
      headers: { cookie: `${SESSION_COOKIE_NAME}=${'z'.repeat(43)}` },
      method: 'GET',
      url: '/v1/budgets',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ errorCode: 'MN-SESSION-REJECTED' });
  });

  it('stops accepting a session the moment it is revoked', async () => {
    const { server } = harness();
    const cookie = await signIn(server);

    expect(
      (await server.inject({ headers: { cookie }, method: 'GET', url: '/v1/budgets' })).statusCode,
    ).toBe(200);

    const signedOut = await server.inject({
      headers: { cookie },
      method: 'DELETE',
      url: '/v1/identity/session',
    });
    expect(signedOut.statusCode).toBe(204);
    expect(String(signedOut.headers['set-cookie'])).toContain('Max-Age=0');

    const after = await server.inject({ headers: { cookie }, method: 'GET', url: '/v1/budgets' });
    expect(after.statusCode).toBe(401);
  });

  it('refuses a sign-out that presents nothing to revoke', async () => {
    const { server } = harness();
    const response = await server.inject({ method: 'DELETE', url: '/v1/identity/session' });
    expect(response.statusCode).toBe(401);
  });
});

describe('the budget surface', () => {
  it('lists exactly two records and marks the live one as having no execution authority', async () => {
    const { server } = harness();
    const cookie = await signIn(server);
    const response = await server.inject({
      headers: { cookie },
      method: 'GET',
      url: '/v1/budgets',
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { budgets: { kind: string; hasExecutionAuthority: boolean }[] };
    expect(body.budgets).toHaveLength(2);
    expect(body.budgets.find((entry) => entry.kind === 'live')?.hasExecutionAuthority).toBe(false);
    expect(body.budgets.find((entry) => entry.kind === 'paper')?.hasExecutionAuthority).toBe(true);
  });

  it('records a control as intent and says so, rather than performing it', async () => {
    const { appended, server } = harness();
    const cookie = await signIn(server);

    const response = await server.inject({
      headers: { cookie },
      method: 'POST',
      payload: { action: 'pause', parameters: { mode: 'observe' } },
      url: '/v1/budgets/paper/controls',
    });

    // 202, not 200: the row exists and nothing has happened.
    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({
      action: 'pause',
      capability: 'budget:paper',
      recorded: true,
    });
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({
      action: 'pause',
      actor: ACCOUNT,
      capability: 'budget:paper',
      epoch: 4,
    });
  });

  it('records a control against the live budget identically, and still performs nothing', async () => {
    const { appended, server } = harness();
    const cookie = await signIn(server);

    const response = await server.inject({
      headers: { cookie },
      method: 'POST',
      payload: { action: 'provider-enable' },
      url: '/v1/budgets/live/controls',
    });

    expect(response.statusCode).toBe(202);
    expect(appended[0]?.capability).toBe('budget:live');
    // Nothing in the response hints at an effect, because there was none: the live
    // budget has no execution path at all (ADR-0013 §4).
    expect(response.json()).toMatchObject({ recorded: true });
  });

  it('refuses an unpublished action and an unpublished budget kind', async () => {
    const { appended, server } = harness();
    const cookie = await signIn(server);

    const badAction = await server.inject({
      headers: { cookie },
      method: 'POST',
      payload: { action: 'arm' },
      url: '/v1/budgets/paper/controls',
    });
    expect(badAction.statusCode).toBe(400);

    const badKind = await server.inject({
      headers: { cookie },
      method: 'POST',
      payload: { action: 'pause' },
      url: '/v1/budgets/shadow/controls',
    });
    expect(badKind.statusCode).toBe(404);

    const badRead = await server.inject({
      headers: { cookie },
      method: 'GET',
      url: '/v1/budgets/shadow',
    });
    expect(badRead.statusCode).toBe(404);

    const badHistory = await server.inject({
      headers: { cookie },
      method: 'GET',
      url: '/v1/budgets/shadow/intents',
    });
    expect(badHistory.statusCode).toBe(404);

    expect(appended).toHaveLength(0);
  });

  it('refuses parameters that are not bounded scalars', async () => {
    const { appended, server } = harness();
    const cookie = await signIn(server);

    const response = await server.inject({
      headers: { cookie },
      method: 'POST',
      payload: { action: 'configure', parameters: { nested: { a: 1 } } },
      url: '/v1/budgets/paper/controls',
    });

    expect(response.statusCode).toBe(400);
    expect(appended).toHaveLength(0);
  });

  it('says the control was not recorded when the store could not take it', async () => {
    const { server } = harness({ recorderFails: true });
    const cookie = await signIn(server);

    const response = await server.inject({
      headers: { cookie },
      method: 'POST',
      payload: { action: 'pause' },
      url: '/v1/budgets/paper/controls',
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ errorCode: 'MN-CONTROL-NOT-RECORDED' });
  });

  it('serves budget detail, intent history and job health', async () => {
    const { server } = harness();
    const cookie = await signIn(server);

    const detail = await server.inject({
      headers: { cookie },
      method: 'GET',
      url: '/v1/budgets/paper',
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ appliedState: null, desiredState: 'unset', epoch: 0 });

    const history = await server.inject({
      headers: { cookie },
      method: 'GET',
      url: '/v1/budgets/paper/intents',
    });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toMatchObject({ capability: 'budget:paper', entries: [] });

    const jobs = await server.inject({
      headers: { cookie },
      method: 'GET',
      url: '/v1/engine/jobs',
    });
    expect(jobs.statusCode).toBe(200);
    expect((jobs.json() as { jobs: unknown[] }).jobs).toHaveLength(1);

    const session = await server.inject({
      headers: { cookie },
      method: 'GET',
      url: '/v1/identity/session',
    });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({ accountId: ACCOUNT });
  });
});

describe('the public surface', () => {
  it('is unchanged by composing identity', async () => {
    // The M3 contract is public and unauthenticated, and adding a signed-in
    // surface must not move it a millimetre (ADR-0013 §4).
    const { server } = harness();
    const status = await server.inject({ method: 'GET', url: '/v1/platform/status' });
    expect(status.statusCode).toBe(200);

    const live = await server.inject({ method: 'GET', url: '/health/live' });
    expect(live.statusCode).toBe(200);
  });
});
