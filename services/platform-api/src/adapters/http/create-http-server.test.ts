import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GetPlatformStatus } from '../../application/get-platform-status.js';
import { createPlatformApiContract } from '../contract/platform-api-contract.js';
import { createHttpServer } from './create-http-server.js';

const contract = createPlatformApiContract(
  readFileSync('services/platform-api/openapi/platform-api.v1.yaml', 'utf8'),
);
const service = { name: 'platform-api' as const, version: 'git-abc1234' };
const observedAt = new Date('2026-08-29T20:00:00.000Z');
const servers: ReturnType<typeof createHttpServer>[] = [];

function createServer(
  overrides: Partial<Parameters<typeof createHttpServer>[0]> = {},
): ReturnType<typeof createHttpServer> {
  const server = createHttpServer({
    contract,
    generateRequestId: () => 'request-123',
    getPlatformStatus: () => ({ asOf: observedAt, service, state: 'available' }),
    service,
    ...overrides,
  });
  servers.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(async (server) => server.close()));
});

describe('createHttpServer', () => {
  it('serves the contract-valid public platform observation with correlation', async () => {
    const response = await createServer().inject({
      headers: {
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
        'x-request-id': 'web-request-123',
      },
      method: 'GET',
      url: '/v1/platform/status',
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['x-request-id']).toBe('web-request-123');
    expect(response.json()).toEqual({
      asOf: observedAt.toISOString(),
      requestId: 'web-request-123',
      schemaVersion: '1',
      service,
      state: 'available',
    });
  });

  it.each([
    ['/health/live', 'live'],
    ['/health/ready', 'ready'],
  ])('serves minimal %s health without topology', async (url, status) => {
    const response = await createServer().inject({ method: 'GET', url });
    const body: unknown = response.json();

    expect(response.statusCode).toBe(200);
    expect(body).toEqual({ service: 'platform-api', status, version: 'git-abc1234' });
    expect(JSON.stringify(body)).not.toMatch(/host|region|project|secret|dependency/i);
  });

  // Readiness now depends on the read-only projection (#209, ADR-0012). Liveness
  // deliberately does not: a database outage must not make the platform restart a
  // process that is answering perfectly well.
  it('serves ready when the readiness check passes', async () => {
    const response = await createServer({
      checkReadiness: async () => ({ ready: true }),
    }).inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      service: 'platform-api',
      status: 'ready',
      version: 'git-abc1234',
    });
  });

  it.each([
    ['reports not ready', async () => ({ ready: false })],
    [
      'throws',
      async () => {
        throw new Error('connect ECONNREFUSED db.example.invalid:5432 as role reader');
      },
    ],
  ])('fails readiness closed when the check %s', async (_label, checkReadiness) => {
    const response = await createServer({
      checkReadiness: checkReadiness as () => Promise<{ ready: boolean }>,
    }).inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.headers['content-type']).toContain('application/problem+json');
    const body = response.json() as Record<string, unknown>;
    expect(body.errorCode).toBe('MN-NOT-READY');
    expect(body.title).toBe('Service Unavailable');

    // Nothing about the dependency, the host, the port or the role may travel.
    const serialised = JSON.stringify(body);
    for (const forbidden of ['ECONNREFUSED', 'db.example.invalid', '5432', 'reader']) {
      expect(serialised).not.toContain(forbidden);
    }
    expect(serialised).not.toMatch(/host|region|project|secret|postgres|role/i);
  });

  it('leaves liveness unaffected while readiness is failing', async () => {
    const server = createServer({ checkReadiness: async () => ({ ready: false }) });

    const live = await server.inject({ method: 'GET', url: '/health/live' });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({
      service: 'platform-api',
      status: 'live',
      version: 'git-abc1234',
    });
  });

  it('consults the readiness check only for readiness', async () => {
    const checkReadiness = vi.fn(async () => ({ ready: true }));
    const server = createServer({ checkReadiness });

    await server.inject({ method: 'GET', url: '/health/live' });
    await server.inject({ method: 'GET', url: '/v1/platform/status' });
    expect(checkReadiness).not.toHaveBeenCalled();

    await server.inject({ method: 'GET', url: '/health/ready' });
    expect(checkReadiness).toHaveBeenCalledTimes(1);
  });

  it('turns an invalid application result into safe RFC 9457 details', async () => {
    const invalidQuery = (() => ({
      asOf: observedAt,
      service,
      state: 'unknown',
    })) as unknown as GetPlatformStatus;
    const response = await createServer({ getPlatformStatus: invalidQuery }).inject({
      method: 'GET',
      url: '/v1/platform/status',
    });

    expect(response.statusCode).toBe(500);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.json()).toEqual({
      errorCode: 'MN-INTERNAL-ERROR',
      instance: '/v1/platform/status',
      requestId: 'request-123',
      status: 500,
      title: 'Internal Server Error',
      type: 'https://errors.noodle.money/mn-internal-error',
    });
    expect(response.body).not.toContain('unknown');
  });

  it('uses safe RFC 9457 details for unknown routes', async () => {
    const response = await createServer().inject({ method: 'GET', url: '/private/topology' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      errorCode: 'MN-ROUTE-NOT-FOUND',
      requestId: 'request-123',
      status: 404,
    });
  });

  it('replaces unsafe incoming request correlation with a bounded generated value', async () => {
    const response = await createServer().inject({
      headers: { 'x-request-id': 'unsafe request identifier' },
      method: 'GET',
      url: '/v1/platform/status',
    });

    expect(response.headers['x-request-id']).toBe('request-123');
    expect(response.json()).toMatchObject({ requestId: 'request-123' });
  });

  it('accepts only valid non-zero W3C trace context at the adapter boundary', async () => {
    const onTraceContext = vi.fn();
    const server = createServer({ onTraceContext });

    await server.inject({
      headers: { traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01' },
      method: 'GET',
      url: '/v1/platform/status',
    });
    await server.inject({
      headers: { traceparent: '00-00000000000000000000000000000000-00f067aa0ba902b7-01' },
      method: 'GET',
      url: '/v1/platform/status',
    });
    await server.inject({
      headers: { traceparent: 'attacker-controlled' },
      method: 'GET',
      url: '/v1/platform/status',
    });

    expect(onTraceContext).toHaveBeenCalledOnce();
    expect(onTraceContext).toHaveBeenCalledWith(
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      'request-123',
    );
  });
});
