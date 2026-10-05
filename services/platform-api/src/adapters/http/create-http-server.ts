import { randomUUID } from 'node:crypto';

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';

import type { GetPlatformStatus } from '../../application/get-platform-status.js';
import type {
  GetPaperBudget,
  GetPaperPerformance,
  GetPaperPerformanceSummary,
  PaperReadFailure,
  PaperReadOutcome,
} from '../../application/read-paper-dashboard.js';
import type { ServiceDescriptor } from '../../domain/platform-status.js';
import type {
  PlatformApiContract,
  PlatformStatusResponse,
  ProblemResponse,
} from '../contract/platform-api-contract.js';
import type { Telemetry } from '../telemetry/create-telemetry.js';
import { registerTelemetryHooks } from '../telemetry/telemetry-hooks.js';

const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

/**
 * What a failed read is allowed to say, and under which code.
 *
 * Three codes rather than v1's one, so a caller can tell "come back later" from
 * "there is nothing to come back for" from "this needs looking at" — and so an
 * alert can too (#210).
 *
 * The wording is chosen as carefully as the status: "read model" names the thing
 * that failed without naming a dependency, a host, a credential or an engine. A
 * public response is the wrong place to disclose the shape of this service's
 * infrastructure, and that rule does not bend for diagnosability.
 */
const READ_FAILURES: Readonly<
  Record<PaperReadFailure, { readonly code: string; readonly detail: string }>
> = Object.freeze({
  invalid: {
    code: 'MN-READ-MODEL-INVALID',
    detail: 'The read model returned a record this API does not understand',
  },
  'not-published': {
    code: 'MN-READ-MODEL-NOT-PUBLISHED',
    detail:
      'The read model has published no such record yet. No empty record was inferred, and no zero balance.',
  },
  unreachable: {
    code: 'MN-READ-MODEL-UNREACHABLE',
    detail: 'The read model could not be reached.',
  },
});

/**
 * Why readiness failed, in the same vocabulary.
 *
 * #209 deliberately said nothing here. That was right while nothing depended on
 * the projection: the only things worth saying would have been a host or a role.
 * Since #210 a revision cannot serve without a working read model, so a failed
 * startup probe is the whole deployment, and "which of the three" is the
 * difference between a cold database, a misgranted credential and a record this
 * API cannot parse. None of these names a host, a credential, an engine or an
 * identity.
 */
const READINESS_DETAILS: Readonly<Record<string, string>> = Object.freeze({
  'not-configured': 'No read model is configured for this revision.',
  'over-privileged': 'The read model grants more than SELECT.',
  unreachable: 'The read model could not be reached.',
  'unexpected-shape': 'The read model returned data this API does not understand.',
});

export interface HttpServerDependencies {
  /**
   * Readiness of the dependencies this revision must have to serve its
   * contract. Absent keeps the pre-#209 behaviour — a process that answers is
   * ready — which is still correct for a composition with no dependencies.
   *
   * Present, it decides `/health/ready` and nothing else. Liveness never
   * consults it: a database outage is not a reason for the platform to restart a
   * process that is working.
   */
  readonly checkReadiness?: () => Promise<{
    readonly ready: boolean;
    /** Which failure it was, for the problem detail. Absent means "do not say". */
    readonly state?: string;
  }>;
  readonly contract: PlatformApiContract;
  readonly generateRequestId?: () => string;
  readonly getPaperBudget: GetPaperBudget;
  readonly getPaperPerformance: GetPaperPerformance;
  readonly getPaperPerformanceSummary: GetPaperPerformanceSummary;
  readonly getPlatformStatus: GetPlatformStatus;
  readonly onTraceContext?: (traceparent: string, requestId: string) => void;
  readonly service: ServiceDescriptor;
  /**
   * Adapter-owned telemetry. Absent leaves the server exactly as it was: the
   * hooks below are the only place telemetry touches the HTTP adapter, and no
   * route handler knows telemetry exists.
   */
  readonly telemetry?: Telemetry;
}

function acceptedTraceparent(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;

  const match = TRACEPARENT_PATTERN.exec(value);
  if (match === null || /^0+$/u.test(match[1] ?? '') || /^0+$/u.test(match[2] ?? '')) {
    return undefined;
  }

  return value;
}

function requestIdHeader(request: FastifyRequest): { 'x-request-id': string } {
  return { 'x-request-id': request.id };
}

function acceptedRequestId(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value) ? value : undefined;
}

function problem(
  request: FastifyRequest,
  status: number,
  title: string,
  errorCode: string,
  detail?: string,
): ProblemResponse {
  return {
    ...(detail === undefined ? {} : { detail }),
    errorCode,
    instance: request.url,
    requestId: request.id,
    status,
    title,
    type: `https://errors.noodle.money/${errorCode.toLowerCase()}`,
  };
}

export function createHttpServer(dependencies: HttpServerDependencies): FastifyInstance {
  const server = Fastify({
    genReqId: (request) =>
      acceptedRequestId(request.headers['x-request-id']) ??
      (dependencies.generateRequestId ?? randomUUID)(),
    logger: false,
  });

  server.addHook('onRequest', async (request) => {
    const traceparent = acceptedTraceparent(request.headers.traceparent);
    if (traceparent !== undefined) {
      dependencies.onTraceContext?.(traceparent, request.id);
    }
  });

  // Registered after the validating hook above, so a rejected trace context is
  // already rejected by the time a span is started from it.
  if (dependencies.telemetry !== undefined) {
    registerTelemetryHooks(server, dependencies.telemetry);
  }

  server.get('/v1/platform/status', async (request, reply) => {
    const observation = dependencies.getPlatformStatus();
    const response: PlatformStatusResponse = {
      asOf: observation.asOf.toISOString(),
      requestId: request.id,
      schemaVersion: '1',
      service: observation.service,
      state: observation.state,
    };

    dependencies.contract.assertPlatformStatus(response);
    return reply.headers(requestIdHeader(request)).send(response);
  });

  // The paper reads. Each is the same four lines of edge work — ask the use case,
  // envelope a success, turn a failure into a problem — which is the point: the
  // decisions live in the application and domain layers where they are testable
  // without a server.
  const readProblem = (
    request: FastifyRequest,
    outcome: Extract<PaperReadOutcome<unknown>, { ok: false }>,
  ): ProblemResponse => {
    const failure = READ_FAILURES[outcome.failure];
    // The path of the field that failed, where there is one. A field path is this
    // API's own vocabulary; the value that was there is the source's and is never
    // repeated.
    const detail =
      outcome.detail === undefined ? failure.detail : `${failure.detail}: ${outcome.detail}.`;
    return problem(request, 503, 'Service Unavailable', failure.code, detail);
  };

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

  server.get('/v1/paper/budget', async (request, reply) => {
    const outcome = await dependencies.getPaperBudget();
    if (!outcome.ok) return sendProblem(request, reply, readProblem(request, outcome));

    const response = { ...outcome.value, requestId: request.id, schemaVersion: '1' as const };
    dependencies.contract.assertPaperBudget(response);
    return reply.headers(requestIdHeader(request)).send(response);
  });

  server.get('/v1/paper/performance/summary', async (request, reply) => {
    const outcome = await dependencies.getPaperPerformanceSummary();
    if (!outcome.ok) return sendProblem(request, reply, readProblem(request, outcome));

    const response = { ...outcome.value, requestId: request.id, schemaVersion: '1' as const };
    dependencies.contract.assertPaperPerformanceSummary(response);
    return reply.headers(requestIdHeader(request)).send(response);
  });

  server.get('/v1/paper/performance', async (request, reply) => {
    const outcome = await dependencies.getPaperPerformance();
    if (!outcome.ok) return sendProblem(request, reply, readProblem(request, outcome));

    const response = { ...outcome.value, requestId: request.id, schemaVersion: '1' as const };
    dependencies.contract.assertPaperPerformance(response);
    return reply.headers(requestIdHeader(request)).send(response);
  });

  server.get('/health/live', async (request, reply) => {
    const response = {
      service: dependencies.service.name,
      status: 'live' as const,
      version: dependencies.service.version,
    };
    dependencies.contract.assertHealth(response);
    return reply.headers(requestIdHeader(request)).send(response);
  });

  server.get('/health/ready', async (request, reply) => {
    // Fails closed. A readiness check that threw is not a readiness check that
    // passed, and a check that threw says nothing about why: whatever it was, it was
    // not reduced to this service's own vocabulary first, so nothing from it travels.
    let ready = true;
    let state: string | undefined;
    if (dependencies.checkReadiness !== undefined) {
      try {
        ({ ready, state } = await dependencies.checkReadiness());
      } catch {
        ready = false;
        state = undefined;
      }
    }

    if (!ready) {
      // The code still names no dependency, host, credential or engine. What is new
      // since #210 is the detail: a revision cannot serve without a working read
      // model, so a failed startup probe is the deployment, and saying which of the
      // four states it was is the difference between a cold database, a misgranted
      // credential and a record this API cannot parse.
      const response = problem(
        request,
        503,
        'Service Unavailable',
        'MN-NOT-READY',
        state === undefined ? undefined : READINESS_DETAILS[state],
      );
      dependencies.contract.assertProblem(response);
      return reply
        .code(503)
        .headers(requestIdHeader(request))
        .type('application/problem+json')
        .send(response);
    }

    const response = {
      service: dependencies.service.name,
      status: 'ready' as const,
      version: dependencies.service.version,
    };
    dependencies.contract.assertHealth(response);
    return reply.headers(requestIdHeader(request)).send(response);
  });

  server.setNotFoundHandler(async (request, reply) => {
    const response = problem(request, 404, 'Not Found', 'MN-ROUTE-NOT-FOUND');
    dependencies.contract.assertProblem(response);
    return reply
      .code(404)
      .headers(requestIdHeader(request))
      .type('application/problem+json')
      .send(response);
  });

  server.setErrorHandler(async (_error, request, reply) => {
    const response = problem(request, 500, 'Internal Server Error', 'MN-INTERNAL-ERROR');
    dependencies.contract.assertProblem(response);
    return reply
      .code(500)
      .headers(requestIdHeader(request))
      .type('application/problem+json')
      .send(response);
  });

  return server;
}
