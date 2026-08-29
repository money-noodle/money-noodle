import { randomUUID } from 'node:crypto';

import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';

import type { GetPlatformStatus } from '../../application/get-platform-status.js';
import type { ServiceDescriptor } from '../../domain/platform-status.js';
import type {
  PlatformApiContract,
  PlatformStatusResponse,
  ProblemResponse,
} from '../contract/platform-api-contract.js';

const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/u;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/u;

export interface HttpServerDependencies {
  readonly contract: PlatformApiContract;
  readonly generateRequestId?: () => string;
  readonly getPlatformStatus: GetPlatformStatus;
  readonly onTraceContext?: (traceparent: string, requestId: string) => void;
  readonly service: ServiceDescriptor;
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
