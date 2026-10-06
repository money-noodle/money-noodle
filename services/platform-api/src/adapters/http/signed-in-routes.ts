// The signed-in half of the HTTP surface.
//
// Kept out of `create-http-server.ts` because it is a different kind of edge
// work: every route here first establishes who is asking, and the four lines that
// do so must be the same four lines every time. A guard that is written out per
// route is a guard that is eventually forgotten on one, so `guarded` below is the
// only way a handler in this file is registered, and a route that is not guarded
// cannot be expressed.
//
// What does *not* happen here is as deliberate. No route performs an effect: the
// control route appends an intent row and answers 202, and nothing in this file
// calls a job, touches an engine or distinguishes the live budget from the paper
// one (ADR-0013 §3, §4). The difference between the two budgets is one boolean in
// the response, computed in the domain.
//
// Every refusal is a problem document from the contract's existing pattern, and
// every one of them says only which fixed reason it was. No provider message, no
// store message, no session identifier and no token ever appears in a response.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type {
  ControlOutcome,
  ListBudgets,
  ReadBudgetDetail,
  ReadIntentHistory,
  ReadJobHealth,
  RecordBudgetControl,
} from '../../application/manage-budget-control.js';
import type {
  AuthenticateSession,
  RevokeSession,
  SignIn,
} from '../../application/manage-session.js';
import {
  hasExecutionAuthority,
  isBudgetKind,
  isControlAction,
  type BudgetDetail,
  type BudgetKind,
  type BudgetRecord,
  type IntentHistoryEntry,
  type JobHealth,
} from '../../domain/budget-control.js';
import type { ActiveSession, SessionRefusal, SignInRefusal } from '../../domain/identity.js';
import type { PlatformApiContract, ProblemResponse } from '../contract/platform-api-contract.js';
import {
  readSessionCookie,
  serializeClearedSessionCookie,
  serializeSessionCookie,
} from '../identity/session-cookie.js';

/**
 * What a refused session is allowed to say.
 *
 * Five codes, each naming a cause this API is willing to publish. `absent` and
 * the three rejection reasons are kept apart because a client acts differently on
 * them — "sign in" versus "sign in again" — while the three rejections share one
 * code, because telling a caller whether an identifier was unknown, revoked or
 * merely expired is an oracle over the session table.
 */
const SESSION_PROBLEMS: Readonly<Record<SessionRefusal, { code: string; detail: string }>> =
  Object.freeze({
    absent: {
      code: 'MN-SESSION-REQUIRED',
      detail: 'This operation requires a signed-in session.',
    },
    expired: { code: 'MN-SESSION-REJECTED', detail: 'The session is no longer accepted.' },
    revoked: { code: 'MN-SESSION-REJECTED', detail: 'The session is no longer accepted.' },
    'store-unavailable': {
      code: 'MN-SESSION-REJECTED',
      detail: 'The session could not be confirmed.',
    },
    unknown: { code: 'MN-SESSION-REJECTED', detail: 'The session is no longer accepted.' },
  });

const SIGN_IN_PROBLEMS: Readonly<
  Record<SignInRefusal, { code: string; detail: string; status: number }>
> = Object.freeze({
  'invalid-token': {
    code: 'MN-IDENTITY-REJECTED',
    detail: 'The presented identity was not accepted.',
    status: 401,
  },
  'not-configured': {
    code: 'MN-IDENTITY-NOT-CONFIGURED',
    detail: 'This deployment has no identity configuration.',
    status: 503,
  },
  'second-factor-required': {
    code: 'MN-SECOND-FACTOR-REQUIRED',
    detail: 'Sign-in requires a second factor to have been used.',
    status: 401,
  },
  'store-unavailable': {
    code: 'MN-SESSION-STORE-UNAVAILABLE',
    detail: 'The session could not be established.',
    status: 503,
  },
  'unknown-account': {
    code: 'MN-IDENTITY-REJECTED',
    detail: 'The presented identity was not accepted.',
    status: 401,
  },
});

export interface SignedInRouteDependencies {
  readonly authenticateSession: AuthenticateSession;
  readonly contract: PlatformApiContract;
  readonly listBudgets: ListBudgets;
  readonly readBudgetDetail: ReadBudgetDetail;
  readonly readIntentHistory: ReadIntentHistory;
  readonly readJobHealth: ReadJobHealth;
  readonly recordBudgetControl: RecordBudgetControl;
  readonly revokeSession: RevokeSession;
  readonly signIn: SignIn;
  readonly problem: (
    request: FastifyRequest,
    status: number,
    title: string,
    errorCode: string,
    detail?: string,
  ) => ProblemResponse;
  readonly requestIdHeader: (request: FastifyRequest) => { 'x-request-id': string };
}

function budgetPayload(record: BudgetRecord): {
  createdAt: string;
  hasExecutionAuthority: boolean;
  id: string;
  kind: BudgetKind;
} {
  return {
    createdAt: record.createdAt.toISOString(),
    hasExecutionAuthority: hasExecutionAuthority(record.kind),
    id: record.id,
    kind: record.kind,
  };
}

function detailPayload(detail: BudgetDetail): Record<string, unknown> {
  return {
    appliedState: detail.appliedState,
    budget: budgetPayload(detail.record),
    capability: detail.capability,
    desiredState: detail.desiredState,
    epoch: detail.epoch,
    latestIntentAt: detail.latestIntentAt === null ? null : detail.latestIntentAt.toISOString(),
  };
}

function historyPayload(entries: readonly IntentHistoryEntry[]): readonly unknown[] {
  return entries.map((entry) => ({
    intent: {
      action: entry.intent.action,
      actor: entry.intent.actor,
      capability: entry.intent.capability,
      epoch: entry.intent.epoch,
      id: entry.intent.id,
      parameters: entry.intent.parameters,
      recordedAt: entry.intent.recordedAt.toISOString(),
      runId: entry.intent.runId,
    },
    outcomes: entry.outcomes.map((outcome) => ({
      appliedAt: outcome.appliedAt.toISOString(),
      appliedRunId: outcome.appliedRunId,
      id: outcome.id,
      intentId: outcome.intentId,
      outcome: outcome.outcome,
      reason: outcome.reason,
    })),
  }));
}

function jobPayload(jobs: readonly JobHealth[]): readonly unknown[] {
  return jobs.map((job) => ({
    capability: job.capability,
    lastOutcome: job.lastOutcome,
    lastRunAt: job.lastRunAt === null ? null : job.lastRunAt.toISOString(),
    lastRunId: job.lastRunId,
  }));
}

export function registerSignedInRoutes(
  server: FastifyInstance,
  dependencies: SignedInRouteDependencies,
): void {
  // Destructuring `contract` would lose the assertion signatures, so every
  // assertion below is called through `dependencies`.
  const { problem, requestIdHeader } = dependencies;

  const sendProblem = async (
    request: FastifyRequest,
    reply: FastifyReply,
    response: ProblemResponse,
  ): Promise<unknown> => {
    dependencies.contract.assertProblem(response);
    return reply
      .code(response.status)
      .headers(requestIdHeader(request))
      .type('application/problem+json')
      .send(response);
  };

  const sessionProblem = (request: FastifyRequest, refusal: SessionRefusal): ProblemResponse => {
    const { code, detail } = SESSION_PROBLEMS[refusal];
    return problem(request, 401, 'Unauthorized', code, detail);
  };

  /**
   * Register a route that cannot be reached without an accepted session.
   *
   * The handler receives the session rather than the request's cookie, so no
   * handler in this file can read a session identifier, and none of them can
   * forget to check one: there is no path to a handler body that does not pass
   * through here first.
   */
  const guarded = (
    method: 'get' | 'post',
    url: string,
    handler: (
      session: ActiveSession,
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<unknown>,
  ): void => {
    server[method](url, async (request, reply) => {
      const outcome = await dependencies.authenticateSession(
        readSessionCookie(request.headers.cookie),
      );
      if (!outcome.ok) return sendProblem(request, reply, sessionProblem(request, outcome.refusal));
      return handler(outcome.session, request, reply);
    });
  };

  /** Turn a read failure into the same vocabulary the public reads already use. */
  const readProblem = (
    request: FastifyRequest,
    outcome: Extract<ControlOutcome<unknown>, { ok: false }>,
  ): ProblemResponse =>
    outcome.failure === 'unknown-budget'
      ? problem(
          request,
          404,
          'Not Found',
          'MN-BUDGET-NOT-FOUND',
          'No such budget record exists for this account.',
        )
      : outcome.failure === 'not-configured'
        ? problem(
            request,
            503,
            'Service Unavailable',
            'MN-READ-MODEL-UNREACHABLE',
            'The read model could not be reached.',
          )
        : problem(
            request,
            503,
            'Service Unavailable',
            'MN-READ-MODEL-UNREACHABLE',
            'The read model could not be reached.',
          );

  const budgetKind = (request: FastifyRequest): BudgetKind | undefined => {
    const kind = (request.params as { kind?: unknown } | undefined)?.kind;
    return isBudgetKind(kind) ? kind : undefined;
  };

  server.post('/v1/identity/session', async (request, reply) => {
    const body = request.body as { idToken?: unknown } | undefined;
    const token = body?.idToken;
    if (typeof token !== 'string' || token.length === 0 || token.length > 8192) {
      return sendProblem(
        request,
        reply,
        problem(
          request,
          400,
          'Bad Request',
          'MN-REQUEST-INVALID',
          'The request body must carry an identity token.',
        ),
      );
    }

    const outcome = await dependencies.signIn(token);
    if (!outcome.ok) {
      const { code, detail, status } = SIGN_IN_PROBLEMS[outcome.refusal];
      return sendProblem(
        request,
        reply,
        problem(
          request,
          status,
          status === 401 ? 'Unauthorized' : 'Service Unavailable',
          code,
          detail,
        ),
      );
    }

    const response = {
      accountId: outcome.session.accountId,
      expiresAt: outcome.session.expiresAt.toISOString(),
      requestId: request.id,
      schemaVersion: '1' as const,
    };
    dependencies.contract.assertSessionSummary(response);
    return (
      reply
        .code(201)
        .headers(requestIdHeader(request))
        // The identifier leaves in the cookie and nowhere else: it is absent from the
        // body, so it cannot be read by a script, logged by a client, or pasted.
        .header('set-cookie', serializeSessionCookie(outcome.session.id, outcome.session.expiresAt))
        .send(response)
    );
  });

  guarded('get', '/v1/identity/session', async (session, request, reply) => {
    const response = {
      accountId: session.accountId,
      expiresAt: session.expiresAt.toISOString(),
      requestId: request.id,
      schemaVersion: '1' as const,
    };
    dependencies.contract.assertSessionSummary(response);
    return reply.headers(requestIdHeader(request)).send(response);
  });

  // Sign-out is deliberately not `guarded`: an expired or already-revoked session
  // must still be able to clear itself, and bouncing it with a 401 would leave the
  // cookie in place. Presenting nothing at all is still refused, because there is
  // then nothing to revoke.
  server.delete('/v1/identity/session', async (request, reply) => {
    const sessionId = readSessionCookie(request.headers.cookie);
    if (sessionId === undefined) {
      return sendProblem(request, reply, sessionProblem(request, 'absent'));
    }
    await dependencies.revokeSession(sessionId);
    return reply
      .code(204)
      .headers(requestIdHeader(request))
      .header('set-cookie', serializeClearedSessionCookie())
      .send();
  });

  guarded('get', '/v1/budgets', async (session, request, reply) => {
    const outcome = await dependencies.listBudgets(session.accountId);
    if (!outcome.ok) return sendProblem(request, reply, readProblem(request, outcome));

    const response = {
      budgets: outcome.value.map(budgetPayload),
      requestId: request.id,
      schemaVersion: '1' as const,
    };
    dependencies.contract.assertBudgetList(response);
    return reply.headers(requestIdHeader(request)).send(response);
  });

  guarded('get', '/v1/budgets/:kind', async (session, request, reply) => {
    const kind = budgetKind(request);
    if (kind === undefined) {
      return sendProblem(
        request,
        reply,
        readProblem(request, { failure: 'unknown-budget', ok: false }),
      );
    }

    const outcome = await dependencies.readBudgetDetail(session.accountId, kind);
    if (!outcome.ok) return sendProblem(request, reply, readProblem(request, outcome));

    const response = {
      ...detailPayload(outcome.value),
      requestId: request.id,
      schemaVersion: '1' as const,
    };
    dependencies.contract.assertBudgetDetail(response);
    return reply.headers(requestIdHeader(request)).send(response);
  });

  guarded('post', '/v1/budgets/:kind/controls', async (session, request, reply) => {
    const kind = budgetKind(request);
    if (kind === undefined) {
      return sendProblem(
        request,
        reply,
        readProblem(request, { failure: 'unknown-budget', ok: false }),
      );
    }

    const body = request.body as
      { action?: unknown; parameters?: Record<string, unknown> | null } | undefined;
    if (!isControlAction(body?.action)) {
      return sendProblem(
        request,
        reply,
        problem(
          request,
          400,
          'Bad Request',
          'MN-REQUEST-INVALID',
          'The request body must name one of the published control actions.',
        ),
      );
    }

    const outcome = await dependencies.recordBudgetControl({
      accountId: session.accountId,
      action: body.action,
      // The actor is the account the session is bound to. The identity provider's
      // subject is deliberately not used: it is the provider's identifier for a
      // person, and an audit row is a public-ish artefact of this platform.
      actor: session.accountId,
      kind,
      parameters: (body?.parameters ?? null) as Record<string, string | number | boolean> | null,
    });

    if (!outcome.ok) {
      if (outcome.refusal === 'invalid-parameters') {
        return sendProblem(
          request,
          reply,
          problem(
            request,
            400,
            'Bad Request',
            'MN-REQUEST-INVALID',
            'Control parameters must be bounded scalar values.',
          ),
        );
      }
      if (outcome.refusal === 'unknown-budget') {
        return sendProblem(
          request,
          reply,
          readProblem(request, { failure: 'unknown-budget', ok: false }),
        );
      }
      return sendProblem(
        request,
        reply,
        problem(
          request,
          503,
          'Service Unavailable',
          'MN-CONTROL-NOT-RECORDED',
          'The control was not recorded, so nothing was requested of any job.',
        ),
      );
    }

    const response = {
      action: body.action,
      capability: outcome.capability,
      intentId: outcome.intentId,
      // Always true, and always only this: the row exists. Saying so in the body
      // keeps a client from reading 202 as "it happened".
      recorded: true as const,
      requestId: request.id,
      schemaVersion: '1' as const,
    };
    dependencies.contract.assertControlAccepted(response);
    return reply.code(202).headers(requestIdHeader(request)).send(response);
  });

  guarded('get', '/v1/budgets/:kind/intents', async (_session, request, reply) => {
    const kind = budgetKind(request);
    if (kind === undefined) {
      return sendProblem(
        request,
        reply,
        readProblem(request, { failure: 'unknown-budget', ok: false }),
      );
    }

    const outcome = await dependencies.readIntentHistory(kind);
    if (!outcome.ok) return sendProblem(request, reply, readProblem(request, outcome));

    const response = {
      capability: `budget:${kind}`,
      entries: historyPayload(outcome.value),
      requestId: request.id,
      schemaVersion: '1' as const,
    };
    dependencies.contract.assertIntentHistory(response);
    return reply.headers(requestIdHeader(request)).send(response);
  });

  guarded('get', '/v1/engine/jobs', async (_session, request, reply) => {
    const outcome = await dependencies.readJobHealth();
    if (!outcome.ok) return sendProblem(request, reply, readProblem(request, outcome));

    const response = {
      jobs: jobPayload(outcome.value),
      requestId: request.id,
      schemaVersion: '1' as const,
    };
    dependencies.contract.assertJobHealth(response);
    return reply.headers(requestIdHeader(request)).send(response);
  });
}
