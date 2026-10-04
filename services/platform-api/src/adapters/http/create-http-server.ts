import { randomUUID } from 'node:crypto';

import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

import type { GetPlatformStatus } from '../../application/get-platform-status.js';
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
  readonly checkReadiness?: () => Promise<{ readonly ready: boolean }>;
  readonly contract: PlatformApiContract;
  readonly generateRequestId?: () => string;
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
): ProblemResponse {
  return {
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
    // passed, and the reason stays where it was produced: the problem response
    // carries a stable code and no detail, because the things that could be said
    // here are connection strings, hosts and role names (#209, SECURITY.md).
    let ready = true;
    if (dependencies.checkReadiness !== undefined) {
      try {
        ready = (await dependencies.checkReadiness()).ready;
      } catch {
        ready = false;
      }
    }

    if (!ready) {
      // The code deliberately does not name the dependency. Which component is
      // unready is operational detail, and a public probe response is the wrong
      // place to disclose that this service has a database behind it at all.
      const response = problem(request, 503, 'Service Unavailable', 'MN-NOT-READY');
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
